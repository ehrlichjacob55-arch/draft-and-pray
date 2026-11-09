import { beforeAll, describe, expect, it } from "vitest";
import {
  apiError,
  invitePreviewResponse,
  listInvitesResponse,
  meResponse,
  seasonResponse,
  type InviteView,
} from "@dnp/contract";
import { bootstrapLeague, localSub, type Dynamo } from "@dnp/db";
import { createTestDynamo } from "@dnp/db/testing";
import type { CognitoAdmin } from "./cognito";
import { loadConfig } from "./config";
import { createApp } from "./http/app";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let db: Dynamo;
let clock = new Date();
const ensured: string[] = [];
const cognito: CognitoAdmin = {
  async ensureOtpReadyUser(email) {
    ensured.push(email);
  },
};

beforeAll(async () => {
  db = await createTestDynamo("api-invites");
});

const localApp = () => createApp({ config: loadConfig({}), db, cognito, now: () => clock });

let n = 0;
async function setup() {
  n++;
  const commish = `boss${n}@local.test`;
  const r = await bootstrapLeague(db, {
    userId: localSub(commish),
    email: commish,
    leagueName: `League ${n}`,
    year: 2026,
  });
  return { ...r, commish, app: localApp() };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

async function call(
  ctx: Ctx,
  method: string,
  path: string,
  opts: { as?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.as) headers["X-Dev-User-Email"] = opts.as;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await ctx.app.request(`/api${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const json = (await res.json()) as Json;
  return { status: res.status, json };
}

async function createInvite(ctx: Ctx, count = 1): Promise<InviteView[]> {
  const r = await call(ctx, "POST", `/seasons/${ctx.seasonId}/invites`, {
    as: ctx.commish,
    body: { count },
  });
  expect(r.status).toBe(201);
  return r.json as unknown as InviteView[];
}

/** register + accept as `email`; returns the accept response. */
async function join(ctx: Ctx, email: string, teamName: string) {
  const [inv] = await createInvite(ctx);
  const reg = await call(ctx, "POST", `/invites/${inv!.token}/register`, { body: { email } });
  expect(reg.status).toBe(200);
  return {
    token: inv!.token,
    ...(await call(ctx, "POST", `/invites/${inv!.token}/accept`, {
      as: email,
      body: { teamName },
    })),
  };
}

describe("GET /me", () => {
  it("returns user null + no leagues for a signed-in user without a profile", async () => {
    const ctx = await setup();
    const r = await call(ctx, "GET", "/me", { as: "stranger@x.com" });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ user: null, leagues: [] });
  });

  it("returns the commissioner's league and seasons", async () => {
    const ctx = await setup();
    const r = await call(ctx, "GET", "/me", { as: ctx.commish });
    const me = meResponse.parse(r.json);
    expect(me.user).toMatchObject({ email: ctx.commish, userId: localSub(ctx.commish) });
    expect(me.leagues).toEqual([
      {
        leagueId: ctx.leagueId,
        name: `League ${n}`,
        role: "commissioner",
        seasons: [{ seasonId: ctx.seasonId, year: 2026, status: "setup" }],
      },
    ]);
  });
});

describe("authentication", () => {
  it("rejects missing/invalid tokens (401) and allows public routes when Cognito is configured", async () => {
    const config = loadConfig({
      APP_ENV: "dev",
      APP_TABLE: "t",
      COGNITO_USER_POOL_ID: "us-east-2_abc123",
      COGNITO_CLIENT_ID: "client",
    });
    const app = createApp({
      config,
      db,
      cognito,
      verifyToken: async (t) => {
        if (t !== "good") throw new Error("bad");
        return { sub: "s1", email: "a@x.com" };
      },
    });
    const noTok = await app.request("/api/me");
    expect(noTok.status).toBe(401);
    expect(apiError.parse(await noTok.json()).error.code).toBe("unauthorized");
    expect(
      (await app.request("/api/me", { headers: { authorization: "Bearer nope" } })).status,
    ).toBe(401);
    expect(
      (await app.request("/api/me", { headers: { authorization: "Bearer good" } })).status,
    ).toBe(200);
    expect((await app.request("/api/invites/none")).status).toBe(200);
    expect(
      (await app.request("/api/invites/none/register", { method: "POST", body: "{}" })).status,
    ).toBe(400);
    expect((await app.request("/api/invites/none/accept", { method: "POST" })).status).toBe(401);
    expect((await app.request("/api/health")).status).toBe(200);
  });

  it("ignores X-Dev-User-Email unless APP_ENV=local without Cognito", async () => {
    for (const env of [
      { APP_ENV: "dev", APP_TABLE: "t" },
      { APP_ENV: "prod", APP_TABLE: "t" },
      { APP_ENV: "local", COGNITO_USER_POOL_ID: "us-east-2_abc123", COGNITO_CLIENT_ID: "c" },
    ]) {
      const app = createApp({ config: loadConfig(env), db });
      const res = await app.request("/api/me", { headers: { "X-Dev-User-Email": "a@x.com" } });
      expect(res.status, JSON.stringify(env)).toBe(401);
    }
  });

  it("derives a stable sub from the dev header and defaults to dev@local.test", async () => {
    const ctx = await setup();
    const viaHeader = await call(ctx, "GET", "/me", { as: " Boss1@LOCAL.test " });
    expect(viaHeader.status).toBe(200);
    // Without the header it is dev@local.test: no profile.
    expect((await call(ctx, "GET", "/me")).json).toEqual({ user: null, leagues: [] });
  });
});

describe("invites: create / list / revoke", () => {
  it("commissioner creates and lists invites with urls and statuses", async () => {
    const ctx = await setup();
    const created = await createInvite(ctx, 2);
    expect(created).toHaveLength(2);
    for (const i of created) {
      expect(i.url).toBe(`http://localhost:5173/join/${i.token}`);
      expect(i.status).toBe("open");
      expect(i.token).toHaveLength(43);
    }
    const list = await call(ctx, "GET", `/seasons/${ctx.seasonId}/invites`, { as: ctx.commish });
    expect(list.status).toBe(200);
    expect(listInvitesResponse.parse(list.json)).toHaveLength(2);
  });

  it("builds the url from PUBLIC_BASE_URL, then X-Forwarded-Host, in AWS envs", async () => {
    const ctx = await setup();
    const verifyToken = async () => ({ sub: localSub(ctx.commish), email: ctx.commish });
    const base = {
      APP_ENV: "dev",
      APP_TABLE: "t",
      COGNITO_USER_POOL_ID: "p",
      COGNITO_CLIENT_ID: "c",
    };
    const headers = { authorization: "Bearer x", "content-type": "application/json" };
    const post = (app: ReturnType<typeof createApp>, extra: Record<string, string> = {}) =>
      app.request(`/api/seasons/${ctx.seasonId}/invites`, {
        method: "POST",
        headers: { ...headers, ...extra },
        body: JSON.stringify({ count: 1 }),
      });
    const a = createApp({
      config: loadConfig({ ...base, PUBLIC_BASE_URL: "https://dnp.example.com/" }),
      db,
      verifyToken,
    });
    expect(((await (await post(a)).json()) as InviteView[])[0]!.url).toMatch(
      /^https:\/\/dnp\.example\.com\/join\/.{43}$/,
    );
    const b = createApp({ config: loadConfig(base), db, verifyToken });
    expect(
      (
        (await (
          await post(b, { "x-forwarded-host": "d123.cloudfront.net" })
        ).json()) as InviteView[]
      )[0]!.url,
    ).toMatch(/^https:\/\/d123\.cloudfront\.net\/join\//);
  });

  it("validates count and enforces the 9-team limit with 409 season_full", async () => {
    const ctx = await setup();
    for (const count of [0, 10, "x"]) {
      const r = await call(ctx, "POST", `/seasons/${ctx.seasonId}/invites`, {
        as: ctx.commish,
        body: { count },
      });
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe("validation_error");
    }
    await createInvite(ctx, 9);
    const over = await call(ctx, "POST", `/seasons/${ctx.seasonId}/invites`, {
      as: ctx.commish,
      body: { count: 1 },
    });
    expect(over.status).toBe(409);
    expect(over.json.error.code).toBe("season_full");
  });

  it("revokes an unused invite; a revoked invite shows as revoked and cannot be used", async () => {
    const ctx = await setup();
    const [inv] = await createInvite(ctx);
    const del = await call(ctx, "DELETE", `/seasons/${ctx.seasonId}/invites/${inv!.token}`, {
      as: ctx.commish,
    });
    expect(del.status).toBe(200);
    const again = await call(ctx, "DELETE", `/seasons/${ctx.seasonId}/invites/${inv!.token}`, {
      as: ctx.commish,
    });
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("invite_revoked");
    const preview = await call(ctx, "GET", `/invites/${inv!.token}`);
    expect(invitePreviewResponse.parse(preview.json)).toEqual({ valid: false, reason: "revoked" });
    const reg = await call(ctx, "POST", `/invites/${inv!.token}/register`, {
      body: { email: "a@x.com" },
    });
    expect(reg.status).toBe(409);
    expect(reg.json.error.code).toBe("invite_revoked");
  });

  it("cannot revoke a used invite (409 invite_used) or an unknown one (404)", async () => {
    const ctx = await setup();
    const joined = await join(ctx, "m1@x.com", "Team One");
    expect(joined.status).toBe(200);
    const del = await call(ctx, "DELETE", `/seasons/${ctx.seasonId}/invites/${joined.token}`, {
      as: ctx.commish,
    });
    expect(del.status).toBe(409);
    expect(del.json.error.code).toBe("invite_used");
    const missing = await call(ctx, "DELETE", `/seasons/${ctx.seasonId}/invites/nope`, {
      as: ctx.commish,
    });
    expect(missing.status).toBe(404);
  });

  it("lists used invites with the manager's display name and bound emails as pending", async () => {
    const ctx = await setup();
    await join(ctx, "alice@x.com", "Alpha");
    const [pending] = await createInvite(ctx);
    await call(ctx, "POST", `/invites/${pending!.token}/register`, {
      body: { email: "bob@x.com" },
    });
    const list = listInvitesResponse.parse(
      (await call(ctx, "GET", `/seasons/${ctx.seasonId}/invites`, { as: ctx.commish })).json,
    );
    expect(list.find((i) => i.status === "used")).toMatchObject({ usedByDisplayName: "alice" });
    expect(list.find((i) => i.status === "pending")).toMatchObject({ pendingEmail: "bob@x.com" });
  });
});

