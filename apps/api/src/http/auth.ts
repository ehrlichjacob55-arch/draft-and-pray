import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Config } from "../config";

export interface AuthUser {
  sub: string;
  email?: string;
  claims: Record<string, unknown>;
}

export type AppEnv = { Variables: { user: AuthUser } };

const LOCAL_USER: AuthUser = {
  sub: "local-user",
  email: "local@example.com",
  claims: { sub: "local-user", email: "local@example.com", local: true },
};

export function authMiddleware(config: Config): MiddlewareHandler<AppEnv> {
  const { COGNITO_USER_POOL_ID: userPoolId, COGNITO_CLIENT_ID: clientId } = config;

  if (!userPoolId) {
    let warned = false;
    return async (c, next) => {
      if (!warned) {
        warned = true;
        console.warn("COGNITO_USER_POOL_ID unset: auth disabled, using fake local user");
      }
      c.set("user", LOCAL_USER);
      await next();
    };
  }

  const verifier = CognitoJwtVerifier.create({
    userPoolId,
    tokenUse: "id",
    clientId: clientId ?? null,
  });

  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!token) throw new HTTPException(401, { message: "Missing bearer token" });
    try {
      const payload = await verifier.verify(token);
      const email = typeof payload.email === "string" ? payload.email : undefined;
      c.set("user", { sub: payload.sub, email, claims: { ...payload } });
    } catch {
      throw new HTTPException(401, { message: "Invalid token" });
    }
    await next();
  };
}
