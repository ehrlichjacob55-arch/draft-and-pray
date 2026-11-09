import { z } from "zod";

const optional = z
  .string()
  .optional()
  .transform((v) => (v === "" ? undefined : v));

const envSchema = z.object({
  APP_ENV: z.enum(["local", "dev", "test", "prod"]).default("local"),
  APP_TABLE: optional,
  DYNAMODB_ENDPOINT: optional,
  COGNITO_USER_POOL_ID: optional,
  COGNITO_CLIENT_ID: optional,
  WS_CONNECTIONS_TABLE: optional,
  WS_MANAGEMENT_ENDPOINT: optional,
  SCHEDULER_GROUP: optional,
  SCHEDULER_ROLE_ARN: optional,
  DRAFT_TICK_FUNCTION_ARN: optional,
  STATS_API_KEY_PARAM: optional,
});

export type Config = z.infer<typeof envSchema>;

/** APP_TABLE is required outside local dev; locally it defaults to "dnp-local-app". */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const config = envSchema.parse(env);
  if (!config.APP_TABLE) {
    if (config.APP_ENV !== "local")
      throw new Error("APP_TABLE is required when APP_ENV is not local");
    config.APP_TABLE = "dnp-local-app";
  }
  return config;
}
