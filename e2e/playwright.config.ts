import { defineConfig, devices } from "@playwright/test";

/**
 * Local end-to-end test. It starts NOTHING itself: it expects `pnpm dev` (DynamoDB Local + api + web)
 * to be running and a local league to be bootstrapped:
 *
 *   pnpm admin bootstrap-league --env local --email commish@local.test --league "Local League" --year 2026
 *
 * Each run adds two teams to the persistent local DB (9-team cap); wipe .dynamodb-local/data and re-bootstrap
 * after ~4 runs.
 *
 * live-draft.spec.ts creates its own scratch league (`pnpm admin draft-league setup --env local ...`), so it
 * needs nothing bootstrapped, but it must reach the same API/DynamoDB Local as the web dev server:
 * set E2E_API_URL (default http://localhost:3001) and, for a non-default DynamoDB Local, DYNAMODB_ENDPOINT
 * (the admin script reads it). To run beside your own `pnpm dev` use alternate ports, e.g.
 *   DDB (in-memory, port 8010) · PORT=3011 WS_PORT=3012 DYNAMODB_ENDPOINT=http://localhost:8010 pnpm --filter @dnp/api dev
 *   API_PORT=3011 WEB_PORT=5183 pnpm --filter @dnp/web dev
 *   E2E_BASE_URL=http://localhost:5183 E2E_API_URL=http://localhost:3011 DYNAMODB_ENDPOINT=http://localhost:8010 pnpm e2e
 *
 * Override the web origin with E2E_BASE_URL (default http://localhost:5173).
 * Never point this at a deployed site: it signs in with the local dev sign-in only.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: "../node_modules/.cache/playwright-results",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
