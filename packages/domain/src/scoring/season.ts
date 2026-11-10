import type { Position } from "../roster";
import type { RosterAssignment } from "./roster-rounds";
import { rosterPlayersForRound } from "./roster-rounds";
import { scorePlayerGame, type BreakdownEntry } from "./engine";
import type { Ruleset } from "./ruleset";
import type { StatKey } from "./stat-keys";
import { applyOverrides, type StatLine, type StatOverrides } from "./stat-line";

export type RoundStatus = "upcoming" | "live" | "final" | "finalized";

export interface RoundInfo {
  round: number;
  status: RoundStatus;
}
export interface GameInfo {
  gameId: string;
  round: number;
  home: string;
  away: string;
  status: string;
}
export interface PlayerInfo {
  playerId: string;
  position: Position;
  nflTeam: string;
}
export interface PlayerGameInput {
  gameId: string;
  playerId: string;
  /** Canonical stats from the provider. */
  stats: StatLine;
  overrides?: StatOverrides;
}
export interface TeamRoster {
  teamId: string;
  assignments: RosterAssignment[];
}

export interface SeasonInput {
  ruleset: Ruleset;
  rounds: RoundInfo[];
  games: GameInfo[];
  players: PlayerInfo[];
  playerGames: PlayerGameInput[];
  teams: TeamRoster[];
}

export interface PointsRow {
  gameId: string;
  playerId: string;
  round: number;
  points: number;
  breakdown: BreakdownEntry[];
  rulesetVersion: number;
  overridden: StatKey[];
}
export interface TeamScoreRow {
  teamId: string;
  round: number;
  points: number;
  /** True while the round is not finalized (every emitted row, since finalized rounds are frozen). */
  provisional: boolean;
}
export interface ScoreIssue {
  gameId: string;
  playerId: string;
  message: string;
}
export interface SeasonResult {
  points: PointsRow[];
  teamScores: TeamScoreRow[];
  /** Player-games that could not be scored; they are left out instead of failing the recompute. */
  issues: ScoreIssue[];
}

/** Sums point values exactly: through integers at `decimals` places. */
export function sumPoints(values: Iterable<number>, decimals: number): number {
  const f = 10 ** decimals;
  let total = 0;
  for (const v of values) total += Math.round(v * f);
  return total / f;
}

/**
 * docs/design/10 §4.4 step 3: POINTS (per player-game) and TEAMSCORE (per round + team) for
 * non-finalized rounds only. Finalized rounds are never emitted. A team's round score is the sum
 * of the points, in that round's games, of the players its slots hold in that round.
 */
export function computeSeason(input: SeasonInput): SeasonResult {
  const { ruleset } = input;
  const roundStatus = new Map(input.rounds.map((r) => [r.round, r.status]));
  const games = new Map(input.games.map((g) => [g.gameId, g]));
  const players = new Map(input.players.map((p) => [p.playerId, p]));
  const points: PointsRow[] = [];
  const issues: ScoreIssue[] = [];

  for (const pg of input.playerGames) {
    const game = games.get(pg.gameId);
    const player = players.get(pg.playerId);
    const fail = (message: string) =>
      issues.push({ gameId: pg.gameId, playerId: pg.playerId, message });
    if (!game) {
      fail("unknown game");
      continue;
    }
    if (roundStatus.get(game.round) === "finalized") continue;
    if (!player) {
      fail("unknown player");
      continue;
    }
    try {
      const { statLine, overridden } = applyOverrides(pg.stats, pg.overrides ?? {});
      const score = scorePlayerGame(ruleset, player.position, statLine);
      points.push({
        gameId: pg.gameId,
        playerId: pg.playerId,
        round: game.round,
        points: score.points,
        breakdown: score.breakdown,
        rulesetVersion: ruleset.version,
        overridden,
      });
    } catch (err) {
      fail((err as Error).message);
    }
  }

  const teamScores: TeamScoreRow[] = [];
  const open = input.rounds
    .filter((r) => r.status !== "finalized")
    .sort((a, b) => a.round - b.round);
  for (const { round } of open) {
    const inRound = points.filter((p) => p.round === round);
    for (const team of input.teams) {
      const roster = new Set(rosterPlayersForRound(team.assignments, round));
      teamScores.push({
        teamId: team.teamId,
        round,
        points: sumPoints(
          inRound.filter((p) => roster.has(p.playerId)).map((p) => p.points),
          ruleset.rounding,
        ),
        provisional: true,
      });
    }
  }
  return { points, teamScores, issues };
}
