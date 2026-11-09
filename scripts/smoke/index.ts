import { parseCli } from "../lib/args";
import { createApiClient } from "../lib/api";
import { assertTestEnv, resolveEnvConfig, testUserEmail } from "../lib/env";
import { ensureLocalTable, openDb, readTestUsers, type TestUser } from "../lib/runtime";
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

  // Start from a clean Test League so the run is repeatable.
  const reset = await resetTestLeague(db);
  console.log(
    `Reset Test League (${reset.itemsDeleted} items); running smoke against ${cfg.baseUrl} (${env})`,
  );
  const results = await runChecks(cfg, db, api);
  console.log(renderTable(results));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
