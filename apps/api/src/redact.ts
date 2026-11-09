/**
 * PII-safe logging helpers (docs/design/13 §6). Request bodies are never logged; anything that is
 * logged goes through `redact` / `errorSummary` so names, emails and secrets cannot leak.
 */

const SENSITIVE_KEYS = new Set([
  "email",
  "firstname",
  "lastname",
  "password",
  "temporarypassword",
  "testtemporarypassword",
  "authorization",
  "token",
  "idtoken",
  "accesstoken",
  "refreshtoken",
  "code",
  "cognitousername",
  "username",
]);

export const REDACTED = "[redacted]";

const EMAIL_RE = /[^\s@<>"'()]+@[^\s@<>"'()]+\.[^\s@<>"'()]+/g;

/** Replaces anything that looks like an email address inside a string. */
export const scrubText = (text: string): string => text.replace(EMAIL_RE, "[email]");

/** Deep copy with sensitive keys replaced and email-looking strings scrubbed. */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 6) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

/** What is safe to log about an error: its type, AWS status/request id and a scrubbed message. */
export function errorSummary(err: unknown): Record<string, unknown> {
  const e = err as {
    name?: string;
    message?: string;
    $metadata?: { httpStatusCode?: number; requestId?: string };
  } | null;
  return {
    name: e?.name ?? typeof err,
    message: scrubText(String(e?.message ?? "")).slice(0, 300),
    status: e?.$metadata?.httpStatusCode,
    requestId: e?.$metadata?.requestId,
  };
}

/** console.error with a redacted summary instead of the raw error object. */
export function logError(message: string, err: unknown, extra?: Record<string, unknown>): void {
  console.error(message, redact({ ...extra, error: errorSummary(err) }));
}
