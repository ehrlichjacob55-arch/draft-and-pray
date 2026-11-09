/** Clients + helpers built from an EnvConfig. Nothing here is created before assertTestEnv. */
import {
  AdminAddUserToGroupCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  ListUsersCommand,
  RespondToAuthChallengeCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  GetParameterCommand,
  PutParameterCommand,
  DeleteParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { createDynamo, ensureTable, localSub, type Dynamo } from "@dnp/db";
import type { EnvConfig } from "./env";
import { NEW_TEST_PREFIX, isNewTestUserEmail, testUsersParam } from "./env";

export interface TestUser {
  email: string;
  password: string;
}

export function openDb(cfg: EnvConfig): Dynamo {
  return createDynamo({ tableName: cfg.tableName, region: cfg.region, endpoint: cfg.endpoint });
}

export async function ensureLocalTable(db: Dynamo): Promise<void> {
  await ensureTable(db.raw, db.tableName);
}

export const openCognito = (cfg: EnvConfig) =>
  new CognitoIdentityProviderClient({ region: cfg.region });
export const openSsm = (cfg: EnvConfig) => new SSMClient({ region: cfg.region });

export function requirePool(cfg: EnvConfig): { userPoolId: string; clientId: string } {
  if (!cfg.userPoolId || !cfg.clientId)
    throw new Error("User pool id / client id unknown: pass --user-pool-id and --client-id");
  return { userPoolId: cfg.userPoolId, clientId: cfg.clientId };
}

/** Test users from SSM SecureString `/dnp/<env>/test-users`. Never print the result's passwords. */
export async function readTestUsers(cfg: EnvConfig, ssm = openSsm(cfg)): Promise<TestUser[]> {
  const res = await ssm.send(
    new GetParameterCommand({ Name: testUsersParam(cfg.env), WithDecryption: true }),
  );
  const parsed = JSON.parse(res.Parameter?.Value ?? "[]") as TestUser[];
  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new Error(
      `No test users in ${testUsersParam(cfg.env)}: run \`pnpm admin test-users create --env ${cfg.env}\``,
    );
  return parsed;
}

export async function writeTestUsers(cfg: EnvConfig, users: TestUser[], ssm = openSsm(cfg)) {
  await ssm.send(
    new PutParameterCommand({
      Name: testUsersParam(cfg.env),
      Type: "SecureString",
      Value: JSON.stringify(users),
      Overwrite: true,
      Description: "Generated test users for smoke tests (docs/design/11 section 3.4)",
    }),
  );
}

export async function deleteTestUsersParam(cfg: EnvConfig, ssm = openSsm(cfg)) {
  await ssm.send(new DeleteParameterCommand({ Name: testUsersParam(cfg.env) })).catch((err) => {
    if ((err as { name?: string }).name !== "ParameterNotFound") throw err;
  });
}

export async function addToGroup(
  client: CognitoIdentityProviderClient,
  userPoolId: string,
  email: string,
  group: string,
) {
  await client.send(
    new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: email, GroupName: group }),
  );
}

export async function deleteCognitoUser(
  client: CognitoIdentityProviderClient,
  userPoolId: string,
  email: string,
) {
  await client
    .send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: email }))
    .catch((err) => {
      if ((err as { name?: string }).name !== "UserNotFoundException") throw err;
    });
}

export async function cognitoSub(
  client: CognitoIdentityProviderClient,
  userPoolId: string,
  email: string,
): Promise<string> {
  const res = await client.send(
    new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }),
  );
  const sub = res.UserAttributes?.find((a) => a.Name === "sub")?.Value;
  if (!sub) throw new Error(`No Cognito user for ${email}`);
  return sub;
}