describe("public invite preview + register", () => {
  it("preview: not_found, valid, masked pending email, expired", async () => {
    const ctx = await setup();
    const nf = await call(ctx, "GET", "/invites/does-not-exist");
    expect(nf).toMatchObject({ status: 200, json: { valid: false, reason: "not_found" } });
    const [inv] = await createInvite(ctx);
    expect((await call(ctx, "GET", `/invites/${inv!.token}`)).json).toEqual({
      valid: true,
      leagueName: `League ${n}`,
      seasonYear: 2026,
    });
    await call(ctx, "POST", `/invites/${inv!.token}/register`, {
      body: { email: "Jane@Gmail.com" },
    });
    expect((await call(ctx, "GET", `/invites/${inv!.token}`)).json.pendingEmail).toBe(
      "j***@gmail.com",
    );
    clock = new Date(Date.now() + 15 * 86400_000);
    try {
      expect((await call(ctx, "GET", `/invites/${inv!.token}`)).json).toEqual({
        valid: false,
        reason: "expired",
      });
    } finally {
      clock = new Date();
    }
  });

  it("register normalizes the email, makes the Cognito user OTP-ready and is repeatable", async () => {
    const ctx = await setup();
    const [inv] = await createInvite(ctx);
    ensured.length = 0;
    const url = `/invites/${inv!.token}/register`;
    expect((await call(ctx, "POST", url, { body: { email: "  New@X.com " } })).json).toEqual({
      ok: true,
    });
    expect((await call(ctx, "POST", url, { body: { email: "new@x.com" } })).status).toBe(200);
    expect(ensured).toEqual(["new@x.com", "new@x.com"]);
  });

  it("register: a different email on a bound invite is 409 invite_bound; bad input is 400", async () => {
    const ctx = await setup();
    const [inv] = await createInvite(ctx);
    const url = `/invites/${inv!.token}/register`;
    await call(ctx, "POST", url, { body: { email: "a@x.com" } });
    ensured.length = 0;
    const other = await call(ctx, "POST", url, { body: { email: "b@x.com" } });
    expect(other.status).toBe(409);
    expect(other.json.error.code).toBe("invite_bound");
    expect(ensured).toEqual([]);
    expect((await call(ctx, "POST", url, { body: { email: "nope" } })).status).toBe(400);
    expect((await call(ctx, "POST", url, { body: "{" as unknown })).status).toBe(400);
    const nf = await call(ctx, "POST", "/invites/zzz/register", { body: { email: "a@x.com" } });
    expect(nf.status).toBe(404);
    expect(nf.json.error.code).toBe("invite_not_found");
  });
});

