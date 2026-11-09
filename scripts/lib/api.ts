/** Tiny HTTP client for the real API: dev header locally, Cognito ID tokens elsewhere. */
import type { EnvConfig } from "./env";
import { openCognito, requirePool, signInWithPassword, type TestUser } from "./runtime";

/** Loosely typed JSON body; scripts assert on the fields they need. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export interface ApiResult<T = Json> {
  status: number;
  json: T;
}

export interface ApiClient {
  request<T = Json>(
    method: string,
    path: string,
    opts?: { as?: string; body?: unknown; anonymous?: boolean },
  ): Promise<ApiResult<T>>;
  /** Registers an ID token for an email that is not in the stored test-user list (in memory only). */
  useToken(email: string, idToken: string): void;
}

/** `users` is the SSM test-user list (AWS envs); ignored locally. */
export function createApiClient(cfg: EnvConfig, users: TestUser[] = []): ApiClient {
  if (!cfg.baseUrl) throw new Error("API base URL unknown: pass --base-url");
  const base = cfg.baseUrl.replace(/\/$/, "");
  const tokens = new Map<string, string>();
  const cognito = cfg.env === "local" ? undefined : openCognito(cfg);

  async function authHeader(email: string): Promise<Record<string, string>> {
    if (cfg.env === "local") return { "X-Dev-User-Email": email };
    let token = tokens.get(email);
    if (!token) {
      const user = users.find((u) => u.email === email);
      if (!user) throw new Error(`No stored credentials for ${email}`);
      token = await signInWithPassword(cognito!, requirePool(cfg).clientId, user);
      tokens.set(email, token);
    }
    return { authorization: `Bearer ${token}` };
  }

  return {
    useToken(email, idToken) {
      tokens.set(email, idToken);
    },
    async request(method, path, opts = {}) {
      const headers: Record<string, string> = {};
      if (opts.as && !opts.anonymous) Object.assign(headers, await authHeader(opts.as));
      if (opts.body !== undefined) headers["content-type"] = "application/json";
      const res = await fetch(`${base}/api${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      const text = await res.text();
      const json = ((): unknown => {
        try {
          return text ? JSON.parse(text) : null;
        } catch {
          return { raw: text.slice(0, 200) };
        }
      })();
      return { status: res.status, json } as ApiResult;
    },
  };
}
