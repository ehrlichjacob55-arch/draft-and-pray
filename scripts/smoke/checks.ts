/**
 * End-to-end API checks against the Test League (docs/design/11 §3.4, 13 §7): the commissioner
 * adds managers, existing test users are auto-claimed on their next /me, and fresh
 * `dnp-new-*` users go through the real invitation sign-in (AWS only).
 */
import { randomBytes } from "node:crypto";
import { loadSeason, type Dynamo } from "@dnp/db";
import { generatePassword, generateTemporaryPassword } from "../../apps/api/src/cognito";
import type { ApiClient } from "../lib/api";
import type { EnvConfig } from "../lib/env";
import { newTestUserEmail, testUserEmail } from "../lib/env";
import { openCognito, requirePool, signInNewUser } from "../lib/runtime";
import { bootstrapTestLeague } from "../lib/test-league";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** Keys that must never appear in a member-facing response (docs/design/13 §6). */
const PII_KEYS = ["email", "firstName", "lastName"];

function collectKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => collectKeys(v, into));
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      collectKeys(v, into);
    }
  return into;
}

export async function runChecks(
  cfg: EnvConfig,
  db: Dynamo,
  api: ApiClient,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const check = async (name: string, fn: () => Promise<string | void>) => {
    try {
      results.push({ name, ok: true, detail: (await fn()) ?? "" });
    } catch (err) {
      results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  };
  const expectEq = (actual: unknown, expected: unknown, what: string) => {
    if (actual !== expected)
      throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`);
  };

  const isAws = cfg.env !== "local";
  const [c, u2, u3, u4, u5, u6, u7, u8, outsider] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(
    testUserEmail,
  ) as [string, string, string, string, string, string, string, string, string];
  const run = randomBytes(4).toString("hex");
  const [new1, new2, new3] = [1, 2, 3].map((i) => newTestUserEmail(run, i)) as [
    string,
    string,
    string,
  ];
  const { seasonId } = await bootstrapTestLeague(cfg, db);
  const base = `/seasons/${seasonId}/managers`;
  const teams: Record<string, string> = {};
  const add = (as: string, email: string, lastName: string, query = "", extra = {}) =>
    api.request("POST", `${base}${query}`, {
      as,
      body: { firstName: "Test", lastName, email, ...extra },
    });

  await check("unauthenticated /me is rejected (AWS only)", async () => {
    if (!isAws) return "skipped locally (dev header fallback)";
    expectEq((await api.request("GET", "/me", { anonymous: true })).status, 401, "status");
  });
  await check("removed invite routes are gone (401/404)", async () => {
    const r = await api.request("GET", "/invites/anything", { anonymous: true });
    if (r.status !== 401 && r.status !== 404) throw new Error(`status ${r.status}`);
  });
  await check("GET /me (commissioner)", async () => {
    const r = await api.request("GET", "/me", { as: c });
    expectEq(r.status, 200, "status");
    expectEq(r.json.user?.email, c, "email");
    expectEq(
      r.json.leagues.find((l: { name: string }) => l.name === "Test League")?.role,
      "commissioner",
      "role",
    );
    expectEq(r.json.justClaimed.length, 0, "justClaimed");
  });
  await check("GET /me (non-member has no leagues)", async () => {
    const r = await api.request("GET", "/me", { as: outsider });
    expectEq(r.status, 200, "status");
    expectEq(r.json.leagues.length, 0, "leagues");
  });
  await check("non-member cannot read the season (403)", async () => {
    expectEq(
      (await api.request("GET", `/seasons/${seasonId}`, { as: outsider })).status,
      403,
      "status",
    );
  });
  await check("non-member gets 403 on every managers route", async () => {
    const as = outsider;
    const calls = await Promise.all([
      api.request("GET", base, { as }),
      add(as, "someone@example.com", "Nobody"),
      api.request("POST", `${base}/x/resend`, { as }),
      api.request("PATCH", `${base}/x`, { as, body: { firstName: "Q" } }),
      api.request("DELETE", `${base}/x`, { as }),
    ]);
    calls.forEach((r, i) => expectEq(r.status, 403, `route ${i}`));
  });

  await check(
    "commissioner adds a manager: Team <LastName>, invited, no email for a known account",
    async () => {
      const r = await add(c, u2, "Alpha");
      expectEq(r.status, 201, "status");
      expectEq(r.json.teamName, "Team Alpha", "teamName");
      expectEq(r.json.status, "invited", "status field");
      expectEq(r.json.claimedAt, null, "claimedAt");
      if (isAws) expectEq(r.json.emailSent, false, "emailSent (existing account)");
      teams[u2] = r.json.teamId;
    },
  );
  await check("same last name gets a numeric suffix (Team Alpha 2)", async () => {
    const r = await add(c, u3, "Alpha");
    expectEq(r.status, 201, "status");
    expectEq(r.json.teamName, "Team Alpha 2", "teamName");
    teams[u3] = r.json.teamId;
  });
  await check("the same email twice is 409 email_already_added", async () => {
    const r = await add(c, u2.toUpperCase(), "Again");
    expectEq(r.status, 409, "status");
    expectEq(r.json.error.code, "email_already_added", "code");
  });
  await check(
    "an added manager is not a league member until the first /me (403 on the season)",
    async () => {
      expectEq(
        (await api.request("GET", `/seasons/${seasonId}`, { as: u2 })).status,
        403,
        "status",
      );
    },
  );
  await check("next /me auto-claims the team (justClaimed once)", async () => {
    const first = await api.request("GET", "/me", { as: u2 });
    expectEq(first.status, 200, "status");
    expectEq(first.json.justClaimed.length, 1, "justClaimed");
    expectEq(first.json.justClaimed[0].teamId, teams[u2], "teamId");
    expectEq(first.json.justClaimed[0].teamName, "Team Alpha", "teamName");
    expectEq(first.json.leagues[0]?.role, "manager", "role");
    expectEq(
      (await api.request("GET", "/me", { as: u2 })).json.justClaimed.length,
      0,
      "second /me",
    );
    const second = await api.request("GET", "/me", { as: u3 });
    expectEq(second.json.justClaimed.length, 1, "u3 justClaimed");
  });
  await check("season shows teams, my team and role", async () => {
    const r = await api.request("GET", `/seasons/${seasonId}`, { as: u2 });
    expectEq(r.status, 200, "status");
    expectEq(r.json.teams.length, 2, "teams");
    expectEq(r.json.myTeamId, teams[u2], "myTeamId");
    expectEq(r.json.myRole, "manager", "myRole");
    expectEq(r.json.maxTeams, 9, "maxTeams");
    const mine = r.json.teams.filter((t: { isMine: boolean }) => t.isMine);
    expectEq(mine.length, 1, "isMine count");
  });
  await check("member-facing season response has no PII (keys or values)", async () => {
    const r = await api.request("GET", `/seasons/${seasonId}`, { as: u2 });
    const keys = collectKeys(r.json);
    for (const k of PII_KEYS) if (keys.has(k)) throw new Error(`response has key ${k}`);
    if (keys.has("managerDisplayName") || keys.has("managerUserId"))
      throw new Error("response still has manager fields");
    const text = JSON.stringify(r.json);
    for (const v of [u2, u3])
      if (text.includes(v)) throw new Error("response contains a manager value");
    expectEq(
      [...collectKeys(r.json.teams)].sort().join(","),
      "abbr,isMine,name,teamId",
      "team keys",
    );
  });
  await check("manager is forbidden on every managers route (403)", async () => {
    const as = u2;
    const calls = await Promise.all([
      api.request("GET", base, { as }),
      add(as, "someone@example.com", "Nobody"),
      api.request("POST", `${base}/${teams[u3]}/resend`, { as }),
      api.request("PATCH", `${base}/${teams[u3]}`, { as, body: { firstName: "Q" } }),
      api.request("DELETE", `${base}/${teams[u3]}`, { as }),
    ]);
    calls.forEach((r, i) => expectEq(r.status, 403, `route ${i}`));
  });
  await check("manager renames own team; others cannot (403)", async () => {
    const ok = await api.request("PATCH", `/teams/${seasonId}/${teams[u2]}`, {
      as: u2,
      body: { name: "Renamed Squad" },
    });
    expectEq(ok.status, 200, "owner");
    const no = await api.request("PATCH", `/teams/${seasonId}/${teams[u2]}`, {
      as: u3,
      body: { name: "Hijack" },
    });
    expectEq(no.status, 403, "other manager");
    const dup = await api.request("PATCH", `/teams/${seasonId}/${teams[u3]}`, {
      as: u3,
      body: { name: "RENAMED squad" },
    });
    expectEq(dup.status, 409, "duplicate name");
    expectEq(dup.json.error.code, "team_name_taken", "code");
  });
  await check("commissioner renames any team", async () => {
    const r = await api.request("PATCH", `/teams/${seasonId}/${teams[u3]}`, {
      as: c,
      body: { name: "Commish Rename" },
    });
    expectEq(r.status, 200, "status");
  });
  await check("resend / edit / remove are refused once joined (409 manager_joined)", async () => {
    const calls = await Promise.all([
      api.request("POST", `${base}/${teams[u2]}/resend`, { as: c }),
      api.request("PATCH", `${base}/${teams[u2]}`, { as: c, body: { firstName: "Late" } }),
      api.request("DELETE", `${base}/${teams[u2]}`, { as: c }),
    ]);
    for (const [i, r] of calls.entries()) {
      expectEq(r.status, 409, `route ${i} status`);
      expectEq(r.json.error.code, "manager_joined", `route ${i} code`);
    }
  });
  await check("commissioner lists managers with status joined/invited", async () => {
    const r = await api.request("GET", base, { as: c });
    expectEq(r.status, 200, "status");
    expectEq(r.json.filter((m: { status: string }) => m.status === "joined").length, 2, "joined");
    const row = r.json.find((m: { teamId: string }) => m.teamId === teams[u2]);
    expectEq(row.email, u2, "email (commissioner only)");
    expectEq(row.teamName, "Renamed Squad", "teamName");
  });

  // ---- Fresh "new user" path (13 §7): invite with a test-only temporary password ----
  const tempPassword = generateTemporaryPassword();
  await check("add a fresh dnp-new user (test suppress: no email, invited)", async () => {
    const r = await add(c, new1, "Newcomer", "?testSuppress=1", {
      testTemporaryPassword: tempPassword,
    });
    expectEq(r.status, 201, "status");
    expectEq(r.json.emailSent, false, "emailSent");
    expectEq(r.json.status, "invited", "status field");
    teams[new1] = r.json.teamId;
  });
  await check("resend works while not joined (test mode sends nothing)", async () => {
    const r = await api.request("POST", `${base}/${teams[new1]}/resend?testSuppress=1`, { as: c });
    expectEq(r.status, 200, "status");
    expectEq(r.json.status, "invited", "status field");
  });
  await check("edit while not joined: name change renames the default team", async () => {
    const r = await api.request("PATCH", `${base}/${teams[new1]}`, {
      as: c,
      body: { lastName: "Newer" },
    });
    expectEq(r.status, 200, "status");
    expectEq(r.json.teamName, "Team Newer", "teamName");
  });
  const newPassword = generatePassword();
  const tempPassword2 = generateTemporaryPassword();
  await check("edit while not joined: email change re-invites the new address", async () => {
    const r = await api.request("PATCH", `${base}/${teams[new1]}?testSuppress=1`, {
      as: c,
      body: { email: new2, testTemporaryPassword: tempPassword2 },
    });
    expectEq(r.status, 200, "status");
    expectEq(r.json.email, new2, "email");
    expectEq(r.json.emailSent, false, "emailSent");
  });
  await check("remove while not joined deletes the team (and its pending user)", async () => {
    const created = await add(c, new3, "Removed", "?testSuppress=1", {
      testTemporaryPassword: generateTemporaryPassword(),
    });
    expectEq(created.status, 201, "add");
    const r = await api.request("DELETE", `${base}/${created.json.teamId}`, { as: c });
    expectEq(r.status, 200, "status");
    const list = await api.request("GET", base, { as: c });
    if (list.json.some((m: { teamId: string }) => m.teamId === created.json.teamId))
      throw new Error("manager still listed");
  });
  await check(
    "new user signs in with the temporary password, sets a password, /me auto-claims",
    async () => {
      if (isAws) {
        const { clientId } = requirePool(cfg);
        const token = await signInNewUser(openCognito(cfg), clientId, {
          email: new2,
          temporaryPassword: tempPassword2,
          newPassword,
        });
        api.useToken(new2, token);
      }
      const me = await api.request("GET", "/me", { as: new2 });
      expectEq(me.status, 200, "status");
      expectEq(me.json.justClaimed.length, 1, "justClaimed");
      expectEq(me.json.justClaimed[0].teamName, "Team Newer", "teamName");
      expectEq(me.json.user.displayName, "Test", "displayName (first name)");
      const rename = await api.request("PATCH", `/teams/${seasonId}/${teams[new1]}`, {
        as: new2,
        body: { name: "Fresh Start" },
      });
      expectEq(rename.status, 200, "rename");
    },
  );
  await check("the old temporary password no longer works (AWS only)", async () => {
    if (!isAws) return "skipped locally";
    const { clientId } = requirePool(cfg);
    let signedIn = true;
    try {
      await signInNewUser(openCognito(cfg), clientId, {
        email: new2,
        temporaryPassword: tempPassword,
        newPassword: generatePassword(),
      });
    } catch {
      signedIn = false;
    }
    expectEq(signedIn, false, "signed in with a stale code");
  });

  // ---- 9-team limit ----
  await check(
    "limit: 9 teams max (409 season_full); the commissioner can add themselves",
    async () => {
      // Teams now: u2, u3, new1/new2 = 3. Add 5 more existing test users, then the commissioner.
      for (const [i, email] of [u4, u5, u6, u7, u8].entries()) {
        const r = await add(c, email, `Fill${i}`);
        expectEq(r.status, 201, `fill ${email}`);
      }
      const self = await add(c, c, "Boss");
      expectEq(self.status, 201, "self");
      const tenth = await add(c, outsider, "Tenth");
      expectEq(tenth.status, 409, "10th status");
      expectEq(tenth.json.error.code, "season_full", "10th code");
      const me = await api.request("GET", "/me", { as: c });
      expectEq(me.json.justClaimed.length, 1, "commissioner claim");
      expectEq(
        me.json.leagues.find((l: { name: string }) => l.name === "Test League")?.role,
        "commissioner",
        "role stays commissioner",
      );
    },
  );
  await check("audit events carry ids only (no email / name)", async () => {
    const snap = await loadSeason(db, seasonId, { consistentRead: true });
    const manager = snap.audit.filter((a) => a.action.startsWith("manager_"));
    if (manager.length < 5) throw new Error(`expected manager audit events, got ${manager.length}`);
    const text = JSON.stringify(snap.audit);
    if (/@example\.com|Newcomer|Newer|Alpha/.test(text)) throw new Error("audit has PII");
    return `${manager.length} manager events`;
  });
  return results;
}
