/** Friendly names, groups and defaults for the scoring UI (docs/design/04 §2 stat vocabulary). */
import { isEventStat, isStatKey, STAT_KEYS, type RulesetIssue, type StatKey } from "@dnp/domain";

export type RuleKind = "per_unit" | "per_event" | "bonus" | "tiers" | "distance_tiers";
/** A rule as it is stored and edited: plain JSON, possibly invalid while being edited. */
export type RuleJson = Record<string, unknown>;
export interface TierJson {
  min?: unknown;
  max?: unknown;
  points?: unknown;
}

export const STAT_LABELS: Record<StatKey, string> = {
  pass_yds: "Passing yards",
  pass_td: "Passing TDs",
  pass_int: "Interceptions thrown",
  pass_2pt: "2-pt conversions (pass)",
  rush_yds: "Rushing yards",
  rush_td: "Rushing TDs",
  rush_2pt: "2-pt conversions (rush)",
  rec: "Receptions",
  rec_yds: "Receiving yards",
  rec_td: "Receiving TDs",
  rec_2pt: "2-pt conversions (catch)",
  fum_lost: "Fumbles lost",
  ret_td: "Kick/punt return TDs",
  fum_rec_td: "Fumble-recovery TDs",
  fg_made: "Field goals made",
  fg_missed: "Field goals missed",
  fg_blocked: "Field goals blocked",
  xp_made: "Extra points made",
  xp_missed: "Extra points missed",
  xp_blocked: "Extra points blocked",
  def_pts_allowed: "Points allowed",
  def_yds_allowed: "Yards allowed",
  def_sack: "Sacks",
  def_int: "Interceptions",
  def_fum_rec: "Fumble recoveries",
  def_td: "Defensive TDs",
  def_safety: "Safeties",
  def_block: "Blocked kicks",
};

export const statLabel = (stat: unknown): string =>
  typeof stat === "string" && isStatKey(stat) ? STAT_LABELS[stat] : "Unknown stat";

export const KIND_LABELS: Record<RuleKind, string> = {
  per_event: "Points each",
  per_unit: "Points per unit (e.g. per 10 yds)",
  bonus: "Bonus at a threshold",
  tiers: "Bands (by total)",
  distance_tiers: "Bands by kick distance",
};

/** Rule kinds that make sense for a stat. */
export function kindsFor(stat: StatKey): RuleKind[] {
  return isEventStat(stat)
    ? ["per_event", "distance_tiers", "bonus"]
    : ["per_event", "per_unit", "bonus", "tiers"];
}

export const GROUPS = [
  { id: "passing", title: "Passing" },
  { id: "rushing", title: "Rushing" },
  { id: "receiving", title: "Receiving" },
  { id: "touchdowns", title: "Touchdowns & 2-pt" },
  { id: "turnovers", title: "Turnovers" },
  { id: "kicking", title: "Kicking" },
  { id: "defense", title: "Defense (DST)" },
  { id: "bonuses", title: "Bonuses" },
  { id: "other", title: "Other" },
] as const;
export type GroupId = (typeof GROUPS)[number]["id"];

const STAT_GROUP: Record<StatKey, GroupId> = {
  pass_yds: "passing",
  rush_yds: "rushing",
  rec: "receiving",
  rec_yds: "receiving",
  pass_td: "touchdowns",
  rush_td: "touchdowns",
  rec_td: "touchdowns",
  ret_td: "touchdowns",
  fum_rec_td: "touchdowns",
  pass_2pt: "touchdowns",
  rush_2pt: "touchdowns",
  rec_2pt: "touchdowns",
  pass_int: "turnovers",
  fum_lost: "turnovers",
  fg_made: "kicking",
  fg_missed: "kicking",
  fg_blocked: "kicking",
  xp_made: "kicking",
  xp_missed: "kicking",
  xp_blocked: "kicking",
  def_pts_allowed: "defense",
  def_yds_allowed: "defense",
  def_sack: "defense",
  def_int: "defense",
  def_fum_rec: "defense",
  def_td: "defense",
  def_safety: "defense",
  def_block: "defense",
};

