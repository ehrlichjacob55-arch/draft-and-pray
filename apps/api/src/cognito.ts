/**
 * Cognito admin adapter: makes an email OTP-ready without ever telling the user a password
 * (docs/design/11 §3.3), and sends/re-sends/removes manager invitations (docs/design/13 §1-2).
 * Also imported by scripts/admin (bootstrap, test users).
 *
 * PII rule (13 §6): never log an email or a client-metadata value here.
 */
import { randomInt } from "node:crypto";
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  UserNotFoundException,
  UsernameExistsException,
  type CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";

/** Values the CustomMessage Lambda renders (docs/design/13 §3): the recipient's own league/team only. */
export interface InviteClientMetadata {
  leagueName: string;
  seasonYear: string;
  teamName: string;
}

/** Test-only: skip the email and use this known temporary password (docs/design/13 §7). */
export interface TestSuppress {
  temporaryPassword: string;
}

export interface InviteUserInput {
  /** Normalized. */
  email: string;
  clientMetadata: InviteClientMetadata;
  testSuppress?: TestSuppress;
}

export interface InviteUserResult {
  /** Cognito's opaque username (UUID); undefined when there is no user pool (local). */
  username?: string;
  /** The email already had a Cognito user. */
  existing: boolean;
  /** Cognito sent (or re-sent) an invitation email. */
  emailSent: boolean;
}

/** What the API needs from Cognito. Implemented by the real adapter, a no-op, and test mocks. */
export interface CognitoAdmin {
  /** Ensure a CONFIRMED user exists for `email` so it can sign in with an emailed code. */
  ensureOtpReadyUser(email: string): Promise<void>;
  /**
   * AdminCreateUser (email + email_verified, EMAIL delivery). Cognito sends the invitation, which
   * the CustomMessage Lambda rewrites. An existing user gets no new account; one still waiting in
   * FORCE_CHANGE_PASSWORD gets the invitation re-sent.
   */
  inviteNewUser(input: InviteUserInput): Promise<InviteUserResult>;
  /** AdminCreateUser MessageAction=RESEND (new temporary code). Re-creates a missing user. */
  resendInvite(input: InviteUserInput & { username?: string }): Promise<InviteUserResult>;
  /** Deletes the user only while it is still FORCE_CHANGE_PASSWORD. Returns whether it did. */
  deleteIfUnconfirmed(username: string): Promise<boolean>;
}

/** Local dev (no user pool): there is no account to create; managers are assigned at sign-in. */
export const noopCognito: CognitoAdmin = {
  async ensureOtpReadyUser() {},
  async inviteNewUser() {
    return { existing: true, emailSent: false };
  },
  async resendInvite() {
    return { existing: true, emailSent: false };
  },
  async deleteIfUnconfirmed() {
    return false;
  },
};

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

const URL_SAFE_SYMBOL = "-_.~";
const URL_SAFE_ALL = UPPER + LOWER + DIGIT + URL_SAFE_SYMBOL;

/**
 * Invitation code: 20 chars from URL-unreserved characters only (A-Z a-z 0-9 - _ . ~), with at
 * least one upper, lower, digit and symbol so it meets the pool policy. Never log it.
 */
export function generateTemporaryPassword(length = 20): string {
  const pick = (set: string) => set[randomInt(set.length)] as string;
  const chars = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(URL_SAFE_SYMBOL)];
  while (chars.length < length) chars.push(pick(URL_SAFE_ALL));
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

const errName = (err: unknown) => (err as { name?: string } | null)?.name;

export function createCognitoAdmin(
  client: CognitoIdentityProviderClient,
  userPoolId: string,
): CognitoAdmin {
  const clientMetadata = (m: InviteClientMetadata): Record<string, string> => ({
    leagueName: m.leagueName,
    seasonYear: m.seasonYear,
    teamName: m.teamName,
  });

  async function resend(username: string, meta: InviteClientMetadata): Promise<boolean> {
    // A fresh URL-safe code on every resend, so the link stays parseable.
    try {
      await client.send(
        new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: username,
          MessageAction: "RESEND",
          TemporaryPassword: generateTemporaryPassword(),
          DesiredDeliveryMediums: ["EMAIL"],
          ClientMetadata: clientMetadata(meta),
        }),
      );
      return true;
    } catch (err) {
      // CONFIRMED (or otherwise past the invitation): nothing to resend.
      if (errName(err) === "UnsupportedUserStateException") return false;
      throw err;
    }
  }

  const adapter: CognitoAdmin = {
    async ensureOtpReadyUser(email) {
      await ensureCognitoUser(client, userPoolId, email);
    },

    async inviteNewUser({ email, clientMetadata: meta, testSuppress }) {
      try {
        const res = await client.send(
          new AdminCreateUserCommand({
            UserPoolId: userPoolId,
            Username: email,
            UserAttributes: [
              { Name: "email", Value: email },
              { Name: "email_verified", Value: "true" },
            ],
            DesiredDeliveryMediums: ["EMAIL"],
            ClientMetadata: clientMetadata(meta),
            TemporaryPassword: testSuppress?.temporaryPassword ?? generateTemporaryPassword(),
            ...(testSuppress ? { MessageAction: "SUPPRESS" as const } : {}),
          }),
        );
        return { username: res.User?.Username, existing: false, emailSent: !testSuppress };
      } catch (err) {
        if (!(err instanceof UsernameExistsException)) throw err;
      }
      // Already has an account: no new user. If it never finished the invitation, re-send it.
      const existing = await getUser(client, userPoolId, email);
      let emailSent = false;
      if (!testSuppress && existing.UserStatus === "FORCE_CHANGE_PASSWORD")
        emailSent = await resend(existing.Username ?? email, meta);
      return { username: existing.Username, existing: true, emailSent };
    },

    async resendInvite(input) {
      const target = input.username ?? input.email;
      try {
        const sent = await resend(target, input.clientMetadata);
        return { username: input.username, existing: true, emailSent: sent };
      } catch (err) {
        if (!(err instanceof UserNotFoundException)) throw err;
      }
      return adapter.inviteNewUser(input);
    },

    async deleteIfUnconfirmed(username) {
      let status: string | undefined;
      try {
        status = (await getUser(client, userPoolId, username)).UserStatus;
      } catch (err) {
        if (err instanceof UserNotFoundException) return false;
        throw err;
      }
      if (status !== "FORCE_CHANGE_PASSWORD") return false;
      await client.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username }));
      return true;
    },
  };
  return adapter;
}
