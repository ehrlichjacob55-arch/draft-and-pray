/** Authentication (docs/design/11 §3.1/§3.2): Cognito ID tokens, or a dev header locally only. */
import { normalizeEmail } from "@dnp/contract";
import { localSub } from "@dnp/db";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { MiddlewareHandler } from "hono";
import type { Config } from "../config";
import { unauthorized } from "./errors";

export interface AuthUser {
  sub: string;
  /** Normalized; may be undefined if the token carries no email claim. */
  email?: string;
  /** False only when the token says the email is unverified; claims are skipped then. */
  emailVerified?: boolean;
  /** `cognito:groups` from the ID token (e.g. `test-users`). Empty/absent for local dev auth. */
  groups?: string[];
}

export type AppEnv = { Variables: { user: AuthUser } };

export type TokenVerifier = (token: string) => Promise<AuthUser>;

export const DEV_EMAIL_HEADER = "x-dev-user-email";
export const DEFAULT_DEV_EMAIL = "dev@local.test";

/** True only for local development without Cognito. Must never be true in AWS. */
export const isLocalDevAuth = (config: Config): boolean =>
  config.APP_ENV === "local" && !config.COGNITO_USER_POOL_ID;

export function cognitoVerifier(userPoolId: string, clientId: string): TokenVerifier {
  const verifier = CognitoJwtVerifier.create({ userPoolId, tokenUse: "id", clientId });
  return async (token) => {
    const payload = await verifier.verify(token);
    const email = typeof payload.email === "string" ? normalizeEmail(payload.email) : undefined;
    const groups = Array.isArray(payload["cognito:groups"])
      ? payload["cognito:groups"].filter((g): g is string => typeof g === "string")
      : [];
    const emailVerified = payload.email_verified === true;
    return { sub: payload.sub, email, emailVerified, groups };
  };
}

export function authMiddleware(
  config: Config,
  verifyOverride?: TokenVerifier,
): MiddlewareHandler<AppEnv> {
  if (isLocalDevAuth(config)) {
    return async (c, next) => {
      const email = normalizeEmail(c.req.header(DEV_EMAIL_HEADER) || DEFAULT_DEV_EMAIL);
      c.set("user", { sub: localSub(email), email, emailVerified: true, groups: [] });
      await next();
    };
  }

  const { COGNITO_USER_POOL_ID: userPoolId, COGNITO_CLIENT_ID: clientId } = config;
  const verify =
    verifyOverride ?? (userPoolId && clientId ? cognitoVerifier(userPoolId, clientId) : undefined);

  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!token) throw unauthorized("Missing bearer token");
    if (!verify) throw unauthorized("Authentication is not configured");
    try {
      c.set("user", await verify(token));
    } catch {
      throw unauthorized("Invalid token");
    }
    await next();
  };
}

/** Routes reachable without a session. */
export function isPublicRoute(method: string, path: string): boolean {
  if (method === "GET" && path === "/api/health") return true;
  return false;
}
