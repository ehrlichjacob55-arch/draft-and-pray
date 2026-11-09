import { parseCli } from "../lib/args";
import { createApiClient } from "../lib/api";
import { assertTestEnv, resolveEnvConfig, testUserEmail } from "../lib/env";
import {
  deleteNewTestCognitoUsers,
  ensureLocalTable,
  openCognito,
  openDb,
  readTestUsers,
  requirePool,
  type TestUser,
} from "../lib/runtime";
import { resetTestLeague } from "../lib/test-league";
import { runChecks, type CheckResult } from "./checks";

export function renderTable(results: CheckResult[]): string {
  const width = Math.max(...results.map((r) => r.name.length));
  return results
    .map((r) =>
      `${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.ok ? r.detail : r.detail}`.trimEnd(),
    )
    .join("\n");
}

async function main() {
  const { flags } = parseCli(process.argv.slice(2));
  const env = assertTestEnv(flags.env, true); // refuses prod before anything else
  const cfg = resolveEnvConfig(env, flags);
  const db = openDb(cfg);
  if (env === "local") await ensureLocalTable(db);
  const users: TestUser[] =
    env === "local"
      ? Array.from({ length: 9 }, (_, i) => ({ email: testUserEmail(i + 1), password: "" }))
      : await readTestUsers(cfg);
  const api = createApiClient(cfg, users);

  const cognito =
    env === "local"
      ? undefined
      : { client: openCognito(cfg), userPoolId: requirePool(cfg).userPoolId };

  // Start from a clean Test League so the run is repeatable.
  const reset = await resetTestLeague(db, { cognito });
  console.log(
    `Reset Test League (${reset.itemsDeleted} items); running smoke against ${cfg.baseUrl} (${env})`,
  );
  let results;
  try {
    results = await runChecks(cfg, db, api);
  } finally {
    // The dnp-new-* Cognito users exist only for this run (their league data is cleared by the next reset).
    if (cognito) {
      const gone = await deleteNewTestCognitoUsers(cognito.client, cognito.userPoolId).catch(
        (err: unknown) => {
          console.error("Cleanup failed:", err instanceof Error ? err.message : err);
          return [];
        },
      );
      console.log(`Cleaned up ${gone.length} dnp-new Cognito user(s)`);
    }
  }
  console.log(renderTable(results));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
