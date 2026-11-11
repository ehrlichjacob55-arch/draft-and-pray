import type { ActiveScoring } from "@dnp/contract";
import {
  GOLDEN_PLAYERS,
  safeParseRuleset,
  scorePlayerGame,
  type Ruleset,
  type RulesetIssue,
} from "@dnp/domain";
import { splitIssues } from "./catalog";

/** The editable part of a ruleset version. `rules` stay plain JSON so partial edits are kept. */
export interface Draft {
  rounding: number;
  rules: unknown[];
}

export const draftOf = (a: Pick<ActiveScoring, "rounding" | "rules">): Draft => ({
  rounding: a.rounding,
  rules: structuredClone(a.rules),
});

export const sameDraft = (a: Draft, b: Draft): boolean => JSON.stringify(a) === JSON.stringify(b);

export const toJsonText = (d: Draft): string => JSON.stringify(d, null, 2);

/** Parses the Advanced JSON box. Extra keys (`version`, `name`) are ignored: the server owns them. */
export function draftFromJson(text: string): { draft: Draft } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { error: `That is not valid JSON (${(err as Error).message}).` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { error: 'The JSON must be an object like { "rounding": 2, "rules": [ … ] }.' };
  const { rounding, rules } = raw as { rounding?: unknown; rules?: unknown };
  if (!Array.isArray(rules)) return { error: 'The JSON needs a "rules" list.' };
  if (rounding !== undefined && typeof rounding !== "number")
    return { error: '"rounding" must be a number from 0 to 4.' };
  return { draft: { rounding: rounding ?? 2, rules } };
}

export interface Validation {
  ruleset: Ruleset | null;
  issues: RulesetIssue[];
  general: string[];
  byRule: Map<number, string[]>;
}

/** The same check the server runs (domain parser), live. */
export function validateDraft(d: Draft): Validation {
  const r = safeParseRuleset({ version: 1, rounding: d.rounding, rules: d.rules });
  if (r.ok) return { ruleset: r.ruleset, issues: [], general: [], byRule: new Map() };
  return { ruleset: null, issues: r.issues, ...splitIssues(r.issues) };
}

export interface PreviewRow {
  name: string;
  position: string;
  /** Points under each ruleset; null when the ruleset is invalid or cannot score this line. */
  saved: number | null;
  edited: number | null;
}

/** Scores the golden-fixture players (2025-26 Wild Card, LAR-CAR) under both rulesets. */
export function previewRows(saved: Ruleset | null, edited: Ruleset | null): PreviewRow[] {
  const score = (rs: Ruleset | null, p: (typeof GOLDEN_PLAYERS)[number]): number | null => {
    if (!rs) return null;
    try {
      return scorePlayerGame(rs, p.position, p.stats).points;
    } catch {
      return null;
    }
  };
  return GOLDEN_PLAYERS.map((p) => ({
    name: p.name,
    position: p.position,
    saved: score(saved, p),
    edited: score(edited, p),
  }));
}
