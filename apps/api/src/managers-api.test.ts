import { beforeAll, describe, expect, it } from "vitest";
import {
  apiError,
  listManagersResponse,
  managerWithDelivery,
  meResponse,
  seasonResponse,
} from "@dnp/contract";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { bootstrapLeague, loadSeason, localSub, teamKey, type Dynamo } from "@dnp/db";
import { createTestDynamo } from "@dnp/db/testing";
import type { CognitoAdmin, InviteUserInput } from "./cognito";
import { loadConfig } from "./config";
import { createApp } from "./http/app";
import type { AuthUser } from "./http/auth";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let db: Dynamo;
const clock = new Date("2026-03-01T00:00:00Z");

interface FakeCognito extends CognitoAdmin {
  invites: InviteUserInput[];
  resends: unknown[];
  deleted: string[];
  existingEmails: Set<string>;
  failNext: boolean;
}
function fakeCognito(): FakeCognito {
  let seq = 0;
  const f: FakeCognito = {
    invites: [],
    resends: [],
    deleted: [],
    existingEmails: new Set(),
    failNext: false,
    async ensureOtpReadyUser() {},
    async inviteNewUser(input) {
      if (f.failNext) {
        f.failNext = false;
        throw new Error("boom for alex@example.com");
      }
      f.invites.push(input);
      const existing = f.existingEmails.has(input.email);
      return {
        username: `uuid-${++seq}`,
        existing,
        emailSent: !existing && !input.testSuppress,
      };
    },
    async resendInvite(input) {
      f.resends.push(input);
      return { username: input.username, existing: true, emailSent: true };
    },
    async deleteIfUnconfirmed(username) {
      f.deleted.push(username);
      return true;
    },
  };
  return f;
}

beforeAll(async () => {
  db = await createTestDynamo("api-managers");
});

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
  const cognito = fakeCognito();
  const app = createApp({ config: loadConfig({}), db, cognito, now: () => clock });
  return { ...r, commish, app, cognito };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