describe("accept", () => {
  it("happy path: joins, shows in the season, /me lists the league", async () => {
    const ctx = await setup();
    const r = await join(ctx, "mgr@x.com", "  Gridiron Gang ");
    expect(r.status).toBe(200);
    const { seasonId, teamId } = r.json as { seasonId: string; teamId: string };
    expect(seasonId).toBe(ctx.seasonId);
    const season = seasonResponse.parse(
      (await call(ctx, "GET", `/seasons/${seasonId}`, { as: "mgr@x.com" })).json,
    );
    expect(season).toMatchObject({
      season: { leagueName: `League ${n}`, year: 2026, status: "setup" },
      myTeamId: teamId,
      myRole: "manager",
      maxTeams: 9,
      teams: [{ teamId, name: "Gridiron Gang", managerDisplayName: "mgr" }],
    });
    const me = meResponse.parse((await call(ctx, "GET", "/me", { as: "mgr@x.com" })).json);
    expect(me.leagues[0]).toMatchObject({ leagueId: ctx.leagueId, role: "manager" });
  });

  it("wrong email: 409 email_mismatch", async () => {
    const ctx = await setup();
    const [inv] = await createInvite(ctx);
    await call(ctx, "POST", `/invites/${inv!.token}/register`, { body: { email: "a@x.com" } });
    const r = await call(ctx, "POST", `/invites/${inv!.token}/accept`, {
      as: "thief@x.com",
      body: { teamName: "Mine" },
    });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("email_mismatch");
  });

  it("used / revoked / expired / unknown", async () => {
    const ctx = await setup();
    const first = await join(ctx, "a@x.com", "A");
    const used = await call(ctx, "POST", `/invites/${first.token}/accept`, {
      as: "a@x.com",
      body: { teamName: "A2" },
    });
    expect(used.json.error.code).toBe("invite_used");

    const [rev] = await createInvite(ctx);
    await call(ctx, "POST", `/invites/${rev!.token}/register`, { body: { email: "b@x.com" } });
    await call(ctx, "DELETE", `/seasons/${ctx.seasonId}/invites/${rev!.token}`, {
      as: ctx.commish,
    });
    const revoked = await call(ctx, "POST", `/invites/${rev!.token}/accept`, {
      as: "b@x.com",
      body: { teamName: "B" },
    });
    expect(revoked.json.error.code).toBe("invite_revoked");

    const [exp] = await createInvite(ctx);
    await call(ctx, "POST", `/invites/${exp!.token}/register`, { body: { email: "c@x.com" } });
    clock = new Date(Date.now() + 15 * 86400_000);
    try {
      const expired = await call(ctx, "POST", `/invites/${exp!.token}/accept`, {
        as: "c@x.com",
        body: { teamName: "C" },
      });
      expect(expired.status).toBe(409);
      expect(expired.json.error.code).toBe("invite_expired");
    } finally {
      clock = new Date();
    }

    const nf = await call(ctx, "POST", "/invites/unknown/accept", {
      as: "a@x.com",
      body: { teamName: "X" },
    });
    expect(nf.status).toBe(404);
  });

  it("already_has_team and duplicate team names (case-insensitive) are 409", async () => {
    const ctx = await setup();
    await join(ctx, "a@x.com", "Alpha");
    const second = await join(ctx, "a@x.com", "Alpha Two");
    expect(second.status).toBe(409);
    expect(second.json.error.code).toBe("already_has_team");
    const dup = await join(ctx, "b@x.com", "ALPHA");
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe("team_name_taken");
  });

  it("validates the team name (400) and requires sign-in (401 with Cognito)", async () => {
    const ctx = await setup();
    const [inv] = await createInvite(ctx);
    await call(ctx, "POST", `/invites/${inv!.token}/register`, { body: { email: "a@x.com" } });
    for (const teamName of ["", "   ", "x".repeat(41), 5]) {
      const r = await call(ctx, "POST", `/invites/${inv!.token}/accept`, {
        as: "a@x.com",
        body: { teamName },
      });
      expect(r.status).toBe(400);
    }
  });

  it("the commissioner can join their own season and stays commissioner", async () => {
    const ctx = await setup();
    const [inv] = await createInvite(ctx);
    await call(ctx, "POST", `/invites/${inv!.token}/register`, { body: { email: ctx.commish } });
    const r = await call(ctx, "POST", `/invites/${inv!.token}/accept`, {
      as: ctx.commish,
      body: { teamName: "Boss FC" },
    });
    expect(r.status).toBe(200);
    const season = seasonResponse.parse(
      (await call(ctx, "GET", `/seasons/${ctx.seasonId}`, { as: ctx.commish })).json,
    );
    expect(season.myRole).toBe("commissioner");
    expect(season.teams).toHaveLength(1);
  });
});

