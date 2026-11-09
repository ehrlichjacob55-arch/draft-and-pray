/** End-to-end API checks against the Test League (docs/design/11 §3.4). */
import type { ApiClient } from "../lib/api";
import type { EnvConfig } from "../lib/env";
import { testUserEmail } from "../lib/env";
import { bootstrapTestLeague } from "../lib/test-league";
import type { Dynamo } from "@dnp/db";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
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

  const [c, u2, u3, outsider] = [1, 2, 3, 9].map(testUserEmail) as [string, string, string, string];
  const { seasonId } = await bootstrapTestLeague(cfg, db);
  const invites: string[] = [];
  const teams: Record<string, string> = {};

  await check("unauthenticated /me is rejected (AWS only)", async () => {
    if (cfg.env === "local") return "skipped locally (dev header fallback)";
    const r = await api.request("GET", "/me", { anonymous: true });
    expectEq(r.status, 401, "status");
  });
  await check("GET /me (commissioner)", async () => {
    const r = await api.request("GET", "/me", { as: c });
    expectEq(r.status, 200, "status");
    expectEq(r.json.user?.email, c, "email");
    const league = r.json.leagues.find((l: { name: string }) => l.name === "Test League");
    expectEq(league?.role, "commissioner", "role");
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
  await check("commissioner creates 3 invites", async () => {
    const r = await api.request("POST", `/seasons/${seasonId}/invites`, {
      as: c,
      body: { count: 3 },
    });
    expectEq(r.status, 201, "status");
    for (const i of r.json) invites.push(i.token);
    expectEq(invites.length, 3, "count");
    if (!String(r.json[0].url).includes(`/join/${invites[0]}`)) throw new Error("bad invite url");
  });
  await check("invite preview is public and valid", async () => {
    const r = await api.request("GET", `/invites/${invites[0]}`, { anonymous: true });
    expectEq(r.json.valid, true, "valid");
    expectEq(r.json.leagueName, "Test League", "leagueName");
  });
  await check("register binds the email; another email is 409 invite_bound", async () => {
    expectEq(
      (await api.request("POST", `/invites/${invites[0]}/register`, { body: { email: u2 } }))
        .status,
      200,
      "register",
    );
    const other = await api.request("POST", `/invites/${invites[0]}/register`, {
      body: { email: u3 },
    });
    expectEq(other.status, 409, "status");
    expectEq(other.json.error.code, "invite_bound", "code");
  });
  await check("preview masks the bound email", async () => {
    const r = await api.request("GET", `/invites/${invites[0]}`, { anonymous: true });
    expectEq(r.json.pendingEmail, `d***@example.com`, "pendingEmail");
  });
  await check("accept with the wrong email is 409 email_mismatch", async () => {
    const r = await api.request("POST", `/invites/${invites[0]}/accept`, {
      as: u3,
      body: { teamName: "Nope" },
    });
    expectEq(r.status, 409, "status");
    expectEq(r.json.error.code, "email_mismatch", "code");
  });
  await check("accept creates a team", async () => {
    const r = await api.request("POST", `/invites/${invites[0]}/accept`, {
      as: u2,
      body: { teamName: "Smoke Squad" },
    });
    expectEq(r.status, 200, "status");
    teams[u2] = r.json.teamId;
  });
  await check("reusing a used invite is 409 invite_used", async () => {
    const r = await api.request("POST", `/invites/${invites[0]}/accept`, {
      as: u2,
      body: { teamName: "Again" },
    });
    expectEq(r.json.error?.code, "invite_used", "code");
  });
  await check("second team for the same user is 409 already_has_team", async () => {
    await api.request("POST", `/invites/${invites[1]}/register`, { body: { email: u2 } });
    const r = await api.request("POST", `/invites/${invites[1]}/accept`, {
      as: u2,
      body: { teamName: "Second" },
    });
    expectEq(r.status, 409, "status");
    expectEq(r.json.error.code, "already_has_team", "code");
  });
  await check("duplicate team name (case-insensitive) is 409 team_name_taken", async () => {
    await api.request("POST", `/invites/${invites[2]}/register`, { body: { email: u3 } });
    const r = await api.request("POST", `/invites/${invites[2]}/accept`, {
      as: u3,
      body: { teamName: "SMOKE squad" },
    });
    expectEq(r.status, 409, "status");
    expectEq(r.json.error.code, "team_name_taken", "code");
  });
  await check("a second manager joins", async () => {
    const r = await api.request("POST", `/invites/${invites[2]}/accept`, {
      as: u3,
      body: { teamName: "Smoke Two" },
    });
    expectEq(r.status, 200, "status");
    teams[u3] = r.json.teamId;
  });
  await check("season shows teams, my team and role", async () => {
    const r = await api.request("GET", `/seasons/${seasonId}`, { as: u2 });
    expectEq(r.status, 200, "status");
    expectEq(r.json.teams.length, 2, "teams");
    expectEq(r.json.myTeamId, teams[u2], "myTeamId");
    expectEq(r.json.myRole, "manager", "myRole");
    expectEq(r.json.maxTeams, 9, "maxTeams");
  });
  await check("manager is forbidden on commissioner routes (403)", async () => {
    expectEq(
      (await api.request("GET", `/seasons/${seasonId}/invites`, { as: u2 })).status,
      403,
      "list",
    );
    expectEq(
      (await api.request("POST", `/seasons/${seasonId}/invites`, { as: u2, body: { count: 1 } }))
        .status,
      403,
      "create",
    );
  });
  await check("owner renames own team; others cannot (403)", async () => {
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
  });
  await check("commissioner renames any team", async () => {
    const r = await api.request("PATCH", `/teams/${seasonId}/${teams[u3]}`, {
      as: c,
      body: { name: "Commish Rename" },
    });
    expectEq(r.status, 200, "status");
  });
  await check("commissioner lists invites with statuses", async () => {
    const r = await api.request("GET", `/seasons/${seasonId}/invites`, { as: c });
    expectEq(r.status, 200, "status");
    const used = r.json.filter((i: { status: string }) => i.status === "used").length;
    expectEq(used, 2, "used invites");
  });
  await check("revoke: unused invite is revoked; a used one is 409", async () => {
    const created = await api.request("POST", `/seasons/${seasonId}/invites`, {
      as: c,
      body: { count: 1 },
    });
    const token = created.json[0].token as string;
    expectEq(
      (await api.request("DELETE", `/seasons/${seasonId}/invites/${token}`, { as: c })).status,
      200,
      "revoke",
    );
    const preview = await api.request("GET", `/invites/${token}`, { anonymous: true });
    expectEq(preview.json.reason, "revoked", "reason");
    const used = await api.request("DELETE", `/seasons/${seasonId}/invites/${invites[0]}`, {
      as: c,
    });
    expectEq(used.status, 409, "used revoke");
  });
  await check("invite limit: 9 teams max (409 season_full)", async () => {
    const r = await api.request("POST", `/seasons/${seasonId}/invites`, {
      as: c,
      body: { count: 9 },
    });
    expectEq(r.status, 409, "status");
    expectEq(r.json.error.code, "season_full", "code");
  });
  return results;
}
