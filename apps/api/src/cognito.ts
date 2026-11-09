/**
 * Cognito admin adapter (docs/design/11 §3.3): makes an email OTP-ready without ever telling the
 * user a password. Also imported by scripts/admin (bootstrap, test users).
 */
import { randomInt } from "node:crypto";
import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  UserNotFoundException,
  type CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";

/** What the API needs from Cognito. Implemented by the real adapter, a no-op, and test mocks. */
export interface CognitoAdmin {
  /** Ensure a CONFIRMED user exists for `email` so it can sign in with an emailed code. */
  ensureOtpReadyUser(email: string): Promise<void>;
}

/** Local dev (no user pool): nothing to do. */
export const noopCognito: CognitoAdmin = { async ensureOtpReadyUser() {} };

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGIT = "0123456789";
const SYMBOL = "^$*.[]{}()?-\"!@#%&/\\,><':;|_~`+=";

/** 32 random chars satisfying Cognito's default policy (upper, lower, digit, symbol, >= 8). */
export function generatePassword(length = 32): string {
  const all = UPPER + LOWER + DIGIT + SYMBOL;
  const pick = (set: string) => set[randomInt(set.length)] as string;
  const chars = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SYMBOL)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
  return chars.join("");
}

export interface EnsureUserOptions {
  /** Known password (test users). Always set when given; otherwise a random one, only for new users. */
  password?: string;
}

/**
 * §3.3: AdminGetUser -> (AdminCreateUser SUPPRESS, email_verified) -> AdminSetUserPassword
 * permanent. Returns the user's `sub`. Users stuck in FORCE_CHANGE_PASSWORD get a fresh random
 * password so they become CONFIRMED.
 */
export async function ensureCognitoUser(
  client: CognitoIdentityProviderClient,
  userPoolId: string,
  email: string,
  opts: EnsureUserOptions = {},
): Promise<{ sub: string; created: boolean }> {
  let existing: Awaited<ReturnType<typeof getUser>> | undefined;
  try {
    existing = await getUser(client, userPoolId, email);
  } catch (err) {
    if (!(err instanceof UserNotFoundException)) throw err;
  }
  let created = false;
  let status = existing?.UserStatus;
  let attrs = existing?.UserAttributes;
  if (!existing) {
    const res = await client.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: email,
        MessageAction: "SUPPRESS",
        UserAttributes: [
          { Name: "email", Value: email },
          { Name: "email_verified", Value: "true" },
        ],
      }),
    );
    created = true;
    status = res.User?.UserStatus;
    attrs = res.User?.Attributes;
  }
  if (
    created ||
    opts.password ||
    status === "FORCE_CHANGE_PASSWORD" ||
    status === "RESET_REQUIRED"
  ) {
    await client.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: userPoolId,
        Username: email,
        Password: opts.password ?? generatePassword(),
        Permanent: true,
      }),
    );
  }
  const sub = attrs?.find((a) => a.Name === "sub")?.Value;
  if (!sub) throw new Error("Cognito user has no sub attribute");
  return { sub, created };
}

function getUser(client: CognitoIdentityProviderClient, userPoolId: string, email: string) {
  return client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }));
}

export function createCognitoAdmin(
  client: CognitoIdentityProviderClient,
  userPoolId: string,
): CognitoAdmin {
  return {
    async ensureOtpReadyUser(email) {
      await ensureCognitoUser(client, userPoolId, email);
    },
  };
}
