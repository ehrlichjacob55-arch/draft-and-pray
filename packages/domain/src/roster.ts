/** League roster constants. See docs/design/03-draft-design.md §3 and README. */

export const TEAM_COUNT = 9;
export const ROUNDS = 10;
export const ROSTER_SIZE = 10;
export const TOTAL_PICKS = TEAM_COUNT * ROUNDS; // 90

export const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"] as const;
export type Position = (typeof POSITIONS)[number];

export const SLOTS = [
  "QB",
  "RB1",
  "RB2",
  "WR1",
  "WR2",
  "TE",
  "FLEX1",
  "FLEX2",
  "DST",
  "K",
] as const;
export type Slot = (typeof SLOTS)[number];

/** Most-specific-first slot preference for auto-assignment (FLEX = RB/WR/TE). */
export const SLOT_PREFERENCE: Record<Position, readonly Slot[]> = {
  QB: ["QB"],
  RB: ["RB1", "RB2", "FLEX1", "FLEX2"],
  WR: ["WR1", "WR2", "FLEX1", "FLEX2"],
  TE: ["TE", "FLEX1", "FLEX2"],
  K: ["K"],
  DST: ["DST"],
};

export const PLAYOFF_ROUNDS = ["WC", "DIV", "CONF", "SB"] as const;
export type PlayoffRound = (typeof PLAYOFF_ROUNDS)[number];
