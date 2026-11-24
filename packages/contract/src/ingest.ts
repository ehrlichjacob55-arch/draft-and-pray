/**
 * Live-stats contract (docs/design/12, 10 §2 `INGEST`): the commissioner's view of the ESPN stats
 * ingest, and the realtime `scores_updated` message. No user ids, names or emails.
 */
import { z } from "zod";

/** Broadcast on the season's realtime channel whenever a recompute changed any score. */
export const scoresUpdatedEvent = z.object({
  type: z.literal("scores_updated"),
  seasonId: z.string(),
  /** ISO time of the update. */
  at: z.string(),
});
export type ScoresUpdatedEvent = z.infer<typeof scoresUpdatedEvent>;

export const ingestGame = z.object({
  gameId: z.string(),
  home: z.string(),
  away: z.string(),
  homeScore: z.number(),
  awayScore: z.number(),
  status: z.enum(["scheduled", "in_progress", "final"]),
  kickoff: z.string(),
});
export type IngestGame = z.infer<typeof ingestGame>;

export const ingestRound = z.object({
  round: z.number().int().min(1).max(4),
  code: z.enum(["WC", "DIV", "CONF", "SB"]),
  status: z.enum(["upcoming", "live", "final", "finalized"]),
  games: z.array(ingestGame),
  /** Stat overrides on this round's games. */
  overrideCount: z.number().int(),
  finalizedAt: z.string().nullable(),
  /** Set when ESPN changed stats after the round was finalized (docs/design/04 §6). */
  providerChangedAt: z.string().nullable(),
});
export type IngestRound = z.infer<typeof ingestRound>;

export const ingestSummary = z.object({
  games: z.number().int(),
  statLines: z.number().int(),
  changedStatLines: z.number().int(),
  pointsWritten: z.number().int(),
  teamScoresWritten: z.number().int(),
});
export type IngestSummary = z.infer<typeof ingestSummary>;

/** GET /seasons/:seasonId/ingest, and the response of the writes below. */
export const ingestResponse = z.object({
  enabled: z.boolean(),
  nextPollAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastError: z.string().nullable(),
  lastSummary: ingestSummary.nullable(),
  warnings: z.array(z.string()),
  rounds: z.array(ingestRound),
});
export type IngestResponse = z.infer<typeof ingestResponse>;

/** PUT /seasons/:seasonId/ingest */
export const setIngestRequest = z.object({ enabled: z.boolean() });
export type SetIngestRequest = z.infer<typeof setIngestRequest>;
