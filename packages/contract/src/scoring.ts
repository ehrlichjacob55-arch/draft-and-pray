/**
 * Scoring-config contract (docs/design/04 §2, 06 §7): the season's versioned scoring ruleset.
 * Rules travel as raw ruleset JSON; `@dnp/domain` is the validator on both sides. Member-facing
 * payloads carry no user ids or emails (docs/design/13 §6).
 */
import { z } from "zod";

export const NOTE_MAX = 200;

/** The editable part of a ruleset version. Content is validated by the domain parser, not here. */
const rulesBody = {
  rules: z.array(z.unknown()),
  rounding: z.number(),
  note: z.string().trim().max(NOTE_MAX).optional(),
};

export const seedScoringRequest = z.object({ ruleset: z.enum(["league", "placeholder"]) });
export type SeedScoringRequest = z.infer<typeof seedScoringRequest>;

/** PUT /seasons/:seasonId/scoring/versions/:version (unlocked versions only). */
export const updateScoringRequest = z.object(rulesBody);
export type UpdateScoringRequest = z.infer<typeof updateScoringRequest>;

/** POST /seasons/:seasonId/scoring/versions: the next version; `activate` makes it the active one. */
export const createScoringVersionRequest = z.object({
  ...rulesBody,
  activate: z.boolean(),
});
export type CreateScoringVersionRequest = z.infer<typeof createScoringVersionRequest>;

export const scoringVersionSummary = z.object({
  version: z.number().int(),
  locked: z.boolean(),
  active: z.boolean(),
  createdAt: z.string(),
  note: z.string().nullable(),
  lockedAt: z.string().nullable(),
  /** Commissioner view only: who made the version ("system" = seeded outside the app). */
  by: z.enum(["commissioner", "system"]).optional(),
});
export type ScoringVersionSummary = z.infer<typeof scoringVersionSummary>;

export const activeScoring = z.object({
  version: z.number().int(),
  name: z.string().nullable(),
  rounding: z.number().int(),
  /** The stored rule JSON, in order. */
  rules: z.array(z.record(z.string(), z.unknown())),
  locked: z.boolean(),
  lockedAt: z.string().nullable(),
  note: z.string().nullable(),
});
export type ActiveScoring = z.infer<typeof activeScoring>;

/** GET and every write under /seasons/:seasonId/scoring return the season's current state. */
export const scoringResponse = z.object({
  seasonId: z.string(),
  active: activeScoring.nullable(),
  versions: z.array(scoringVersionSummary),
});
export type ScoringResponse = z.infer<typeof scoringResponse>;
