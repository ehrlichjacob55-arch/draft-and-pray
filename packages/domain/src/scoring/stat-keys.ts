/**
 * Canonical stat vocabulary (docs/design/04 §2). Every stats provider adapter maps its own
 * fields to these keys, so a ruleset never depends on a provider.
 *
 * 2-point conversions are split by type (`pass_2pt`, `rush_2pt`, `rec_2pt`) rather than one
 * generic `two_pt`: the passer and the receiver of the same conversion each get a stat line, and
 * a league may want to score only some of them.
 */
export const STAT_KEYS = [
  "pass_yds",
  "pass_td",
  "pass_int",
  "pass_2pt",
  "rush_yds",
  "rush_td",
  "rush_2pt",
  "rec",
  "rec_yds",
  "rec_td",
  "rec_2pt",
  "fum_lost",
  /** Kick/punt return touchdowns (any position, including a team's DST line). */
  "ret_td",
  /** Touchdowns on a recovered fumble by an offensive/special-teams player. */
  "fum_rec_td",
  "fg_made",
  /** Missed (wide/short/no good) field goals; blocked ones are `fg_blocked`. */
  "fg_missed",
  /** Field goals blocked by the defense: a miss against the kicker (the defense's side is `def_block`). */
  "fg_blocked",
  "xp_made",
  "xp_missed",
  /** Extra points blocked by the defense (see `fg_blocked`). */
  "xp_blocked",
  /** Points the opponent scored (league rules decide whether defensive/return TDs count: Q13). */
  "def_pts_allowed",
  "def_yds_allowed",
  "def_sack",
  "def_int",
  "def_fum_rec",
  /** Defensive touchdowns (interception/fumble returns). */
  "def_td",
  "def_safety",
  /** Blocked kicks (FG, XP, punt). */
  "def_block",
] as const;
export type StatKey = (typeof STAT_KEYS)[number];

/** Stats that also carry a list of per-event distances in yards (`StatLine.events`). */
export const EVENT_STATS = ["fg_made", "fg_missed"] as const;
export type EventStat = (typeof EVENT_STATS)[number];

const STAT_KEY_SET: ReadonlySet<string> = new Set(STAT_KEYS);
const EVENT_STAT_SET: ReadonlySet<string> = new Set(EVENT_STATS);
export const isStatKey = (k: string): k is StatKey => STAT_KEY_SET.has(k);
export const isEventStat = (k: string): k is EventStat => EVENT_STAT_SET.has(k);
