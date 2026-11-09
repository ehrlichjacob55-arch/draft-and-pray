import type { Context } from "hono";
import type { Config } from "../config";

const LOCAL_WEB_ORIGIN = "http://localhost:5173";

const originOf = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

/**
 * Public origin of the web app, for invite links: PUBLIC_BASE_URL, else the forwarded/Host
 * headers (https), else the browser's Origin/Referer (CloudFront does not forward Host to the
 * API origin), else http://localhost:5173 when running locally.
 */
export function publicOrigin(c: Context, config: Config): string {
  if (config.PUBLIC_BASE_URL) return originOf(config.PUBLIC_BASE_URL) ?? config.PUBLIC_BASE_URL;
  if (config.APP_ENV === "local") return LOCAL_WEB_ORIGIN;
  const fwd = c.req.header("x-forwarded-host")?.split(",")[0]?.trim();
  if (fwd) return `https://${fwd}`;
  const viewer = originOf(c.req.header("origin")) ?? originOf(c.req.header("referer"));
  if (viewer) return viewer;
  const host = c.req.header("host");
  return host ? `https://${host}` : LOCAL_WEB_ORIGIN;
}

export const inviteUrl = (origin: string, token: string) => `${origin}/join/${token}`;

/** j***@gmail.com */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}
