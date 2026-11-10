import { z } from "zod";
import { POSITIONS, type Position } from "../roster";
import { STAT_KEYS, isEventStat, type StatKey } from "./stat-keys";

/**
 * Scoring ruleset (docs/design/04 §2): versioned JSON data, never code.
 *
 * Rule shapes (the `type` field is optional and, when given, must match the fields):
 *   per_unit        { stat, points, per, fractional? }  points per `per` units; whole units by default
 *   per_event       { stat, points }                    points per counted event
 *   bonus           { stat, gte, points }               once, when the stat is >= gte
 *   tiers           { stat, tiers }                     points of the band containing the stat total
 *   distance_tiers  { stat, tiers }                     fg_made/fg_missed: each kick scored by its distance
 * Any rule may add `positions` (scope) and `label` (shown in breakdowns).
 */
export interface Tier {
  min: number;
  /** Inclusive; absent = open-ended (last band only). */
  max?: number;
  points: number;
}
interface RuleBase {
  stat: StatKey;
  label?: string;
  positions?: Position[];
}
export type Rule = RuleBase &
  (
    | { kind: "per_unit"; points: number; per: number; fractional: boolean }
    | { kind: "per_event"; points: number }
    | { kind: "bonus"; gte: number; points: number }
    | { kind: "tiers"; tiers: Tier[] }
    | { kind: "distance_tiers"; tiers: Tier[] }
  );
export interface Ruleset {
  version: number;
  /** Decimal places of the final points (0..4). */
  rounding: number;
  name?: string;
  rules: Rule[];
}

export const RULE_TYPES = ["per_unit", "per_event", "bonus", "tiers", "distance_tiers"] as const;

const points = z
  .number()
  .refine(
    (p) => Math.abs(p * 1e4 - Math.round(p * 1e4)) < 1e-6,
    "points allow at most 4 decimal places",
  );

const tierSchema = z.strictObject({
  min: z.number().int().min(0),
  max: z.number().int().min(0).optional(),
  points,
});

const ruleShape = z.strictObject({
  stat: z.enum(STAT_KEYS, {
    error: (iss) =>
      `unknown stat key ${JSON.stringify(iss.input)}; known keys: ${STAT_KEYS.join(", ")}`,
  }),
  type: z.enum(RULE_TYPES).optional(),
  label: z.string().min(1).optional(),
  positions: z.array(z.enum(POSITIONS)).min(1).optional(),
  points: points.optional(),
  per: z.number().int().min(1).optional(),
  fractional: z.boolean().optional(),
  gte: z.number().int().optional(),
  tiers: z.array(tierSchema).min(1).optional(),
});

/** Returns an error message for the first problem with the bands, or undefined. */
function tierProblem(tiers: Tier[]): string | undefined {
  const sorted = [...tiers].sort((a, b) => a.min - b.min);
  for (const t of sorted)
    if (t.max !== undefined && t.max < t.min) return `tier ${t.min}-${t.max} has max below min`;
  if (sorted[0]!.min !== 0) return `tiers must start at 0 (first band starts at ${sorted[0]!.min})`;
  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i]!;
    const next = sorted[i + 1]!;
    if (cur.max === undefined)
      return `tier starting at ${cur.min} is open-ended but is followed by a tier starting at ${next.min}`;
    if (next.min <= cur.max) return `tiers overlap: ${cur.min}-${cur.max} and ${next.min}+`;
    if (next.min > cur.max + 1)
      return `gap in tiers: nothing covers ${cur.max + 1}..${next.min - 1}`;
  }
  if (sorted[sorted.length - 1]!.max !== undefined)
    return "the last tier must be open-ended (omit max) so every value is covered";
  return undefined;
}

const ruleSchema = ruleShape.transform((r, ctx): Rule => {
  const fail = (message: string): never => {
    ctx.issues.push({ code: "custom", input: r, message: `${r.stat}: ${message}` });
    return z.NEVER;
  };
  const base: RuleBase = {
    stat: r.stat,
    ...(r.label !== undefined ? { label: r.label } : {}),
    ...(r.positions ? { positions: r.positions } : {}),
  };
  let rule: Rule;
  if (r.tiers) {
    if (
      r.points !== undefined ||
      r.per !== undefined ||
      r.gte !== undefined ||
      r.fractional !== undefined
    )
      return fail("a tiers rule cannot also have points, per, gte or fractional");
    const problem = tierProblem(r.tiers);
    if (problem) return fail(problem);
    const sorted = [...r.tiers].sort((a, b) => a.min - b.min);
    rule = { ...base, kind: isEventStat(r.stat) ? "distance_tiers" : "tiers", tiers: sorted };
  } else {
    if (r.points === undefined) return fail("rule needs points, or tiers");
    if (r.gte !== undefined) {
      if (r.per !== undefined || r.fractional !== undefined)
        return fail("a bonus rule (gte) cannot have per or fractional");
      rule = { ...base, kind: "bonus", gte: r.gte, points: r.points };
    } else if (r.per !== undefined) {
      rule = {
        ...base,
        kind: "per_unit",
        points: r.points,
        per: r.per,
        fractional: r.fractional ?? false,
      };
    } else {
      if (r.fractional !== undefined) return fail("fractional only applies to a rule with per");
      rule = { ...base, kind: "per_event", points: r.points };
    }
  }
  if (r.type !== undefined && r.type !== rule.kind)
    return fail(`type "${r.type}" does not match its fields (they describe a ${rule.kind} rule)`);
  return rule;
});

const rulesetSchema = z.strictObject({
  version: z.number().int().min(1),
  rounding: z.number().int().min(0).max(4).default(2),
  name: z.string().min(1).optional(),
  rules: z.array(ruleSchema).min(1, "a ruleset needs at least one rule"),
});

export type RulesetParseResult = { ok: true; ruleset: Ruleset } | { ok: false; errors: string[] };

const pathText = (path: PropertyKey[]): string =>
  path.reduce<string>(
    (acc, p) => (typeof p === "number" ? `${acc}[${p}]` : acc ? `${acc}.${String(p)}` : String(p)),
    "",
  );

/** Validates a ruleset JSON document; `errors` are human-readable, one per problem. */
export function safeParseRuleset(input: unknown): RulesetParseResult {
  const r = rulesetSchema.safeParse(input);
  if (r.success) return { ok: true, ruleset: r.data as Ruleset };
  return {
    ok: false,
    errors: r.error.issues.map((i) => {
      const at = pathText(i.path);
      return at ? `${at}: ${i.message}` : i.message;
    }),
  };
}

export function parseRuleset(input: unknown): Ruleset {
  const r = safeParseRuleset(input);
  if (!r.ok) throw new Error(`Invalid ruleset:\n- ${r.errors.join("\n- ")}`);
  return r.ruleset;
}
