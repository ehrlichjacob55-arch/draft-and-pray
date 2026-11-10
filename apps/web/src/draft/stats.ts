import type { AvailablePlayer, PositionName, StatLine } from "@dnp/contract";
import { STAT_KEYS } from "@dnp/contract";

/** One displayed stat column. Composite columns (Cmp/Att) sort by their first stat. */
export interface StatCol {
  id: string;
  label: string;
  /** Key(s) read from the stat line: one value, or made/attempted. */
  keys: readonly [string] | readonly [string, string];
}

const c = (id: string, label: string, ...keys: [string] | [string, string]): StatCol => ({
  id,
  label,
  keys,
});

export const STAT_COLS: Record<PositionName | "ALL", readonly StatCol[]> = {
  ALL: [
    c("gp", "GP", "gp"),
    c("pass_yd", "Pass Yd", "pass_yd"),
    c("pass_td", "Pass TD", "pass_td"),
    c("rush_yd", "Rush Yd", "rush_yd"),
    c("rush_td", "Rush TD", "rush_td"),
    c("rec", "Rec", "rec"),
    c("rec_yd", "Rec Yd", "rec_yd"),
    c("rec_td", "Rec TD", "rec_td"),
  ],
  QB: [
    c("gp", "GP", "gp"),
    c("cmp_att", "Cmp/Att", "pass_cmp", "pass_att"),
    c("pass_yd", "Pass Yd", "pass_yd"),
    c("pass_td", "Pass TD", "pass_td"),
    c("pass_int", "INT", "pass_int"),
    c("rush_yd", "Rush Yd", "rush_yd"),
    c("rush_td", "Rush TD", "rush_td"),
  ],
  RB: [
    c("gp", "GP", "gp"),
    c("rush_att", "Rush Att", "rush_att"),
    c("rush_yd", "Rush Yd", "rush_yd"),
    c("rush_td", "Rush TD", "rush_td"),
    c("rec", "Rec", "rec"),
    c("rec_yd", "Rec Yd", "rec_yd"),
    c("rec_td", "Rec TD", "rec_td"),
  ],
  WR: [
    c("gp", "GP", "gp"),
    c("rec_tgt", "Tgt", "rec_tgt"),
    c("rec", "Rec", "rec"),
    c("rec_yd", "Rec Yd", "rec_yd"),
    c("rec_td", "Rec TD", "rec_td"),
    c("rush_yd", "Rush Yd", "rush_yd"),
  ],
  TE: [
    c("gp", "GP", "gp"),
    c("rec_tgt", "Tgt", "rec_tgt"),
    c("rec", "Rec", "rec"),
    c("rec_yd", "Rec Yd", "rec_yd"),
    c("rec_td", "Rec TD", "rec_td"),
    c("rush_yd", "Rush Yd", "rush_yd"),
  ],
  K: [
    c("gp", "GP", "gp"),
    c("fg", "FGM/FGA", "fgm", "fga"),
    c("fgm_50p", "FG 50+", "fgm_50p"),
    c("xp", "XPM/XPA", "xpm", "xpa"),
  ],
  DST: [
    c("gp", "GP", "gp"),
    c("sack", "Sacks", "sack"),
    c("int", "INT", "int"),
    c("fum_rec", "Fum Rec", "fum_rec"),
    c("def_td", "Def TD", "def_td"),
    c("def_st_td", "ST TD", "def_st_td"),
    c("pts_allow", "Pts Allowed", "pts_allow"),
  ],
};

/** 2-3 headline stat column ids per position (phone rows). */
export const HEADLINE: Record<PositionName, readonly string[]> = {
  QB: ["pass_yd", "pass_td", "pass_int"],
  RB: ["rush_yd", "rush_td", "rec_yd"],
  WR: ["rec", "rec_yd", "rec_td"],
  TE: ["rec", "rec_yd", "rec_td"],
  K: ["fg", "fgm_50p"],
  DST: ["sack", "int", "pts_allow"],
};

export const colsFor = (position: PositionName | ""): readonly StatCol[] =>
  STAT_COLS[position || "ALL"];

/** Does this position's stat line contain `key`? (Used to blank N/A cells in the "All" view.) */
const hasKey = (position: PositionName, key: string): boolean =>
  (STAT_KEYS[position] as readonly string[]).includes(key);

/** Numeric value of a column for a player; null = no stats or N/A (sorted last). */
export function statValue(
  p: Pick<AvailablePlayer, "position" | "stats">,
  col: StatCol,
): number | null {
  const stats: StatLine | null | undefined = p.stats;
  if (!stats || !hasKey(p.position, col.keys[0])) return null;
  return stats[col.keys[0]] ?? 0;
}

/** Display text: "—" with no stats entry, "" when the column does not apply to the position. */
export function statText(p: Pick<AvailablePlayer, "position" | "stats">, col: StatCol): string {
  if (!p.stats) return "—";
  if (!col.keys.every((k) => hasKey(p.position, k))) return "";
  return col.keys.map((k) => String(p.stats?.[k] ?? 0)).join("/");
}
