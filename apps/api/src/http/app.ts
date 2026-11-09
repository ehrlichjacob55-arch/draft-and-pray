import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  MAX_TEAMS,
  addManagerRequest,
  renameTeamRequest,
  updateManagerRequest,
  type ManagerView,
  type ManagerWithDelivery,
  type MeResponse,
  type SeasonResponse,
} from "@dnp/contract";
import {
  DomainError,
  claimPendingAssignments,
  addManager,
  auditManagerResent,
  getLeague,
  getPendingManager,
  getUser,
  listManagers,
  listMemberships,
  listPendingAssignments,
  listSeasonPointers,
  listTeams,
  managerStatus,
  recordManagerInvite,
  removePendingManager,
  renameTeam,
  updatePendingManager,
  type Dynamo,
  type ManagerRow,
} from "@dnp/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { noopCognito, type CognitoAdmin } from "../cognito";
import type { Config } from "../config";
import { logError } from "../redact";
import { authMiddleware, isPublicRoute, type AppEnv, type TokenVerifier } from "./auth";
import { loadSeasonMeta, requireCommissioner, requireMember } from "./authz";
import { errorBody, forbidden, notFound, parseBody, toErrorResponse } from "./errors";
import { resolveTestSuppress, testModeAllowed } from "./test-suppress";

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
    if (status >= 500) logError("Unhandled error", err);
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
      logError("Health check db error", err);
      dbStatus = "error";
    }
    return c.json(
      { status: "ok", env: config.APP_ENV, db: dbStatus },
      dbStatus === "ok" ? 200 : 503,
    );
  });

  // ---- GET /me ----
  app.get("/me", async (c) => {
    const { sub, email, emailVerified } = c.get("user");
    // docs/design/13 §1.4: a verified email picks up the teams a commissioner assigned to it.
    const justClaimed =
      email && emailVerified !== false
        ? await claimPendingAssignments(db, { userId: sub, email, now: clock() })
        : [];
    const user = await getUser(db, sub);
    if (!user) return c.json({ user: null, leagues: [], justClaimed } satisfies MeResponse);
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
      justClaimed,
    } satisfies MeResponse);
  });

  // ---- GET /seasons/:seasonId (member-facing: team names only, no PII) ----
  app.get("/seasons/:seasonId", async (c) => {
    const user = c.get("user");
    const meta = await loadSeasonMeta(db, c.req.param("seasonId"));
    const [member, league, teams] = await Promise.all([
      requireMember(db, meta.leagueId, user),
      getLeague(db, meta.leagueId),
      listTeams(db, meta.seasonId),
    ]);
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
        isMine: t.managerUserId === user.sub,
      })),
      myTeamId: teams.find((t) => t.managerUserId === user.sub)?.teamId ?? null,
      myRole: member.role,
      maxTeams: MAX_TEAMS,
    } satisfies SeasonResponse);
  });

  // ---- Commissioner: managers (docs/design/13 §5). Bodies are never logged. ----
  const toManagerView = ({ manager, team }: ManagerRow): ManagerView => ({
    teamId: team.teamId,
    teamName: team.name,
    firstName: manager.firstName,
    lastName: manager.lastName,
    email: manager.email,
    status: managerStatus(manager, clock()),
    invitedAt: manager.invitedAt,
    lastSentAt: manager.lastSentAt ?? null,
    claimedAt: manager.claimedAt ?? null,
  });
  const reload = async (seasonId: string, teamId: string): Promise<ManagerRow> => {
    const row = (await listManagers(db, seasonId)).find((r) => r.team.teamId === teamId);
    if (!row) throw notFound("Manager not found");
    return row;
  };
  const inviteMetadata = async (meta: { leagueId: string; year: number }, teamName: string) => ({
    leagueName: (await getLeague(db, meta.leagueId))?.name ?? "",
    seasonYear: String(meta.year),
    teamName,
  });
  const inviteFailed = (err: unknown) => {
    logError("Invitation failed", err);
    return new DomainError("invite_failed", "Could not send the invitation. Try again.");
  };

  app.get("/seasons/:seasonId/managers", async (c) => {
    const meta = await loadSeasonMeta(db, c.req.param("seasonId"));
    await requireCommissioner(db, meta.leagueId, c.get("user"));
    const rows = await listManagers(db, meta.seasonId);
    return c.json(rows.map(toManagerView));
  });

  app.post("/seasons/:seasonId/managers", async (c) => {
    const user = c.get("user");
    const meta = await loadSeasonMeta(db, c.req.param("seasonId"));
    await requireCommissioner(db, meta.leagueId, user);
    const body = await parseBody(c, addManagerRequest);
    const added = await addManager(db, {
      seasonId: meta.seasonId,
      firstName: body.firstName,
      lastName: body.lastName,
      email: body.email,
      actorUserId: user.sub,
      now: clock(),
    });
    let emailSent: boolean;
    try {
      const result = await cognito.inviteNewUser({
        email: body.email,
        clientMetadata: await inviteMetadata(meta, added.team.name),
        testSuppress: resolveTestSuppress({
          config,
          user,
          testSuppressQuery: c.req.query("testSuppress"),
          testTemporaryPassword: body.testTemporaryPassword,
        }),
      });
      emailSent = result.emailSent;
      await recordManagerInvite(db, {
        seasonId: meta.seasonId,
        teamId: added.team.teamId,
        cognitoUsername: result.username,
        lastSentAt: result.emailSent ? clock() : undefined,
      });
    } catch (err) {
      // Keep the data consistent with what the commissioner sees: no invitation, no team.
      await removePendingManager(db, {
        seasonId: meta.seasonId,
        teamId: added.team.teamId,
        actorUserId: user.sub,
        now: clock(),
      }).catch((e: unknown) => logError("Rollback after failed invitation failed", e));
      throw inviteFailed(err);
    }
    const row = await reload(meta.seasonId, added.team.teamId);
    return c.json({ ...toManagerView(row), emailSent } satisfies ManagerWithDelivery, 201);
  });

  app.post("/seasons/:seasonId/managers/:teamId/resend", async (c) => {
    const user = c.get("user");
    const meta = await loadSeasonMeta(db, c.req.param("seasonId"));
    await requireCommissioner(db, meta.leagueId, user);
    const { manager, team } = await getPendingManager(db, meta.seasonId, c.req.param("teamId"));
    let emailSent = false;
    if (testModeAllowed({ config, user, testSuppressQuery: c.req.query("testSuppress") })) {
      // Test mode never emails: pretend the resend happened so the flow can be exercised.
      await recordManagerInvite(db, {
        seasonId: meta.seasonId,
        teamId: team.teamId,
        lastSentAt: clock(),
      });
    } else {
      try {
        const result = await cognito.resendInvite({
          email: manager.email,
          username: manager.cognitoUsername,
          clientMetadata: await inviteMetadata(meta, team.name),
        });
        emailSent = result.emailSent;
        await recordManagerInvite(db, {
          seasonId: meta.seasonId,
          teamId: team.teamId,
          cognitoUsername: result.username,
          lastSentAt: result.emailSent ? clock() : undefined,
        });
      } catch (err) {
        throw inviteFailed(err);
      }
    }
    await auditManagerResent(db, {
      seasonId: meta.seasonId,
      teamId: team.teamId,
      actorUserId: user.sub,
      now: clock(),
    });
    return c.json({
      ...toManagerView(await reload(meta.seasonId, team.teamId)),
      emailSent,
    } satisfies ManagerWithDelivery);
  });

  app.patch("/seasons/:seasonId/managers/:teamId", async (c) => {
    const user = c.get("user");
    const meta = await loadSeasonMeta(db, c.req.param("seasonId"));
    await requireCommissioner(db, meta.leagueId, user);
    const body = await parseBody(c, updateManagerRequest);
    const updated = await updatePendingManager(db, {
      seasonId: meta.seasonId,
      teamId: c.req.param("teamId"),
      firstName: body.firstName,
      lastName: body.lastName,
      email: body.email,
      actorUserId: user.sub,
      now: clock(),
    });
    let emailSent = false;
    if (updated.emailChanged) {
      // The old address never joined: drop its pending Cognito user (unless another season
      // still waits on it), then invite the new address.
      if (updated.previous.cognitoUsername) {
        const stillPending = (await listPendingAssignments(db, updated.previous.email)).length > 0;
        if (!stillPending)
          await cognito
            .deleteIfUnconfirmed(updated.previous.cognitoUsername)
            .catch((e: unknown) => logError("Could not delete the old pending user", e));
      }
      try {
        const result = await cognito.inviteNewUser({
          email: updated.manager.email,
          clientMetadata: await inviteMetadata(meta, updated.team.name),
          testSuppress: resolveTestSuppress({
            config,
            user,
            testSuppressQuery: c.req.query("testSuppress"),
            testTemporaryPassword: body.testTemporaryPassword,
          }),
        });
        emailSent = result.emailSent;
        await recordManagerInvite(db, {
          seasonId: meta.seasonId,
          teamId: updated.team.teamId,
          cognitoUsername: result.username,
          lastSentAt: result.emailSent ? clock() : undefined,
        });
      } catch (err) {
        // Data stays updated; the commissioner can use Resend, which re-creates the user.
        throw inviteFailed(err);
      }
    }
    return c.json({
      ...toManagerView(await reload(meta.seasonId, updated.team.teamId)),
      emailSent,
    } satisfies ManagerWithDelivery);
  });

  app.delete("/seasons/:seasonId/managers/:teamId", async (c) => {
    const user = c.get("user");
    const meta = await loadSeasonMeta(db, c.req.param("seasonId"));
    await requireCommissioner(db, meta.leagueId, user);
    const removed = await removePendingManager(db, {
      seasonId: meta.seasonId,
      teamId: c.req.param("teamId"),
      actorUserId: user.sub,
      now: clock(),
    });
    if (removed.cognitoUsername) {
      try {
        const stillPending = (await listPendingAssignments(db, removed.email)).length > 0;
        if (!stillPending) await cognito.deleteIfUnconfirmed(removed.cognitoUsername);
      } catch (err) {
        logError("Could not delete the pending user", err);
      }
    }
    return c.json({ ok: true as const });
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
