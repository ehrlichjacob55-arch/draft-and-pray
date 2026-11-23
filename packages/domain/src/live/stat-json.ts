import type { StatLine } from "../scoring/stat-line";

/** Stable JSON of a stat line (sorted keys), the input of the provider hash that gates writes. */
export function canonicalStatLineJson(line: StatLine): string {
  const sorted = (o: Record<string, unknown>) =>
    Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, o[k]]),
    );
  return JSON.stringify({
    counts: sorted(line.counts),
    ...(line.events ? { events: sorted(line.events) } : {}),
  });
}
