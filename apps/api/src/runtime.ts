import { createDynamo, dynamoConfigFromEnv } from "@dnp/db";
import { loadConfig } from "./config";
import { createApp } from "./http/app";

let cached: ReturnType<typeof createApp> | undefined;

/** Lazily builds the app (and its DynamoDB client) once per Lambda container. */
export async function getApp() {
  if (!cached) {
    const config = loadConfig();
    const db = createDynamo(dynamoConfigFromEnv({ ...process.env, APP_TABLE: config.APP_TABLE }));
    cached = createApp({ config, db });
  }
  return cached;
}
