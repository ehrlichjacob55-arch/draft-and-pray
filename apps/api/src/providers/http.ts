import { PoolSourceError } from "./types";

export const PROVIDER_USER_AGENT = "draft-and-pray/0.1 (private league app)";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** GET JSON with a timeout and a descriptive User-Agent (no contact details or PII). */
export async function fetchJson(
  url: string,
  opts: { fetchImpl?: FetchLike; timeoutMs: number; label: string },
): Promise<unknown> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      headers: { "user-agent": PROVIDER_USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    throw new PoolSourceError(`${opts.label} could not be reached`, { cause: err });
  }
  if (!res.ok) throw new PoolSourceError(`${opts.label} returned HTTP ${res.status}`);
  try {
    return await res.json();
  } catch (err) {
    throw new PoolSourceError(`${opts.label} returned invalid JSON`, { cause: err });
  }
}
