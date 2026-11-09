import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { createDynamo, dynamoConfigFromEnv } from "@dnp/db";
import { createCognitoAdmin, noopCognito } from "./cognito";
import { loadConfig } from "./config";
import { createApp } from "./http/app";

let cached: ReturnType<typeof createApp> | undefined;

/** Lazily builds the app (and its DynamoDB/Cognito clients) once per Lambda container. */
export async function getApp() {
  if (!cached) {
    const config = loadConfig();
    const db = createDynamo(dynamoConfigFromEnv({ ...process.env, APP_TABLE: config.APP_TABLE }));
    const cognito = config.COGNITO_USER_POOL_ID
      ? createCognitoAdmin(new CognitoIdentityProviderClient({}), config.COGNITO_USER_POOL_ID)
      : noopCognito;
    cached = createApp({ config, db, cognito });
  }
  return cached;
}
