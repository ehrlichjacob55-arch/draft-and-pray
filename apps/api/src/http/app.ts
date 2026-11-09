import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  MAX_TEAMS,
  acceptInviteRequest,
  createInvitesRequest,
  registerRequest,
  renameTeamRequest,
  type CreateInvitesResponse,
  type InvitePreviewResponse,
  type InviteView,
  type ListInvitesResponse,
  type MeResponse,
  type SeasonResponse,
} from "@dnp/contract";
import {
  acceptInvite,
  bindPendingEmail,
  assertInviteUsable,
  createInvites,
  getInvite,
  getLeague,
  getSeasonMeta,
  getUser,
  getUsers,
  inviteStatus,
  listMemberships,
  listSeasonInvites,
  listSeasonPointers,
  listTeams,
  renameTeam,
  revokeInvite,
  type Dynamo,
  type InviteItem,
} from "@dnp/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { noopCognito, type CognitoAdmin } from "../cognito";
import type { Config } from "../config";
import { authMiddleware, isPublicRoute, type AppEnv, type TokenVerifier } from "./auth";
import { loadSeasonMeta, requireCommissioner, requireMember } from "./authz";
import { errorBody, forbidden, notFound, parseBody, toErrorResponse } from "./errors";
import { inviteUrl, maskEmail, publicOrigin } from "./origin";

export interface AppDeps {
  config: Config;
  db: Dynamo;
  /** Defaults to a no-op (local dev). */
  cognito?: CognitoAdmin;
  /** Test hook: replaces ID-token verification. */
  verifyToken?: TokenVerifier;
  /** Test hook: clock. */
  now?: () => Date;
}

