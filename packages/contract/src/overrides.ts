/**
 * Stat overrides, round finalization and standings contract (docs/design/04 §5-7, 06 §5/§7).
 * Overrides and finalization are commissioner-only; standings are visible to every member.
 * No user ids, names or emails anywhere (team names and NFL player names are fine).
 */
import { z } from "zod";

export const REASON_MAX = 200;
export const roundStatus = z.enum(["upcoming", "live", "final", "finalized"]);
export const playoffCode = z.enum(["WC", "DIV", "CONF", "SB"]);

/** One player-game's stats in canonical keys; `events` are FG/XP distances in yards. */
export const statValues = z.object({
  counts: z.record(z.string(), z.number()),
  events: z.record(z.string(), z.array(z.number())).optional(),
});
export type StatValues = z.infer<typeof statValues>;

export const breakdownEntry = z.object({
  ruleIndex: z.number().int(),
  stat: z.string(),
  label: z.string().optional(),
  value: z.number(),
  points: z.number(),
});

export const overrideEntry = z.object({
  statKey: z.string(),
  value: z.number().int(),
  reason: z.string(),
  at: z.string(),
});
export type OverrideEntry = z.infer<typeof overrideEntry>;

export const gameLine = z.object({
  playerId: z.string(),
  name: z.string(),
  position: z.string(),
  nflTeam: z.string(),
  /** The provider's stats; null when the provider has no line for this player-game. */
  provider: statValues.nullable(),
  overrides: z.array(overrideEntry),
  /** Provider stats with the overrides applied (what is scored). */
  effective: statValues,
  /** The stored POINTS row; null until one has been computed. */
  points: z.number().nullable(),
  breakdown: z.array(breakdownEntry),
  /** Why the line could not be scored (unreadable stats, an impossible override). */
  issue: z.string().optional(),
});
export type GameLine = z.infer<typeof gameLine>;

export const gameLinesResponse = z.object({
  game: z.object({
    gameId: z.string(),
    round: z.number().int(),
    roundStatus: roundStatus,
    home: z.string(),
    away: z.string(),
    homeScore: z.number(),
    awayScore: z.number(),
    status: z.string(),
  }),
  lines: z.array(gameLine),
});
export type GameLinesResponse = z.infer<typeof gameLinesResponse>;

const reason = z
  .string()
  .trim()
  .min(1, "A reason is required")
  .max(REASON_MAX, `The reason must be at most ${REASON_MAX} characters`);

/** PUT /seasons/:seasonId/overrides */
export const setOverrideRequest = z.object({
  gameId: z.string().min(1),
  playerId: z.string().min(1),
  statKey: z.string().min(1),
  value: z.number().int("The value must be a whole number").min(0, "The value cannot be negative"),
  reason,
});
export type SetOverrideRequest = z.infer<typeof setOverrideRequest>;

/** POST /seasons/:seasonId/rounds/:round/unfreeze */
export const unfreezeRoundRequest = z.object({ reason });
export type UnfreezeRoundRequest = z.infer<typeof unfreezeRoundRequest>;

// ---- Standings (GET /seasons/:seasonId/standings) ----
export const standingsRound = z.object({
  round: z.number().int(),
  code: playoffCode,
  status: roundStatus,
});

export const standingsRoundScore = z.object({
  round: z.number().int(),
  /** Null before the round has a score (the UI shows a dash). */
  points: z.number().nullable(),
  provisional: z.boolean(),
});

export const standingsRow = z.object({
  rank: z.number().int(),
  tied: z.boolean(),
  teamId: z.string(),
  teamName: z.string(),
  teamAbbr: z.string(),
  rounds: z.array(standingsRoundScore),
  total: z.number(),
  playersAlive: z.number().int(),
  playersTotal: z.number().int(),
  maxGamesRemaining: z.number().int(),
});
export type StandingsRowView = z.infer<typeof standingsRow>;

export const standingsResponse = z.object({
  /** The latest round that has started (round 1 before any has). */
  asOf: z.number().int(),
  rounds: z.array(standingsRound),
  rows: z.array(standingsRow),
  /** Top three once the Super Bowl round is finalized; tied teams share a place. */
  placings: z
    .array(
      z.object({ place: z.union([z.literal(1), z.literal(2), z.literal(3)]), teamId: z.string() }),
    )
    .nullable(),
});
export type StandingsResponse = z.infer<typeof standingsResponse>;
