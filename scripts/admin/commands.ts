import { normalizeEmail } from "@dnp/contract";
import { localSub } from "@dnp/db";
import { ensureCognitoUser, generatePassword } from "../../apps/api/src/cognito";
import { createApiClient } from "../lib/api";
import { parseCli } from "../lib/args";
import {
  TEST_GROUP,
  assertTestEnv,
  parseEnv,
  resolveEnvConfig,
  testUserEmail,
  type EnvConfig,
  type EnvFlags,
} from "../lib/env";
import {
  addToGroup,
  deleteCognitoUser,
  deleteTestUsersParam,
  ensureLocalTable,
  openCognito,
  openDb,
  readTestUsers,
  requirePool,
  writeTestUsers,
  type TestUser,
} from "../lib/runtime";
import { defaultPoolKind, setupDraftLeague, type PoolKind } from "../lib/draft-league";
import { importCsvPool, importRealPool, importSyntheticPool, resolveSeasonId } from "../lib/pool";
import { resetTestLeague, seedTestLeague } from "../lib/test-league";
import { bootstrapLeague, seedBuiltinRuleset } from "@dnp/db";
import { BUILTIN_RULESETS, type BuiltinRulesetName } from "@dnp/domain";

export interface Deps {
  resolveConfig: (env: ReturnType<typeof parseEnv>, flags: EnvFlags) => EnvConfig;
  log: (line: string) => void;
}

export const defaultDeps: Deps = {
  resolveConfig: (env, flags) => resolveEnvConfig(env, flags),
  log: (line) => console.log(line),
};

const USAGE = `Usage: pnpm admin <command> [flags]
  bootstrap-league --env <local|dev|test|prod> --email <email> --league "<name>" --year 2026
  test-users create|delete --env <dev|test> [--count 9]
  test-league seed|reset --env <local|dev|test>   (seed: the commissioner adds managers; reset also deletes dnp-new-* users)
  import-pool --env <env> --season-year <nfl year> (--season-id <id> | --test-league | --email <commissioner> --league "<name>" [--year 2026])
      Imports the playoff field + players from ESPN and Sleeper. Emergency fallback: --from-csv --teams t.csv --players p.csv
  seed-pool --env <local|dev|test> --season-year 2026 (same season selection)   (synthetic fictional pool; refuses prod)
  seed-ruleset --env <local|dev|test> [--ruleset league|placeholder] (same season selection)   (default league; seeds v1 unlocked, skips if v1 exists; refuses prod)
  draft-league setup --env <local|dev|test> [--pool real|synthetic] [--season-year 2025]
      9 joined teams + pool + draft order. Test League by default; locally add --email x@local.test --league "<new name>" for a scratch league
Common overrides: --table, --user-pool-id, --client-id, --base-url, --region`;

export async function runAdmin(argv: string[], deps: Deps = defaultDeps): Promise<void> {
  const { flags, positionals } = parseCli(argv);
  const [command, sub] = positionals;
  switch (command) {
    case "bootstrap-league":
      return bootstrap(flags, deps);
    case "test-users":
      return testUsers(sub, flags, deps);
    case "test-league":
      return testLeague(sub, flags, deps);
    case "import-pool":
      return importPoolCommand(flags, deps);
    case "seed-pool":
      return seedPoolCommand(flags, deps);
    case "seed-ruleset":
      return seedRulesetCommand(flags, deps);
    case "draft-league":
      return draftLeague(sub, flags, deps);
    default:
      throw new Error(USAGE);
  }
}

async function bootstrap(flags: ReturnType<typeof parseCli>["flags"], deps: Deps) {
  const env = parseEnv(flags.env);
  if (!flags.email || !flags.league || !flags.year)
    throw new Error("bootstrap-league needs --email, --league and --year");
  const year = Number(flags.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100)
    throw new Error("--year must be a year");
  const email = normalizeEmail(flags.email);
  const cfg = deps.resolveConfig(env, flags);
  const db = openDb(cfg);

  let userId: string;
  if (env === "local") {
    await ensureLocalTable(db);
    userId = localSub(email);
  } else {
    const { userPoolId } = requirePool(cfg);
    ({ sub: userId } = await ensureCognitoUser(openCognito(cfg), userPoolId, email));
  }
  const r = await bootstrapLeague(db, { userId, email, leagueName: flags.league, year });
  deps.log(
    `${r.created ? "Created" : "Already set up"}: league ${r.leagueId} season ${r.seasonId} (${year}) in ${env}; commissioner ${email}`,
  );
}