describe("authorization", () => {
  it("non-members get 403 on season routes; unknown seasons are 404", async () => {
    const ctx = await setup();
    const get = await call(ctx, "GET", `/seasons/${ctx.seasonId}`, { as: "outsider@x.com" });
    expect(get.status).toBe(403);
    expect(apiError.parse(get.json).error.code).toBe("forbidden");
    expect((await call(ctx, "GET", "/seasons/none", { as: ctx.commish })).status).toBe(404);
    const list = await call(ctx, "GET", `/seasons/${ctx.seasonId}/invites`, {
      as: "outsider@x.com",
    });
    expect(list.status).toBe(403);
  });

  it("managers get 403 on commissioner routes", async () => {
    const ctx = await setup();
    const joined = await join(ctx, "mgr@x.com", "M");
    const [inv] = await createInvite(ctx);
    const base = `/seasons/${ctx.seasonId}/invites`;
    expect((await call(ctx, "GET", base, { as: "mgr@x.com" })).status).toBe(403);
    expect((await call(ctx, "POST", base, { as: "mgr@x.com", body: { count: 1 } })).status).toBe(
      403,
    );
    expect((await call(ctx, "DELETE", `${base}/${inv!.token}`, { as: "mgr@x.com" })).status).toBe(
      403,
    );
    expect(joined.status).toBe(200);
  });
});

