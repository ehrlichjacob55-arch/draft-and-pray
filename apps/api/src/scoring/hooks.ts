import type { Dynamo } from "@dnp/db";
import { logError } from "../redact";
import type { Publisher } from "../realtime/types";
import { scoresPublisher } from "./publish";
import { recomputeSeason } from "./recompute";

/** What changed about a season's scoring rules, for whatever has to react to it. */
export interface RulesetChange {
  seasonId: string;
  /** The active version after the change. */
  version: number;
  reason: "seed" | "update" | "create" | "activate";
}

/** Called after a change that alters the points the active ruleset produces. */
export type RulesetChangeHook = (change: RulesetChange) => Promise<void>;

/** Called after rosters change (the draft completes, a redraft finalizes, a draft is undone from complete). */
export type RostersChangedHook = (seasonId: string) => Promise<void>;

export interface ScoringHookDeps {
  db: Dynamo;
  publisher: Publisher;
  now: () => Date;
}

/**
 * docs/design/10 §4.4: recompute POINTS/TEAMSCORE for every non-finalized round (finalized rounds
 * stay frozen) and broadcast `scores_updated`. Best-effort: a failure is logged and never fails
 * the commissioner action or the pick that triggered it (the next ingest run recomputes anyway).
 * Locking a ruleset changes no points and does not call it.
 */
export function createScoringHooks({ db, publisher, now }: ScoringHookDeps): {
  onRulesetChange: RulesetChangeHook;
  onRostersChanged: RostersChangedHook;
} {
  const run = async (seasonId: string, why: string) => {
    try {
      await recomputeSeason(db, seasonId, scoresPublisher(publisher, seasonId, now), now());
    } catch (err) {
      logError(`Recompute after ${why} failed`, err);
    }
  };
  return {
    onRulesetChange: (change) => run(change.seasonId, `ruleset ${change.reason}`),
    onRostersChanged: (seasonId) => run(seasonId, "a roster change"),
  };
}
