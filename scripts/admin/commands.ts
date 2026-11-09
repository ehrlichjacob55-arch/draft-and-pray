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
import { resetTestLeague, seedTestLeague } from "../lib/test-league";
import { bootstrapLeague } from "@dnp/db";

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