describe("PATCH /teams/:seasonId/:teamId", () => {
  it("owner renames; other manager 403; commissioner renames (audited); duplicates 409", async () => {
    const ctx = await setup();
    const a = await join(ctx, "a@x.com", "Alpha");
    const b = await join(ctx, "b@x.com", "Beta");
    const teamA = (a.json as { teamId: string }).teamId;
    const path = `/teams/${ctx.seasonId}/${teamA}`;

    const own = await call(ctx, "PATCH", path, { as: "a@x.com", body: { name: " Alpha Prime " } });
    expect(own).toMatchObject({ status: 200, json: { teamId: teamA, name: "Alpha Prime" } });

    expect((await call(ctx, "PATCH", path, { as: "b@x.com", body: { name: "Hack" } })).status).toBe(
      403,
    );
    expect(
      (await call(ctx, "PATCH", path, { as: "outsider@x.com", body: { name: "Hack" } })).status,
    ).toBe(403);
    const dup = await call(ctx, "PATCH", path, { as: "a@x.com", body: { name: "beta" } });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe("team_name_taken");
    expect((await call(ctx, "PATCH", path, { as: "a@x.com", body: { name: "" } })).status).toBe(
      400,
    );

    const byCommish = await call(ctx, "PATCH", path, {
      as: ctx.commish,
      body: { name: "Renamed" },
    });
    expect(byCommish.status).toBe(200);
    expect(
      (
        await call(ctx, "PATCH", `/teams/${ctx.seasonId}/nope`, {
          as: ctx.commish,
          body: { name: "Z" },
        })
      ).status,
    ).toBe(404);
    expect(b.status).toBe(200);

    const { loadSeason } = await import("@dnp/db");
    const snap = await loadSeason(db, ctx.seasonId, { consistentRead: true });
    const actions = snap.audit.map((x) => x.action);
    expect(actions.filter((x) => x === "team.rename")).toHaveLength(1);
    expect(actions).toContain("invite.create");
  });
});