async function testUsers(
  sub: string | undefined,
  flags: ReturnType<typeof parseCli>["flags"],
  deps: Deps,
) {
  const env = assertTestEnv(flags.env, false); // refuses prod before anything else
  if (sub !== "create" && sub !== "delete") throw new Error("test-users needs create|delete");
  const cfg = deps.resolveConfig(env, flags);
  const { userPoolId } = requirePool(cfg);
  const cognito = openCognito(cfg);

  if (sub === "create") {
    const count = Number(flags.count ?? 9);
    if (!Number.isInteger(count) || count < 1 || count > 99)
      throw new Error("--count must be 1..99");
    const users: TestUser[] = [];
    for (let i = 1; i <= count; i++) {
      const user = { email: testUserEmail(i), password: generatePassword() };
      await ensureCognitoUser(cognito, userPoolId, user.email, { password: user.password });
      await addToGroup(cognito, userPoolId, user.email, TEST_GROUP);
      users.push(user);
      deps.log(`ready: ${user.email}`);
    }
    await writeTestUsers(cfg, users);
    deps.log(`Stored ${users.length} credentials in SSM /dnp/${env}/test-users`);
  } else {
    let emails: string[];
    try {
      emails = (await readTestUsers(cfg)).map((u) => u.email);
    } catch {
      emails = Array.from({ length: Number(flags.count ?? 9) }, (_, i) => testUserEmail(i + 1));
    }
    for (const email of emails) {
      await deleteCognitoUser(cognito, userPoolId, email);
      deps.log(`deleted: ${email}`);
    }
    await deleteTestUsersParam(cfg);
    deps.log(`Removed SSM /dnp/${env}/test-users`);
  }
}

/** AWS envs only: the client + pool used to delete `dnp-new-*` smoke users. */
function cognitoFor(env: string, cfg: EnvConfig) {
  return env === "local"
    ? undefined
    : { client: openCognito(cfg), userPoolId: requirePool(cfg).userPoolId };
}

async function testLeague(
  sub: string | undefined,
  flags: ReturnType<typeof parseCli>["flags"],
  deps: Deps,
) {
  const env = assertTestEnv(flags.env, true); // refuses prod before anything else
  if (sub !== "seed" && sub !== "reset") throw new Error("test-league needs seed|reset");
  const cfg = deps.resolveConfig(env, flags);
  const db = openDb(cfg);
  if (env === "local") await ensureLocalTable(db);

  if (sub === "reset") {
    const r = await resetTestLeague(db, { cognito: cognitoFor(env, cfg) });
    deps.log(
      `Reset: ${r.leaguesDeleted} league(s), ${r.itemsDeleted} item(s), ${r.cognitoUsersDeleted} dnp-new Cognito user(s) deleted`,
    );
    return;
  }
  const users: TestUser[] =
    env === "local"
      ? Array.from({ length: 9 }, (_, i) => ({ email: testUserEmail(i + 1), password: "" }))
      : await readTestUsers(cfg);
  const api = createApiClient(cfg, users);
  const r = await seedTestLeague(cfg, db, api, users, cognitoFor(env, cfg));
  deps.log(
    `Seeded Test League season ${r.seasonId}: ${r.added} managers added, ${r.alreadyAdded} already added, ${r.claimed} teams claimed`,
  );
}

function seasonYearFlag(flags: ReturnType<typeof parseCli>["flags"], fallback: number): number {
  const year = Number(flags["season-year"] ?? fallback);
  if (!Number.isInteger(year) || year < 2000 || year > 2100)
    throw new Error("--season-year must be a year");
  return year;
}