export function createApp({ config, db, cognito = noopCognito, verifyToken, now }: AppDeps) {
  const app = new Hono<AppEnv>().basePath("/api");
  const clock = now ?? (() => new Date());

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      const code =
        err.status === 401 ? "unauthorized" : err.status === 404 ? "not_found" : "bad_request";
      return c.json(errorBody(code, err.message), err.status);
    }
    const { status, body } = toErrorResponse(err);
    if (status >= 500) console.error("Unhandled error", err);
    return c.json(body, status as 400);
  });
  app.notFound((c) => c.json(errorBody("not_found", "Not Found"), 404));

  const auth = authMiddleware(config, verifyToken);
  app.use("*", async (c, next) => {
    if (isPublicRoute(c.req.method, c.req.path)) return next();
    return auth(c, next);
  });

  app.get("/health", async (c) => {
    let dbStatus: "ok" | "error" = "ok";
    try {
      // No item is expected; a successful call proves connectivity and needs no extra IAM beyond GetItem.
      await db.doc.send(
        new GetCommand({ TableName: db.tableName, Key: { pk: "HEALTH", sk: "HEALTH" } }),
      );
    } catch (err) {
      console.error("Health check db error", err);
      dbStatus = "error";
    }
    return c.json(
      { status: "ok", env: config.APP_ENV, db: dbStatus },
      dbStatus === "ok" ? 200 : 503,
    );
  });

  // ---- GET /me ----
  app.get("/me", async (c) => {
    const { sub } = c.get("user");
    const user = await getUser(db, sub);
    if (!user) return c.json({ user: null, leagues: [] } satisfies MeResponse);
    const memberships = await listMemberships(db, sub);
    const leagues = await Promise.all(
      memberships.map(async (m) => {
        const [league, pointers] = await Promise.all([
          getLeague(db, m.leagueId),
          listSeasonPointers(db, m.leagueId),
        ]);
        return {
          leagueId: m.leagueId,
          name: league?.name ?? "",
          role: m.role,
          seasons: pointers.map((p) => ({ seasonId: p.seasonId, year: p.year, status: p.status })),
        };
      }),
    );
    return c.json({
      user: { userId: user.userId, email: user.email, displayName: user.displayName },
      leagues,
    } satisfies MeResponse);
  });

  // ---- GET /seasons/:seasonId ----
  app.get("/seasons/:seasonId", async (c) => {
    const user = c.get("user");
    const meta = await loadSeasonMeta(db, c.req.param("seasonId"));
    const [member, league, teams] = await Promise.all([
      requireMember(db, meta.leagueId, user),
      getLeague(db, meta.leagueId),
      listTeams(db, meta.seasonId),
    ]);
    const users = await getUsers(
      db,
      teams.flatMap((t) => (t.managerUserId ? [t.managerUserId] : [])),
    );
    return c.json({
      season: {
        seasonId: meta.seasonId,
        leagueId: meta.leagueId,
        leagueName: league?.name ?? "",
        year: meta.year,
        status: meta.status,
      },
      teams: teams.map((t) => ({
        teamId: t.teamId,
        name: t.name,
        managerUserId: t.managerUserId,
        managerDisplayName: t.managerUserId
          ? (users.get(t.managerUserId)?.displayName ?? null)
          : null,
      })),
      myTeamId: teams.find((t) => t.managerUserId === user.sub)?.teamId ?? null,
      myRole: member.role,
      maxTeams: MAX_TEAMS,
    } satisfies SeasonResponse);
  });

  const toInviteView = (
    c: Parameters<typeof publicOrigin>[0],
    invite: InviteItem,
    names: Map<string, { displayName: string }>,
  ): InviteView => ({
    token: invite.token,
    url: inviteUrl(publicOrigin(c, config), invite.token),
    status: inviteStatus(invite, clock()),
    ...(invite.pendingEmail ? { pendingEmail: invite.pendingEmail } : {}),
    ...(invite.usedBy && names.get(invite.usedBy)
      ? { usedByDisplayName: names.get(invite.usedBy)!.displayName }
      : {}),
    createdAt: invite.createdAt,
    expiresAt: new Date(invite.expiresAt * 1000).toISOString(),
  });

  // ---- Commissioner: invites ----
  app.get("/seasons/:seasonId/invites", async (c) => {
    const meta = await loadSeasonMeta(db, c.req.param("seasonId"));
    await requireCommissioner(db, meta.leagueId, c.get("user"));
    const invites = await listSeasonInvites(db, meta.seasonId);
    const names = await getUsers(
      db,
      invites.flatMap((i) => (i.usedBy ? [i.usedBy] : [])),
    );
    return c.json(invites.map((i) => toInviteView(c, i, names)) satisfies ListInvitesResponse);
  });

  app.post("/seasons/:seasonId/invites", async (c) => {
    const user = c.get("user");
    const meta = await loadSeasonMeta(db, c.req.param("seasonId"));
    await requireCommissioner(db, meta.leagueId, user);
    const { count } = await parseBody(c, createInvitesRequest);
    const created = await createInvites(db, {
      seasonId: meta.seasonId,
      leagueId: meta.leagueId,
      count,
      createdBy: user.sub,
      now: clock(),
    });
    return c.json(
      created.map((i) => toInviteView(c, i, new Map())) satisfies CreateInvitesResponse,
      201,
    );
  });

  app.delete("/seasons/:seasonId/invites/:token", async (c) => {
    const user = c.get("user");
    const meta = await loadSeasonMeta(db, c.req.param("seasonId"));
    await requireCommissioner(db, meta.leagueId, user);
    await revokeInvite(db, {
      seasonId: meta.seasonId,
      token: c.req.param("token"),
      actorUserId: user.sub,
      now: clock(),
    });
    return c.json({ ok: true as const });
  });

  // ---- Public: invite preview + register ----
  app.get("/invites/:token", async (c) => {
    const invite = await getInvite(db, c.req.param("token"), { consistentRead: false });
    if (!invite)
      return c.json({ valid: false, reason: "not_found" } satisfies InvitePreviewResponse);
    const status = inviteStatus(invite, clock());
    if (status === "revoked" || status === "used" || status === "expired")
      return c.json({ valid: false, reason: status } satisfies InvitePreviewResponse);
    const [meta, league] = await Promise.all([
      getSeasonMeta(db, invite.seasonId),
      getLeague(db, invite.leagueId),
    ]);
    return c.json({
      valid: true,
      leagueName: league?.name,
      seasonYear: meta?.year,
      ...(invite.pendingEmail ? { pendingEmail: maskEmail(invite.pendingEmail) } : {}),
    } satisfies InvitePreviewResponse);
  });

  app.post("/invites/:token/register", async (c) => {
    const token = c.req.param("token");
    const { email } = await parseBody(c, registerRequest);
    assertInviteUsable(await getInvite(db, token), clock());
    await bindPendingEmail(db, token, email, clock());
    await cognito.ensureOtpReadyUser(email);
    return c.json({ ok: true as const });
  });

  // ---- Accept ----
  app.post("/invites/:token/accept", async (c) => {
    const user = c.get("user");
    if (!user.email) throw forbidden("Your account has no email address");
    const { teamName } = await parseBody(c, acceptInviteRequest);
    const result = await acceptInvite(db, {
      token: c.req.param("token"),
      userId: user.sub,
      email: user.email,
      teamName,
      now: clock(),
    });
    return c.json({ seasonId: result.seasonId, teamId: result.teamId });
  });

  // ---- Rename team ----
  app.patch("/teams/:seasonId/:teamId", async (c) => {
    const user = c.get("user");
    const meta = await loadSeasonMeta(db, c.req.param("seasonId"));
    const member = await requireMember(db, meta.leagueId, user);
    const teams = await listTeams(db, meta.seasonId);
    const team = teams.find((t) => t.teamId === c.req.param("teamId"));
    if (!team) throw notFound("Team not found");
    const isCommissioner = member.role === "commissioner";
    if (team.managerUserId !== user.sub && !isCommissioner)
      throw forbidden("Only the team owner or the commissioner can rename a team");
    const { name } = await parseBody(c, renameTeamRequest);
    const renamed = await renameTeam(db, {
      seasonId: meta.seasonId,
      teamId: team.teamId,
      name,
      actorUserId: user.sub,
      audit: isCommissioner,
      now: clock(),
    });
    return c.json({ teamId: renamed.teamId, name: renamed.name });
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
