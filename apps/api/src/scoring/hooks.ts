/** What changed about a season's scoring rules, for whatever has to react to it. */
export interface RulesetChange {
  seasonId: string;
  /** The active version after the change. */
  version: number;
  reason: "seed" | "update" | "create" | "activate";
}

/** Called after a change that alters the points the active ruleset produces. */
export type RulesetChangeHook = (change: RulesetChange) => Promise<void>;

/**
 * TODO(Task 9/10, docs/design/10 §4.4): recompute POINTS/TEAMSCORE for every non-finalized round
 * with the new ruleset (finalized rounds stay frozen) and publish `scores_updated`. No scoring
 * data exists yet, so for now this does nothing; the routes already call it at the right moments
 * (seed, update of the active version, create+activate, activate). Lock does not change points
 * and does not call it.
 */
export const recomputeAfterRulesetChange: RulesetChangeHook = async () => {};