async function prepare(
  flags: ReturnType<typeof parseCli>["flags"],
  deps: Deps,
  env: ReturnType<typeof parseEnv>,
) {
  const cfg = deps.resolveConfig(env, flags);
  const db = openDb(cfg);
  if (env === "local") await ensureLocalTable(db);
  const seasonId = await resolveSeasonId(db, flags);
  return { cfg, db, seasonId };
}

/** Real import (ESPN + Sleeper), or `--from-csv`. The importer refuses while the draft runs. */
async function importPoolCommand(flags: ReturnType<typeof parseCli>["flags"], deps: Deps) {
  const env = parseEnv(flags.env);
  const year = seasonYearFlag(flags, 2025);
  const { db, seasonId } = await prepare(flags, deps, env);
  let counts;
  if (flags["from-csv"]) {
    if (!flags.teams || !flags.players) throw new Error("--from-csv needs --teams and --players");
    counts = await importCsvPool(db, seasonId, year, flags.teams, flags.players);
  } else {
    counts = await importRealPool(db, seasonId, year);
  }
  deps.log(
    `Imported pool into ${seasonId} (${env}): ${counts.teams} teams, ${counts.players} players ` +
      `(${counts.added} added, ${counts.updated} updated, ${counts.removed} removed)`,
  );
}

async function seedPoolCommand(flags: ReturnType<typeof parseCli>["flags"], deps: Deps) {
  const env = assertTestEnv(flags.env, true); // refuses prod before anything else
  const year = seasonYearFlag(flags, 2026);
  const { db, seasonId } = await prepare(flags, deps, env);
  const counts = await importSyntheticPool(db, seasonId, year);
  deps.log(
    `Seeded synthetic pool into ${seasonId} (${env}): ${counts.teams} teams, ${counts.players} players`,
  );
}

async function seedRulesetCommand(flags: ReturnType<typeof parseCli>["flags"], deps: Deps) {
  const env = assertTestEnv(flags.env, true); // refuses prod before anything else
  const name = (flags.ruleset ?? "league") as BuiltinRulesetName;
  if (!Object.hasOwn(BUILTIN_RULESETS, name))
    throw new Error(`--ruleset must be one of: ${Object.keys(BUILTIN_RULESETS).join(", ")}`);
  const { db, seasonId } = await prepare(flags, deps, env);
  const r = await seedBuiltinRuleset(db, { seasonId, name });
  deps.log(
    r.created
      ? `Seeded ruleset v1 (${name}.v1.json) into ${seasonId} (${env})`
      : `Ruleset v1 already exists in ${seasonId} (${env}); nothing changed`,
  );
}

async function draftLeague(
  sub: string | undefined,
  flags: ReturnType<typeof parseCli>["flags"],
  deps: Deps,
) {
  const env = assertTestEnv(flags.env, true); // refuses prod before anything else
  if (sub !== "setup") throw new Error("draft-league needs setup");
  const pool = (flags.pool ?? defaultPoolKind(env)) as PoolKind;
  if (pool !== "real" && pool !== "synthetic") throw new Error("--pool must be real or synthetic");
  const poolYear = seasonYearFlag(flags, pool === "real" ? 2025 : 2026);
  const cfg = deps.resolveConfig(env, flags);
  const db = openDb(cfg);
  if (env === "local") await ensureLocalTable(db);
  const users: TestUser[] =
    env === "local"
      ? Array.from({ length: 9 }, (_, i) => ({ email: testUserEmail(i + 1), password: "" }))
      : await readTestUsers(cfg);
  const api = createApiClient(cfg, users);
  const scratch =
    flags.league || flags.email
      ? {
          email: normalizeEmail(flags.email ?? ""),
          league: flags.league ?? "",
          year: Number(flags.year ?? 2026),
        }
      : undefined;
  if (scratch && (!flags.email || !flags.league))
    throw new Error("A scratch league needs both --email and --league");
  const r = await setupDraftLeague(cfg, db, api, users, { pool, poolYear, scratch });
  deps.log(
    `Draft league ready (${env}): season ${r.seasonId}, ${r.teams} teams, ${r.players} pool players, order set`,
  );
}