async function call(
  ctx: Ctx,
  method: string,
  path: string,
  opts: { as?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.as) headers["X-Dev-User-Email"] = opts.as;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await ctx.app.request(`/api${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, json: (await res.json()) as Json };
}

const addAs = (ctx: Ctx, email: string, lastName = "Example", as = ctx.commish) =>
  call(ctx, "POST", `/seasons/${ctx.seasonId}/managers`, {
    as,
    body: { firstName: "Alex", lastName, email },
  });

describe("GET /me", () => {
  it("returns user null + no leagues + empty justClaimed for a stranger", async () => {
    const ctx = await setup();
    const r = await call(ctx, "GET", "/me", { as: "stranger@example.com" });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ user: null, leagues: [], justClaimed: [] });
  });

  it("returns the commissioner's league and seasons", async () => {
    const ctx = await setup();
    const me = meResponse.parse((await call(ctx, "GET", "/me", { as: ctx.commish })).json);
    expect(me.user).toMatchObject({ email: ctx.commish, userId: localSub(ctx.commish) });
    expect(me.leagues).toEqual([
      {
        leagueId: ctx.leagueId,
        name: `League ${n}`,
        role: "commissioner",
        seasons: [{ seasonId: ctx.seasonId, year: 2026, status: "setup" }],
      },
    ]);
    expect(me.justClaimed).toEqual([]);
  });

  it("auto-claims pending teams once and reports justClaimed", async () => {
    const ctx = await setup();
    const added = await addAs(ctx, "new.manager@example.com", "Smith");
    expect(added.status).toBe(201);
    const first = meResponse.parse(
      (await call(ctx, "GET", "/me", { as: "New.Manager@example.com" })).json,
    );
    expect(first.justClaimed).toEqual([
      { seasonId: ctx.seasonId, teamId: added.json.teamId, teamName: "Team Smith" },
    ]);
    expect(first.user).toMatchObject({ displayName: "Alex" });
    expect(first.leagues[0]).toMatchObject({ role: "manager" });
    const second = meResponse.parse(
      (await call(ctx, "GET", "/me", { as: "new.manager@example.com" })).json,
    );
    expect(second.justClaimed).toEqual([]);
    const season = seasonResponse.parse(
      (await call(ctx, "GET", `/seasons/${ctx.seasonId}`, { as: "new.manager@example.com" })).json,
    );
    expect(season.myTeamId).toBe(added.json.teamId);
    expect(season.teams).toEqual([
      { teamId: added.json.teamId, name: "Team Smith", abbr: "SMIT", isMine: true },
    ]);
  });

  it("does not claim for an unverified email (Cognito)", async () => {
    const ctx = await setup();
    await addAs(ctx, "unverified@example.com");
    const cfg = loadConfig({
      APP_ENV: "dev",
      APP_TABLE: "t",
      COGNITO_USER_POOL_ID: "us-east-2_abc123",
      COGNITO_CLIENT_ID: "c",
    });
    const verify = (user: AuthUser) =>
      createApp({ config: cfg, db, cognito: ctx.cognito, verifyToken: async () => user });
    const headers = { authorization: "Bearer t" };
    const unverified = verify({
      sub: "s-unv",
      email: "unverified@example.com",
      emailVerified: false,
    });
    expect(
      ((await (await unverified.request("/api/me", { headers })).json()) as Json).justClaimed,
    ).toEqual([]);
    const verified = verify({ sub: "s-unv", email: "unverified@example.com", emailVerified: true });
    expect(
      ((await (await verified.request("/api/me", { headers })).json()) as Json).justClaimed,
    ).toHaveLength(1);
  });
});

describe("authentication", () => {
  it("rejects missing/invalid tokens (401); only /health is public", async () => {
    const config = loadConfig({
      APP_ENV: "dev",
      APP_TABLE: "t",
      COGNITO_USER_POOL_ID: "us-east-2_abc123",
      COGNITO_CLIENT_ID: "client",
    });
    const app = createApp({
      config,
      db,
      verifyToken: async (t) => {
        if (t !== "good") throw new Error("bad");
        return { sub: "s1", email: "a@example.com" };
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
    expect((await app.request("/api/invites/none")).status).toBe(401);
    expect((await app.request("/api/health")).status).toBe(200);
  });

  it("ignores X-Dev-User-Email unless APP_ENV=local without Cognito", async () => {
    for (const env of [
      { APP_ENV: "dev", APP_TABLE: "t" },
      { APP_ENV: "prod", APP_TABLE: "t" },
      { APP_ENV: "local", COGNITO_USER_POOL_ID: "us-east-2_abc123", COGNITO_CLIENT_ID: "c" },
    ]) {
      const app = createApp({ config: loadConfig(env), db });
      const res = await app.request("/api/me", {
        headers: { "X-Dev-User-Email": "a@example.com" },
      });
      expect(res.status, JSON.stringify(env)).toBe(401);
    }
  });
});

describe("managers: add / list", () => {
  it("commissioner adds a manager: team, private row, Cognito invitation with metadata", async () => {
    const ctx = await setup();
    const r = await addAs(ctx, " Alex@Example.com ", "Example");
    expect(r.status).toBe(201);
    const row = managerWithDelivery.parse(r.json);
    expect(row).toMatchObject({
      teamName: "Team Example",
      firstName: "Alex",
      lastName: "Example",
      email: "alex@example.com",
      status: "invited",
      emailSent: true,
      claimedAt: null,
      lastSentAt: clock.toISOString(),
    });
    expect(ctx.cognito.invites).toEqual([
      {
        email: "alex@example.com",
        clientMetadata: { leagueName: `League ${n}`, seasonYear: "2026", teamName: "Team Example" },
        testSuppress: undefined,
      },
    ]);
    const list = await call(ctx, "GET", `/seasons/${ctx.seasonId}/managers`, { as: ctx.commish });
    expect(listManagersResponse.parse(list.json)).toHaveLength(1);
  });

  it("an existing account gets no email and no lastSentAt", async () => {
    const ctx = await setup();
    ctx.cognito.existingEmails.add("back@example.com");
    const r = await addAs(ctx, "back@example.com");
    expect(r.json).toMatchObject({ emailSent: false, status: "invited", lastSentAt: null });
  });

  it("uniquifies names, rejects duplicate emails, enforces 9 teams", async () => {
    const ctx = await setup();
    const a = await addAs(ctx, "a1@example.com");
    const b = await addAs(ctx, "a2@example.com");
    expect([a.json.teamName, b.json.teamName]).toEqual(["Team Example", "Team Example 2"]);
    const dup = await addAs(ctx, "A1@example.com", "Other");
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe("email_already_added");
    for (let i = 3; i <= 9; i++)
      expect((await addAs(ctx, `m${i}@example.com`, `L${i}`)).status).toBe(201);
    const tenth = await addAs(ctx, "m10@example.com", "Ten");
    expect(tenth.status).toBe(409);
    expect(tenth.json.error.code).toBe("season_full");
  });

  it("validates the body (400) and rolls back when Cognito fails (502, nothing left behind)", async () => {
    const ctx = await setup();
    const bad = await call(ctx, "POST", `/seasons/${ctx.seasonId}/managers`, {
      as: ctx.commish,
      body: { firstName: "", lastName: "X", email: "nope" },
    });
    expect(bad.status).toBe(400);
    ctx.cognito.failNext = true;
    const failed = await addAs(ctx, "alex@example.com");
    expect(failed.status).toBe(502);
    expect(failed.json.error.code).toBe("invite_failed");
    expect(JSON.stringify(failed.json)).not.toContain("alex@example.com");
    const list = await call(ctx, "GET", `/seasons/${ctx.seasonId}/managers`, { as: ctx.commish });
    expect(list.json).toEqual([]);
  });

  it("the commissioner can add themselves and keeps the commissioner role after claiming", async () => {
    const ctx = await setup();
    await addAs(ctx, ctx.commish, "Boss");
    const me = meResponse.parse((await call(ctx, "GET", "/me", { as: ctx.commish })).json);
    expect(me.justClaimed).toHaveLength(1);
    expect(me.leagues[0]?.role).toBe("commissioner");
  });
});

describe("managers: resend / edit / remove", () => {
  it("resend: while invited; 409 manager_joined after claiming", async () => {
    const ctx = await setup();
    const added = await addAs(ctx, "re@example.com");
    const url = `/seasons/${ctx.seasonId}/managers/${added.json.teamId}/resend`;
    const ok = await call(ctx, "POST", url, { as: ctx.commish });
    expect(ok.status).toBe(200);
    expect(ok.json.emailSent).toBe(true);
    expect(ctx.cognito.resends).toHaveLength(1);
    await call(ctx, "GET", "/me", { as: "re@example.com" });
    const late = await call(ctx, "POST", url, { as: ctx.commish });
    expect(late.status).toBe(409);
    expect(late.json.error.code).toBe("manager_joined");
  });

  it("edit: names (and default team name), email change deletes the old pending user and invites the new one", async () => {
    const ctx = await setup();
    const added = await addAs(ctx, "old@example.com", "Old");
    const url = `/seasons/${ctx.seasonId}/managers/${added.json.teamId}`;
    const renamed = await call(ctx, "PATCH", url, { as: ctx.commish, body: { lastName: "Newer" } });
    expect(renamed.json).toMatchObject({
      teamName: "Team Newer",
      lastName: "Newer",
      emailSent: false,
    });
    const moved = await call(ctx, "PATCH", url, {
      as: ctx.commish,
      body: { email: "new@example.com" },
    });
    expect(moved.status).toBe(200);
    expect(moved.json).toMatchObject({ email: "new@example.com", emailSent: true });
    expect(ctx.cognito.deleted).toEqual(["uuid-1"]);
    expect(ctx.cognito.invites.map((i) => i.email)).toEqual(["old@example.com", "new@example.com"]);
    // The old address no longer claims anything; the new one does.
    expect((await call(ctx, "GET", "/me", { as: "old@example.com" })).json.justClaimed).toEqual([]);
    expect(
      (await call(ctx, "GET", "/me", { as: "new@example.com" })).json.justClaimed,
    ).toHaveLength(1);
    const late = await call(ctx, "PATCH", url, { as: ctx.commish, body: { firstName: "Z" } });
    expect(late.status).toBe(409);
    expect(late.json.error.code).toBe("manager_joined");
    expect((await call(ctx, "PATCH", url, { as: ctx.commish, body: {} })).status).toBe(400);
  });

  it("remove: deletes team + pending user; 409 once joined; 404 for unknown teams", async () => {
    const ctx = await setup();
    const a = await addAs(ctx, "rm@example.com");
    const b = await addAs(ctx, "keep@example.com", "Keep");
    const del = await call(ctx, "DELETE", `/seasons/${ctx.seasonId}/managers/${a.json.teamId}`, {
      as: ctx.commish,
    });
    expect(del.json).toEqual({ ok: true });
    expect(ctx.cognito.deleted).toEqual(["uuid-1"]);
    const season = await call(ctx, "GET", `/seasons/${ctx.seasonId}`, { as: ctx.commish });
    expect(season.json.teams.map((t: { teamId: string }) => t.teamId)).toEqual([b.json.teamId]);
    await call(ctx, "GET", "/me", { as: "keep@example.com" });
    const joined = await call(ctx, "DELETE", `/seasons/${ctx.seasonId}/managers/${b.json.teamId}`, {
      as: ctx.commish,
    });
    expect(joined.status).toBe(409);
    expect(joined.json.error.code).toBe("manager_joined");
    const none = await call(ctx, "DELETE", `/seasons/${ctx.seasonId}/managers/nope`, {
      as: ctx.commish,
    });
    expect(none.status).toBe(404);
  });
});

describe("authorization", () => {
  it("non-members get 403 on season routes; unknown seasons are 404", async () => {
    const ctx = await setup();
    expect(
      (await call(ctx, "GET", `/seasons/${ctx.seasonId}`, { as: "x@example.com" })).status,
    ).toBe(403);
    expect((await call(ctx, "GET", "/seasons/nope", { as: ctx.commish })).status).toBe(404);
  });

  it("managers (and non-members) get 403 on every managers route", async () => {
    const ctx = await setup();
    const added = await addAs(ctx, "mgr@example.com");
    await call(ctx, "GET", "/me", { as: "mgr@example.com" });
    const base = `/seasons/${ctx.seasonId}/managers`;
    for (const as of ["mgr@example.com", "outsider@example.com"]) {
      const calls = [
        call(ctx, "GET", base, { as }),
        call(ctx, "POST", base, {
          as,
          body: { firstName: "A", lastName: "B", email: "z@example.com" },
        }),
        call(ctx, "POST", `${base}/${added.json.teamId}/resend`, { as }),
        call(ctx, "PATCH", `${base}/${added.json.teamId}`, { as, body: { firstName: "Q" } }),
        call(ctx, "DELETE", `${base}/${added.json.teamId}`, { as }),
      ];
      for (const r of await Promise.all(calls)) expect(r.status).toBe(403);
    }
  });
});

describe("PII: member-facing JSON", () => {
  it("never contains email / firstName / lastName keys (season, me of a manager) or values", async () => {
    const ctx = await setup();
    await addAs(ctx, "alex.private@example.com", "Privatename");
    await addAs(ctx, "second@example.com", "Another");
    await call(ctx, "GET", "/me", { as: "alex.private@example.com" });
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) {
          keys.add(k);
          walk(x);
        }
    };
    const season = await call(ctx, "GET", `/seasons/${ctx.seasonId}`, {
      as: "alex.private@example.com",
    });
    walk(season.json);
    expect([...keys].sort()).toEqual(
      [
        "abbr",
        "isMine",
        "leagueId",
        "leagueName",
        "maxTeams",
        "myRole",
        "myTeamId",
        "name",
        "season",
        "seasonId",
        "status",
        "teamId",
        "teams",
        "year",
      ].sort(),
    );
    for (const k of ["email", "firstName", "lastName"]) expect(keys.has(k)).toBe(false);
    expect(JSON.stringify(season.json)).not.toMatch(/alex\.private|second@|Alex"/);
    // The season snapshot used by every other future route has no PRIVATE items either.
    const snap = await loadSeason(db, ctx.seasonId, { consistentRead: true });
    expect(JSON.stringify(snap)).not.toMatch(/alex\.private|second@example/);
    // /me of the manager shows only their own email (it is theirs).
    const me = await call(ctx, "GET", "/me", { as: "alex.private@example.com" });
    expect(JSON.stringify(me.json)).not.toContain("second@example.com");
  });
});

describe("test-only suppress path (docs/design/13 §7)", () => {
  const cfg = (APP_ENV: string) =>
    loadConfig({
      APP_ENV,
      APP_TABLE: "t",
      COGNITO_USER_POOL_ID: "us-east-2_abc123",
      COGNITO_CLIENT_ID: "c",
    });

  /** App with real-ish auth: the token decides the caller. */
  async function awsSetup(env: string, groups: string[]) {
    n++;
    const commish = `awsboss${n}@example.com`;
    const sub = `sub-${n}`;
    const r = await bootstrapLeague(db, {
      userId: sub,
      email: commish,
      leagueName: `AWS League ${n}`,
      year: 2026,
    });
    const cognito = fakeCognito();
    const app = createApp({
      config: cfg(env),
      db,
      cognito,
      now: () => clock,
      verifyToken: async () => ({ sub, email: commish, emailVerified: true, groups }),
    });
    const post = async (query: string, body: Json) => {
      const res = await app.request(`/api/seasons/${r.seasonId}/managers${query}`, {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as Json };
    };
    return { cognito, post, app, seasonId: r.seasonId };
  }
  const person = { firstName: "Alex", lastName: "Example", email: "fresh@example.com" };

  it("allowed: non-prod + test-users + flag + password -> SUPPRESS password passed, no email", async () => {
    for (const env of ["dev", "test"]) {
      const t = await awsSetup(env, ["test-users"]);
      const r = await t.post("?testSuppress=1", {
        ...person,
        testTemporaryPassword: "Temp-Pass-123",
      });
      expect(r.status, env).toBe(201);
      expect(r.json.emailSent).toBe(false);
      expect(t.cognito.invites[0]?.testSuppress).toEqual({ temporaryPassword: "Temp-Pass-123" });
    }
  });

  it.each([
    ["prod", ["test-users"], "?testSuppress=1", "prod environment"],
    ["dev", [], "?testSuppress=1", "caller not in test-users"],
    ["dev", ["other-group"], "?testSuppress=1", "wrong group"],
    ["dev", ["test-users"], "", "flag missing"],
    ["dev", ["test-users"], "?testSuppress=0", "flag not 1"],
  ])(
    "denied in %s (%j, %s): the password is ignored and a normal invite is sent (%s)",
    async (env, groups, query) => {
      const t = await awsSetup(env, groups);
      const r = await t.post(query, { ...person, testTemporaryPassword: "Temp-Pass-123" });
      expect(r.status).toBe(201);
      expect(r.json.emailSent).toBe(true);
      expect(t.cognito.invites[0]?.testSuppress).toBeUndefined();
    },
  );

  it("denied when the body password is missing (flag alone does nothing)", async () => {
    const t = await awsSetup("dev", ["test-users"]);
    const r = await t.post("?testSuppress=1", person);
    expect(r.json.emailSent).toBe(true);
    expect(t.cognito.invites[0]?.testSuppress).toBeUndefined();
  });

  it("resend in test mode sends nothing; in prod / non-test users it calls Cognito", async () => {
    const t = await awsSetup("dev", ["test-users"]);
    const added = await t.post("?testSuppress=1", {
      ...person,
      testTemporaryPassword: "Temp-Pass-123",
    });
    const url = `/api/seasons/${t.seasonId}/managers/${added.json.teamId}/resend`;
    const hdr = { authorization: "Bearer t" };
    const ok = await t.app.request(`${url}?testSuppress=1`, { method: "POST", headers: hdr });
    expect(ok.status).toBe(200);
    expect(t.cognito.resends).toHaveLength(0);
    await t.app.request(url, { method: "POST", headers: hdr });
    expect(t.cognito.resends).toHaveLength(1);

    const p = await awsSetup("prod", ["test-users"]);
    const a = await p.post("", person);
    await p.app.request(
      `/api/seasons/${p.seasonId}/managers/${a.json.teamId}/resend?testSuppress=1`,
      {
        method: "POST",
        headers: hdr,
      },
    );
    expect(p.cognito.resends).toHaveLength(1);
  });
});

describe("PATCH /teams/:seasonId/:teamId", () => {
  it("owner renames; other manager 403; commissioner renames (audited, ids only); duplicates 409", async () => {
    const ctx = await setup();
    const a = await addAs(ctx, "own@example.com", "Own");
    const b = await addAs(ctx, "oth@example.com", "Oth");
    await call(ctx, "GET", "/me", { as: "own@example.com" });
    await call(ctx, "GET", "/me", { as: "oth@example.com" });
    const url = (t: string) => `/teams/${ctx.seasonId}/${t}`;
    const ok = await call(ctx, "PATCH", url(a.json.teamId), {
      as: "own@example.com",
      body: { name: " Gridiron Gang " },
    });
    // Still the auto-default (Team Own -> OWN) so the abbreviation follows the name.
    expect(ok.json).toEqual({ teamId: a.json.teamId, name: "Gridiron Gang", abbr: "GRID" });
    expect(
      (
        await call(ctx, "PATCH", url(a.json.teamId), {
          as: "oth@example.com",
          body: { name: "Hijack" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(ctx, "PATCH", url(b.json.teamId), {
          as: ctx.commish,
          body: { name: "Commish Pick" },
        })
      ).status,
    ).toBe(200);
    const dup = await call(ctx, "PATCH", url(b.json.teamId), {
      as: ctx.commish,
      body: { name: "gridiron gang" },
    });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe("team_name_taken");
    expect(
      (await call(ctx, "PATCH", url(a.json.teamId), { as: "own@example.com", body: { name: " " } }))
        .status,
    ).toBe(400);
    const snap = await loadSeason(db, ctx.seasonId, { consistentRead: true });
    const renames = snap.audit.filter((x) => x.action === "team_renamed");
    expect(renames).toHaveLength(1);
    expect(renames[0]?.details).toEqual({ teamId: b.json.teamId });
  });
});

describe("team abbreviations", () => {
  const url = (ctx: Ctx, t: string) => `/teams/${ctx.seasonId}/${t}`;
  const abbrs = async (ctx: Ctx) => {
    const r = await call(ctx, "GET", `/seasons/${ctx.seasonId}`, { as: ctx.commish });
    return Object.fromEntries(
      (r.json.teams as { name: string; abbr: string }[]).map((t) => [t.name, t.abbr]),
    );
  };

  it("sets a default on creation (clashes get a digit) and exposes it on the season and managers", async () => {
    const ctx = await setup();
    const a = await addAs(ctx, "a@example.com", "Smith");
    await addAs(ctx, "b@example.com", "Smithers");
    expect(a.json.teamAbbr).toBe("SMIT");
    expect(await abbrs(ctx)).toEqual({ "Team Smith": "SMIT", "Team Smithers": "SMI2" });
    const list = await call(ctx, "GET", `/seasons/${ctx.seasonId}/managers`, { as: ctx.commish });
    expect(list.json.map((m: { teamAbbr: string }) => m.teamAbbr).sort()).toEqual(["SMI2", "SMIT"]);
  });

  it("lazily backfills teams stored without an abbreviation", async () => {
    const ctx = await setup();
    const a = await addAs(ctx, "a@example.com", "Alpha");
    const b = await addAs(ctx, "b@example.com", "Alphabet");
    for (const t of [a, b])
      await db.doc.send(
        new UpdateCommand({
          TableName: db.tableName,
          Key: teamKey(ctx.seasonId, t.json.teamId),
          UpdateExpression: "REMOVE abbr",
        }),
      );
    expect(await abbrs(ctx)).toEqual({ "Team Alpha": "ALPH", "Team Alphabet": "ALP2" });
    const raw = await db.doc.send(
      new GetCommand({ TableName: db.tableName, Key: teamKey(ctx.seasonId, a.json.teamId) }),
    );
    expect(raw.Item?.abbr).toBe("ALPH");
    // Stable on the next read.
    expect(await abbrs(ctx)).toEqual({ "Team Alpha": "ALPH", "Team Alphabet": "ALP2" });
  });

  it("a custom abbreviation is kept on rename; the auto-default follows the name", async () => {
    const ctx = await setup();
    const a = await addAs(ctx, "a@example.com", "Alpha");
    const b = await addAs(ctx, "b@example.com", "Beta");
    const custom = await call(ctx, "PATCH", url(ctx, a.json.teamId), {
      as: ctx.commish,
      body: { name: "Team Alpha", abbr: " zz9 " },
    });
    expect(custom.json).toEqual({ teamId: a.json.teamId, name: "Team Alpha", abbr: "ZZ9" });
    const kept = await call(ctx, "PATCH", url(ctx, a.json.teamId), {
      as: ctx.commish,
      body: { name: "Gridiron Gang" },
    });
    expect(kept.json.abbr).toBe("ZZ9");
    const followed = await call(ctx, "PATCH", url(ctx, b.json.teamId), {
      as: ctx.commish,
      body: { name: "Red Zone" },
    });
    expect(followed.json.abbr).toBe("REDZ");
  });

  it("409 team_abbr_taken (case-insensitive, same team allowed), 400 for a bad format", async () => {
    const ctx = await setup();
    const a = await addAs(ctx, "a@example.com", "Alpha");
    const b = await addAs(ctx, "b@example.com", "Beta");
    const dup = await call(ctx, "PATCH", url(ctx, b.json.teamId), {
      as: ctx.commish,
      body: { name: "Team Beta", abbr: "alph" },
    });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe("team_abbr_taken");
    const same = await call(ctx, "PATCH", url(ctx, a.json.teamId), {
      as: ctx.commish,
      body: { name: "Team Alpha", abbr: "ALPH" },
    });
    expect(same.status).toBe(200);
    for (const abbr of ["A", "ABCDE", "A-B", "é!"])
      expect(
        (
          await call(ctx, "PATCH", url(ctx, b.json.teamId), {
            as: ctx.commish,
            body: { name: "Team Beta", abbr },
          })
        ).status,
      ).toBe(400);
  });

  it("owner may edit, another manager gets 403, audit stays ids only", async () => {
    const ctx = await setup();
    const a = await addAs(ctx, "own@example.com", "Own");
    await addAs(ctx, "oth@example.com", "Oth");
    await call(ctx, "GET", "/me", { as: "own@example.com" });
    await call(ctx, "GET", "/me", { as: "oth@example.com" });
    const ok = await call(ctx, "PATCH", url(ctx, a.json.teamId), {
      as: "own@example.com",
      body: { name: "Team Own", abbr: "OWNR" },
    });
    expect(ok.json.abbr).toBe("OWNR");
    const no = await call(ctx, "PATCH", url(ctx, a.json.teamId), {
      as: "oth@example.com",
      body: { name: "Team Own", abbr: "HACK" },
    });
    expect(no.status).toBe(403);
    await call(ctx, "PATCH", url(ctx, a.json.teamId), {
      as: ctx.commish,
      body: { name: "Team Own", abbr: "BOSS" },
    });
    const snap = await loadSeason(db, ctx.seasonId, { consistentRead: true });
    const renames = snap.audit.filter((x) => x.action === "team_renamed");
    expect(renames).toHaveLength(1);
    expect(renames[0]?.details).toEqual({ teamId: a.json.teamId });
  });

  it("editing the pending manager's last name recomputes only a default abbreviation", async () => {
    const ctx = await setup();
    const a = await addAs(ctx, "a@example.com", "Alpha");
    const b = await addAs(ctx, "b@example.com", "Beta");
    await call(ctx, "PATCH", url(ctx, b.json.teamId), {
      as: ctx.commish,
      body: { name: "Team Beta", abbr: "KEEP" },
    });
    await call(ctx, "PATCH", `/seasons/${ctx.seasonId}/managers/${a.json.teamId}`, {
      as: ctx.commish,
      body: { lastName: "Gamma" },
    });
    await call(ctx, "PATCH", `/seasons/${ctx.seasonId}/managers/${b.json.teamId}`, {
      as: ctx.commish,
      body: { lastName: "Delta" },
    });
    expect(await abbrs(ctx)).toEqual({ "Team Gamma": "GAMM", "Team Delta": "KEEP" });
  });
});
