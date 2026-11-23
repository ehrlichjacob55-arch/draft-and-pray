import { PLAYOFF_ROUNDS, type PlayoffRound } from "../roster";
import type { NflTeamStatus } from "../scoring/standings";

/** Provider-independent game state used by the live pipeline. */
export type LiveGameStatus = "scheduled" | "in_progress" | "final";

export interface LiveGame {
  /** 1 = Wild Card ... 4 = Super Bowl. */
  round: number;
  home: string;
  away: string;
  status: LiveGameStatus;
  /** Abbreviation of the winner; only meaningful for a final game (a tie has none). */
  winner?: string;
}

export interface TeamStatusInput {
  abbr: string;
  seed: number;
}
export interface TeamStatusResult {
  abbr: string;
  status: NflTeamStatus;
  eliminatedInRound?: PlayoffRound;
}

const FINAL_ROUND = PLAYOFF_ROUNDS.length;

/**
 * docs/design/04 §4: NFL team statuses as a pure function of the games, so re-running it with the
 * same games always gives the same answer (idempotent).
 *
 * - Lost a final game in round r: `eliminated`, with that round's code.
 * - Won the final game of the Super Bowl round: `champion`.
 * - Seed 1: `bye` until every Wild Card game is final (and there is at least one), then `alive`.
 * - Everyone else: `alive`.
 */
export function deriveTeamStatuses(input: {
  teams: readonly TeamStatusInput[];
  games: readonly LiveGame[];
}): TeamStatusResult[] {
  const eliminated = new Map<string, PlayoffRound>();
  const champions = new Set<string>();
  for (const g of input.games) {
    if (g.status !== "final" || g.winner === undefined) continue;
    const loser = g.winner === g.home ? g.away : g.home;
    eliminated.set(loser, PLAYOFF_ROUNDS[g.round - 1] as PlayoffRound);
    if (g.round === FINAL_ROUND) champions.add(g.winner);
  }
  const wildCard = input.games.filter((g) => g.round === 1);
  const wildCardDone = wildCard.length > 0 && wildCard.every((g) => g.status === "final");
  return input.teams.map((t): TeamStatusResult => {
    const round = eliminated.get(t.abbr);
    if (round) return { abbr: t.abbr, status: "eliminated", eliminatedInRound: round };
    if (champions.has(t.abbr)) return { abbr: t.abbr, status: "champion" };
    if (t.seed === 1 && !wildCardDone) return { abbr: t.abbr, status: "bye" };
    return { abbr: t.abbr, status: "alive" };
  });
}

export type LiveRoundStatus = "upcoming" | "live" | "final" | "finalized";

/** Games per round in the 14-team format: Wild Card 6, Divisional 4, Conference 2, Super Bowl 1. */
export const ROUND_GAME_COUNTS = [6, 4, 2, 1] as const;

/**
 * A round's status from its games. `finalized` is the commissioner's and never changes here; no
 * games, or only scheduled ones, is `upcoming`; all final is `final`; anything else is `live`.
 * With `expectedGames`, a round whose schedule is not complete yet (the provider lists later
 * matchups only once they are known) is never `final`: finished games with more to come are `live`.
 */
export function deriveRoundStatus(
  games: readonly { status: LiveGameStatus }[],
  current: LiveRoundStatus,
  expectedGames = 0,
): LiveRoundStatus {
  if (current === "finalized") return current;
  if (games.every((g) => g.status === "scheduled")) return "upcoming";
  if (games.every((g) => g.status === "final") && games.length >= expectedGames) return "final";
  return "live";
}