/** Cognito password sign-in via USER_AUTH + PREFERRED_CHALLENGE=PASSWORD. Returns the ID token. */
export async function signInWithPassword(
  client: CognitoIdentityProviderClient,
  clientId: string,
  user: TestUser,
): Promise<string> {
  const first = await client.send(
    new InitiateAuthCommand({
      AuthFlow: "USER_AUTH",
      ClientId: clientId,
      AuthParameters: {
        USERNAME: user.email,
        PREFERRED_CHALLENGE: "PASSWORD",
        PASSWORD: user.password,
      },
    }),
  );
  if (first.AuthenticationResult?.IdToken) return first.AuthenticationResult.IdToken;
  if (first.ChallengeName === "PASSWORD" && first.Session) {
    const second = await client.send(
      new RespondToAuthChallengeCommand({
        ClientId: clientId,
        ChallengeName: "PASSWORD",
        Session: first.Session,
        ChallengeResponses: { USERNAME: user.email, PASSWORD: user.password },
      }),
    );
    if (second.AuthenticationResult?.IdToken) return second.AuthenticationResult.IdToken;
  }
  throw new Error(`Sign-in failed for ${user.email} (challenge: ${first.ChallengeName ?? "none"})`);
}

/** Subject id of a test user: Cognito `sub` in AWS envs, derived locally. */
export async function subFor(cfg: EnvConfig, email: string): Promise<string> {
  if (cfg.env === "local") return localSub(email);
  const { userPoolId } = requirePool(cfg);
  return cognitoSub(openCognito(cfg), userPoolId, email);
}

/**
 * First sign-in of an invited user (docs/design/13 §1.3): USER_AUTH + PASSWORD with the temporary
 * password -> NEW_PASSWORD_REQUIRED -> a new random password (kept only in memory by the caller).
 * Returns the ID token.
 */
export async function signInNewUser(
  client: CognitoIdentityProviderClient,
  clientId: string,
  user: { email: string; temporaryPassword: string; newPassword: string },
): Promise<string> {
  const first = await client.send(
    new InitiateAuthCommand({
      AuthFlow: "USER_AUTH",
      ClientId: clientId,
      AuthParameters: {
        USERNAME: user.email,
        PREFERRED_CHALLENGE: "PASSWORD",
        PASSWORD: user.temporaryPassword,
      },
    }),
  );
  let step = first;
  if (step.ChallengeName === "PASSWORD" && step.Session) {
    step = await client.send(
      new RespondToAuthChallengeCommand({
        ClientId: clientId,
        ChallengeName: "PASSWORD",
        Session: step.Session,
        ChallengeResponses: { USERNAME: user.email, PASSWORD: user.temporaryPassword },
      }),
    );
  }
  if (step.ChallengeName !== "NEW_PASSWORD_REQUIRED" || !step.Session)
    throw new Error(`Expected NEW_PASSWORD_REQUIRED (got ${step.ChallengeName ?? "none"})`);
  const username = step.ChallengeParameters?.USER_ID_FOR_SRP ?? user.email;
  const done = await client.send(
    new RespondToAuthChallengeCommand({
      ClientId: clientId,
      ChallengeName: "NEW_PASSWORD_REQUIRED",
      Session: step.Session,
      ChallengeResponses: { USERNAME: username, NEW_PASSWORD: user.newPassword },
    }),
  );
  const token = done.AuthenticationResult?.IdToken;
  if (!token) throw new Error("Setting the new password did not sign the user in");
  return token;
}

/**
 * Deletes every Cognito user whose email is a `dnp-new-*@example.com` smoke user (ListUsers with
 * a prefix filter; the regex is re-checked before each delete). Returns the emails it deleted.
 */
export async function deleteNewTestCognitoUsers(
  client: CognitoIdentityProviderClient,
  userPoolId: string,
): Promise<string[]> {
  const deleted: string[] = [];
  let token: string | undefined;
  do {
    const res = await client.send(
      new ListUsersCommand({
        UserPoolId: userPoolId,
        Filter: `email ^= "${NEW_TEST_PREFIX}"`,
        PaginationToken: token,
      }),
    );
    for (const u of res.Users ?? []) {
      const email = u.Attributes?.find((a) => a.Name === "email")?.Value ?? "";
      if (!u.Username || !isNewTestUserEmail(email)) continue;
      await client.send(
        new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: u.Username }),
      );
      deleted.push(email);
    }
    token = res.PaginationToken;
  } while (token);
  return deleted;
}
