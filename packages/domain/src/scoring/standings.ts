import { rosterPlayersForRound } from "./roster-rounds";
import {
  sumPoints,
  type GameInfo,
  type PlayerInfo,
  type RoundInfo,
  type TeamRoster,
} from "./season";

export type NflTeamStatus = "alive" | "bye" | "eliminated" | "champion";

export interface StandingsInput {
  /** Decimal places of the ruleset (for exact summing). */
  rounding: number;
  teams: TeamRoster[];
  /** TEAMSCORE rows of every round, frozen and provisional alike. */
  teamScores: { teamId: string; round: number; points: number }[];
  rounds: RoundInfo[];
  games: GameInfo[];
  players: PlayerInfo[];
  nflTeams: { abbr: string; status: NflTeamStatus }[];
}

export interface StandingRow {
  teamId: string;
  total: number;
  /** Competition ranking: ties share a rank (1, 1, 3). */
  rank: number;
  /** Tied with another team on total points (tiebreaker rules are open: Q4). */
  tied: boolean;
  playersAlive: number;
  playersTotal: number;
  maxGamesRemaining: number;
}

const LAST_ROUND = 4;

/**
 * Rounds an alive NFL team could still play (docs/design/04 §4): rounds not yet final, minus the
 * Wild Card for a bye team, minus any round it already won (a final game in that round).
 */
function gamesRemaining(abbr: string, status: NflTeamStatus, input: StandingsInput): number {
  if (status === "eliminated" || status === "champion") return 0;
  let n = 0;
  for (let round = 1; round <= LAST_ROUND; round++) {
    if (round === 1 && status === "bye") continue;
    const rs = input.rounds.find((r) => r.round === round)?.status;
    if (rs === "final" || rs === "finalized") continue;
    const played = input.games.some(
      (g) => g.round === round && g.status === "final" && (g.home === abbr || g.away === abbr),
    );
    if (!played) n++;
  }
  return n;
}

/** Cumulative standings (docs/design/04 §5): total desc, ties share a rank and are flagged. */
export function computeStandings(input: StandingsInput): StandingRow[] {
  const asOf =
    [...input.rounds].sort((a, b) => a.round - b.round).find((r) => r.status !== "finalized")
      ?.round ?? LAST_ROUND;
  const players = new Map(input.players.map((p) => [p.playerId, p]));
  const nfl = new Map(input.nflTeams.map((t) => [t.abbr, t.status]));

  const rows = input.teams.map((team) => {
    const roster = rosterPlayersForRound(team.assignments, asOf).map((id) => players.get(id));
    let playersAlive = 0;
    let maxGamesRemaining = 0;
    for (const p of roster) {
      const status = p ? nfl.get(p.nflTeam) : undefined;
      if (!p || !status || status === "eliminated") continue;
      playersAlive++;
      maxGamesRemaining += gamesRemaining(p.nflTeam, status, input);
    }
    return {
      teamId: team.teamId,
      total: sumPoints(
        input.teamScores.filter((s) => s.teamId === team.teamId).map((s) => s.points),
        input.rounding,
      ),
      playersAlive,
      playersTotal: roster.length,
      maxGamesRemaining,
    };
  });
  rows.sort((a, b) => b.total - a.total || a.teamId.localeCompare(b.teamId));
  return rows.map((r) => {
    const first = rows.findIndex((o) => o.total === r.total);
    const tied = rows.filter((o) => o.total === r.total).length > 1;
    return { ...r, rank: first + 1, tied };
  });
}
