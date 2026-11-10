/**
 * Milliseconds left on the pick clock, correcting for client/server clock skew:
 * the server's "now" at fetch time is `serverNow`, observed locally at `receivedAt`.
 */
export function clockRemainingMs(
  expiresAt: string,
  serverNow: string,
  receivedAt: number,
  now: number,
): number {
  const estimatedServerNow = Date.parse(serverNow) + (now - receivedAt);
  return Date.parse(expiresAt) - estimatedServerNow;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
