import { serve } from "@hono/node-server";
import { createDynamo, dynamoConfigFromEnv, ensureTable } from "@dnp/db";
import { loadConfig } from "./config";
import { createApp } from "./http/app";
import { startLocalRealtime } from "./realtime/local-hub";

const config = loadConfig();
const db = createDynamo(
  dynamoConfigFromEnv({
    ...process.env,
    APP_TABLE: config.APP_TABLE,
    DYNAMODB_ENDPOINT: config.DYNAMODB_ENDPOINT ?? "http://localhost:8000",
  }),
);

/** DynamoDB Local may start a moment after the api (pnpm dev), so retry. */
async function ensureTableWithRetry(attempts = 10): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      await ensureTable(db.raw, db.tableName);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}

const port = Number(process.env.PORT ?? 3001);
const wsPort = Number(config.WS_PORT ?? 3002);
const realtime = await startLocalRealtime({ db, port: wsPort });
console.log(`WebSocket listening on ws://localhost:${realtime.port}`);
serve({ fetch: createApp({ config, db, publisher: realtime }).fetch, port }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});

if (await ensureTableWithRetry()) {
  console.log(`DynamoDB table ${db.tableName} ready`);
} else {
  console.warn(
    "DynamoDB Local is not reachable on " +
      (config.DYNAMODB_ENDPOINT ?? "http://localhost:8000") +
      ": run `pnpm ddb:local` (needs Java). /api/health will report db: error until it is up.",
  );
}
