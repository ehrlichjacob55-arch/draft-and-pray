/**
 * `draft-league setup`: gets a league to "ready to start" for testing: 9 joined teams, a seeded
 * pool, and the draft order set. Test League (test users) or, locally, a scratch league.
 */
import { bootstrapLeague, localSub, type Dynamo } from "@dnp/db";
import type { ApiClient } from "./api";
import { importRealPool, importSyntheticPool } from "./pool";
import { seedTestLeague } from "./test-league";
import { testUserEmail, type EnvConfig } from "./env";
import type { TestUser } from "./runtime";

export type PoolKind = "real" | "synthetic";

export interface SetupOptions {
  pool: PoolKind;
  /** NFL season to import from (real pool). */
  poolYear: number;
  /** Local scratch league (any `@local.test` commissioner); default is the Test League. */
  scratch?: { email: string; league: string; year: number };
}

export interface SetupResult {
  seasonId: string;
  teams: number;
  players: number;
  order: string[];
}

/** Default `--pool`: real for dev/test, synthetic for local. */
export const defaultPoolKind = (env: string): PoolKind => (env === "local" ? "synthetic" : "real");

export async function setupDraftLeague(
  cfg: EnvConfig,
  db: Dynamo,
  api: ApiClient,
  users: TestUser[],
  opts: SetupOptions,
): Promise<SetupResult> {
  let seasonId: string;
  let commissioner: string;
  if (opts.scratch) {
    if (cfg.env !== "local") throw new Error("A scratch league is only supported with --env local");
    const { email, league, year } = opts.scratch;
    if (!email.endsWith("@local.test"))
      throw new Error("Scratch commissioners must be @local.test");
    ({ seasonId } = await bootstrapLeague(db, {
      userId: localSub(email),
      email,
      leagueName: league,
      year,
    }));
    commissioner = email;
    const slug = league
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 24);
    const emails = [email, ...Array.from({ length: 8 }, (_, i) => `${slug}-m${i + 1}@local.test`)];
    const existing = await api.request("GET", `/seasons/${seasonId}/managers`, { as: email });
    const have = new Set((existing.json as { email: string }[]).map((m) => m.email));
    for (const [i, e] of emails.entries()) {
      if (have.has(e)) continue;
      const r = await api.request("POST", `/seasons/${seasonId}/managers`, {
        as: email,
        body: { firstName: "Scratch", lastName: `Manager${i + 1}`, email: e },
      });
      if (r.status !== 201)
        throw new Error(`add manager failed: ${r.status} ${r.json?.error?.code}`);
    }
    for (const e of emails) await api.request("GET", "/me", { as: e });
  } else {
    ({ seasonId } = await seedTestLeague(cfg, db, api, users));
    commissioner = testUserEmail(1);
  }

  const pool = await (opts.pool === "real"
    ? importRealPool(db, seasonId, opts.poolYear)
    : importSyntheticPool(db, seasonId, opts.poolYear));

  const season = await api.request("GET", `/seasons/${seasonId}`, { as: commissioner });
  if (season.status !== 200) throw new Error(`GET season failed: ${season.status}`);
  const teams = season.json.teams as { teamId: string }[];
  if (teams.length !== 9) throw new Error(`Expected 9 teams, found ${teams.length}`);
  const order = teams.map((t) => t.teamId);
  const set = await api.request("PUT", `/seasons/${seasonId}/draft/order`, {
    as: commissioner,
    body: { order },
  });
  if (set.status !== 200)
    throw new Error(
      `set order failed: ${set.status} ${set.json?.error?.code} (reset the draft first?)`,
    );
  return { seasonId, teams: teams.length, players: pool.players, order };
}
