/**
 * Environment handling shared by admin and smoke scripts. Test-user / test-league commands must
 * never touch prod: `assertTestEnv` is the first thing they call, before any AWS client exists.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ENVS = ["local", "dev", "test", "prod"] as const;
export type Env = (typeof ENVS)[number];
export type TestEnv = Exclude<Env, "prod">;

export const DEFAULT_REGION = "us-east-2";
export const LOCAL_ENDPOINT = "http://localhost:8000";
export const LOCAL_API = "http://localhost:3001";
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export function parseEnv(value: string | undefined): Env {
  if (!value || !(ENVS as readonly string[]).includes(value))
    throw new Error(`--env must be one of ${ENVS.join("|")} (got ${value ?? "nothing"})`);
  return value as Env;
}

/** Throws for prod (and anything unknown) BEFORE any AWS call. */
export function assertTestEnv(value: string | undefined, allowLocal: boolean): TestEnv {
  const env = parseEnv(value);
  if (env === "prod")
    throw new Error(
      "Refusing to run against prod: test users and the Test League never exist there",
    );
  if (env === "local" && !allowLocal)
    throw new Error("--env local is not supported by this command");
  return env;
}

export interface EnvFlags {
  "user-pool-id"?: string;
  "client-id"?: string;
  table?: string;
  "base-url"?: string;
  region?: string;
}

export interface EnvConfig {
  env: Env;
  region: string;
  tableName: string;
  /** DynamoDB endpoint, local only. */
  endpoint?: string;
  userPoolId?: string;
  clientId?: string;
  baseUrl: string;
}

interface TfOutputs {
  user_pool_id?: { value: string };
  client_id?: { value: string };
  app_table_name?: { value: string };
  cloudfront_domain?: { value: string };
}

export function terraformOutputs(env: Exclude<Env, "local">): TfOutputs {
  const dir = path.join(repoRoot, "infra/terraform/envs", env);
  try {
    return JSON.parse(
      execFileSync("terraform", [`-chdir=${dir}`, "output", "-json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ) as TfOutputs;
  } catch {
    throw new Error(
      `Could not read Terraform outputs for ${env}. Initialize the backend first:\n` +
        `  terraform -chdir=infra/terraform/envs/${env} init -backend-config=backend.hcl\n` +
        `or pass --user-pool-id, --client-id, --table and --base-url explicitly.`,
    );
  }
}

/** Resolves table / pool / client / base URL. Terraform is consulted only for missing values. */
export function resolveEnvConfig(
  env: Env,
  flags: EnvFlags = {},
  tf: (env: Exclude<Env, "local">) => TfOutputs = terraformOutputs,
): EnvConfig {
  const region = flags.region ?? process.env.AWS_REGION ?? DEFAULT_REGION;
  if (env === "local") {
    return {
      env,
      region,
      tableName: flags.table ?? process.env.APP_TABLE ?? "dnp-local-app",
      endpoint: process.env.DYNAMODB_ENDPOINT || LOCAL_ENDPOINT,
      baseUrl: flags["base-url"] ?? LOCAL_API,
    };
  }
  let outputs: TfOutputs | undefined;
  const lazy = () => (outputs ??= tf(env as Exclude<Env, "local">));
  return {
    env,
    region,
    tableName: flags.table ?? lazy().app_table_name?.value ?? `dnp-${env}-app`,
    userPoolId: flags["user-pool-id"] ?? lazy().user_pool_id?.value,
    clientId: flags["client-id"] ?? lazy().client_id?.value,
    baseUrl:
      flags["base-url"] ??
      (lazy().cloudfront_domain?.value ? `https://${lazy().cloudfront_domain?.value}` : ""),
  };
}

export const testUsersParam = (env: Env) => `/dnp/${env}/test-users`;
export const TEST_GROUP = "test-users";
export const TEST_LEAGUE_NAME = "Test League";
export const TEST_YEAR = 2026;
export const testUserEmail = (i: number) => `dnp-test-${String(i).padStart(2, "0")}@example.com`;
export const isTestUserEmail = (email: string) => /^dnp-test-\d{2}@example\.com$/.test(email);