/** Threshold bonuses are grouped together whatever their stat; everything else follows its stat. */
export function groupFor(stat: unknown, kind: RuleKind): GroupId {
  if (kind === "bonus") return "bonuses";
  return typeof stat === "string" && isStatKey(stat) ? STAT_GROUP[stat] : "other";
}

/** Mirrors the domain parser's inference (docs/design/04 §2): the fields decide the type. */
export function kindOf(rule: RuleJson): RuleKind {
  if (Array.isArray(rule.tiers)) return isEventStat(String(rule.stat)) ? "distance_tiers" : "tiers";
  if (rule.gte !== undefined) return "bonus";
  if (rule.per !== undefined) return "per_unit";
  return "per_event";
}

export const asRule = (r: unknown): RuleJson =>
  typeof r === "object" && r !== null && !Array.isArray(r) ? (r as RuleJson) : {};

export function newRule(stat: StatKey, kind: RuleKind): RuleJson {
  switch (kind) {
    case "per_unit":
      return { stat, points: 1, per: 10, fractional: true };
    case "bonus":
      return { stat, gte: 100, points: 1 };
    case "tiers":
    case "distance_tiers":
      return { stat, tiers: [{ min: 0, points: 0 }] };
    case "per_event":
      return { stat, points: 1 };
  }
}

export interface GroupedRules {
  id: GroupId;
  title: string;
  items: { rule: RuleJson; index: number }[];
}

/** Rules bucketed into the display groups (empty groups dropped), keeping each rule's index. */
export function groupRules(rules: unknown[]): GroupedRules[] {
  return GROUPS.map((g) => ({
    id: g.id,
    title: g.title,
    items: rules
      .map((r, index) => ({ rule: asRule(r), index }))
      .filter(({ rule }) => groupFor(rule.stat, kindOf(rule)) === g.id),
  })).filter((g) => g.items.length > 0);
}

export const STAT_OPTIONS: { stat: StatKey; label: string }[] = STAT_KEYS.map((stat) => ({
  stat,
  label: STAT_LABELS[stat],
}));

/** Unit suffix for "per N" rules: yardage stats say "yds". */
export const unitOf = (stat: unknown): string =>
  typeof stat === "string" && /_yds(_|$)/.test(stat) ? " yds" : "";

export const pts = (n: number): string => {
  const v = Number(n.toFixed(4));
  return `${v} pt${Math.abs(v) === 1 ? "" : "s"}`;
};

/** "59 yds → 5.9 pts" for a per-unit rule, or null when its numbers are not usable yet. */
export function perUnitExample(rule: RuleJson): string | null {
  const { points, per } = rule;
  if (typeof points !== "number" || typeof per !== "number" || !Number.isFinite(points))
    return null;
  if (!Number.isInteger(per) || per < 1) return null;
  const sample = per * 6 - 1;
  const value =
    rule.fractional === true ? (points * sample) / per : Math.trunc(sample / per) * points;
  return `${sample}${unitOf(rule.stat) || " units"} → ${pts(value)}`;
}

export const rangeText = (min: number, max: number | undefined): string =>
  max === undefined ? `${min}+` : min === max ? `${min}` : `${min}–${max}`;

/** Issues grouped by rule index; the rest are about the whole ruleset. */
export function splitIssues(issues: RulesetIssue[]): {
  general: string[];
  byRule: Map<number, string[]>;
} {
  const general: string[] = [];
  const byRule = new Map<number, string[]>();
  for (const i of issues) {
    const text = i.field ? `${i.field}: ${i.message}` : i.message;
    if (i.ruleIndex === undefined) general.push(text);
    else byRule.set(i.ruleIndex, [...(byRule.get(i.ruleIndex) ?? []), text]);
  }
  return { general, byRule };
}
