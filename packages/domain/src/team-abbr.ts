/** Team abbreviations (docs/design/14 §7). Pure, no I/O. */

const MAX_LEN = 4;
const MIN_LEN = 2;
const FALLBACK = "TM";

/**
 * The auto-default abbreviation for a team name: a leading "Team " is dropped, non-alphanumerics
 * removed, uppercased, first 4 characters ("TM" if fewer than 2 remain). On a clash with
 * `takenAbbrs` (case-insensitive) the last character is replaced by 2, 3, … keeping length <= 4.
 */
export function defaultAbbr(name: string, takenAbbrs: Iterable<string>): string {
  const base = name
    .trim()
    .replace(/^team\s+/i, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase()
    .slice(0, MAX_LEN);
  const start = base.length < MIN_LEN ? FALLBACK : base;
  const taken = new Set([...takenAbbrs].map((a) => a.toUpperCase()));
  let candidate = start;
  for (let n = 2; taken.has(candidate); n++) {
    const digits = String(n);
    candidate = start.slice(0, Math.min(start.length - 1, MAX_LEN - digits.length)) + digits;
  }
  return candidate;
}
