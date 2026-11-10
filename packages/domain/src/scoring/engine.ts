import type { Position } from "../roster";
import type { Rule, Ruleset, Tier } from "./ruleset";
import type { StatKey } from "./stat-keys";
import { parseStatLine, type StatLine } from "./stat-line";

/**
 * Points are computed in integer micro-points (1e-6) so there is no floating-point drift, then
 * rounded once, half away from zero, to the ruleset's `rounding` decimals.
 *
 * Per-unit semantics: whole units only by default (99 yds at 1 per 10 = 9 pts); a negative stat
 * truncates toward zero (-15 yds at 1 per 10 = -1 unit). `fractional: true` opts into
 * points * value / per instead.
 */
const MICRO = 1_000_000;

const roundAway = (x: number): number => Math.sign(x) * Math.round(Math.abs(x));
const toMicro = (points: number): number => roundAway(points * MICRO);

/** Rounds micro-points to `decimals` decimal places (half away from zero) and returns points. */
export function microToPoints(micro: number, decimals: number): number {
  const unit = 10 ** (6 - decimals);
  const abs = Math.abs(micro);
  let q = Math.trunc(abs / unit);
  if ((abs - q * unit) * 2 >= unit) q++;
  return (Math.sign(micro) * q) / 10 ** decimals;
}

export interface BreakdownEntry {
  /** Index into `ruleset.rules`. */
  ruleIndex: number;
  stat: StatKey;
  label?: string;
  /** The stat value the rule saw (the count, for distance rules). */
  value: number;
  /** This rule's points, rounded like the total (entries may not sum exactly to it). Zero-point rules are omitted. */
  points: number;
}

export interface PlayerGameScore {
  points: number;
  breakdown: BreakdownEntry[];
}

function findTier(tiers: Tier[], value: number): Tier | undefined {
  return tiers.find((t) => value >= t.min && (t.max === undefined || value <= t.max));
}

function ruleMicro(rule: Rule, line: StatLine): number {
  const value = line.counts[rule.stat] ?? 0;
  switch (rule.kind) {
    case "per_unit":
      return rule.fractional
        ? roundAway((toMicro(rule.points) * value) / rule.per)
        : toMicro(rule.points) * Math.trunc(value / rule.per);
    case "per_event":
      return toMicro(rule.points) * value;
    case "bonus":
      return value >= rule.gte ? toMicro(rule.points) : 0;
    case "tiers": {
      const tier = findTier(rule.tiers, value);
      return tier ? toMicro(tier.points) : 0;
    }
    case "distance_tiers": {
      const distances = (line.events as Record<string, number[] | undefined> | undefined)?.[
        rule.stat
      ];
      if (!distances) {
        if (value === 0) return 0;
        throw new Error(
          `${rule.stat} is ${value} but no distances were recorded, so it cannot be scored by distance`,
        );
      }
      let sum = 0;
      for (const d of distances) {
        const tier = findTier(rule.tiers, d);
        if (tier) sum += toMicro(tier.points);
      }
      return sum;
    }
  }
}

/** Scores one player's stat line for one game. Rules scoped to other positions contribute nothing. */
export function scorePlayerGame(
  ruleset: Ruleset,
  position: Position,
  statLine: StatLine,
): PlayerGameScore {
  const line = parseStatLine(statLine);
  const breakdown: BreakdownEntry[] = [];
  let total = 0;
  ruleset.rules.forEach((rule, ruleIndex) => {
    if (rule.positions && !rule.positions.includes(position)) return;
    const micro = ruleMicro(rule, line);
    if (micro === 0) return;
    total += micro;
    breakdown.push({
      ruleIndex,
      stat: rule.stat,
      ...(rule.label !== undefined ? { label: rule.label } : {}),
      value: line.counts[rule.stat] ?? 0,
      points: microToPoints(micro, ruleset.rounding),
    });
  });
  return { points: microToPoints(total, ruleset.rounding), breakdown };
}
