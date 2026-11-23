/**
 * ESPN postseason scoreboard -> games (docs/design/12). The endpoint is unofficial, so the parts
 * we read are validated strictly and anything else is ignored.
 */
import type { LiveGameStatus } from "@dnp/domain";
import { z } from "zod";
import { PoolSourceError } from "./types";

export interface ScoreboardGame {
  /** ESPN event id; also our `gameId`. */
  gameId: string;
  /** ISO timestamp. */
  kickoff: string;
  status: LiveGameStatus;
  /** ESPN team abbreviations. */
  home: string;
  away: string;
  homeScore: number;
  awayScore: number;
  /** Abbreviation of the winner of a final game; absent for a tie or an unfinished game. */
  winner?: string;
}

const statusType = z.object({ name: z.string(), completed: z.boolean().optional() });
const score = z.union([z.string(), z.number()]).transform((v) => Number(v));
const competitor = z.object({
  homeAway: z.enum(["home", "away"]),
  score: score.optional(),
  winner: z.boolean().optional(),
  team: z.object({ abbreviation: z.string().min(1) }),
});
const event = z.object({
  id: z.string().min(1),
  date: z.string().min(1),
  status: z.object({ type: statusType }),
  competitions: z.array(z.object({ competitors: z.array(competitor).length(2) })).min(1),
});
const scoreboard = z.object({ events: z.array(event) });

/** ESPN states that mean "not started" even though the game is on the schedule. */
const NOT_STARTED = new Set(["STATUS_SCHEDULED", "STATUS_POSTPONED", "STATUS_CANCELED"]);

/** Any state that is neither final nor not-started counts as in progress (halftime, delays, ...). */
export function liveStatusOf(type: { name: string; completed?: boolean }): LiveGameStatus {
  if (type.completed === true || type.name === "STATUS_FINAL") return "final";
  return NOT_STARTED.has(type.name) ? "scheduled" : "in_progress";
}

/** Home/away teams, scores and (for a final game) the winner from the two competitors. */
export function readCompetitors(
  competitors: readonly z.infer<typeof competitor>[],
  status: LiveGameStatus,
): Pick<ScoreboardGame, "home" | "away" | "homeScore" | "awayScore" | "winner"> | undefined {
  const home = competitors.find((c) => c.homeAway === "home");
  const away = competitors.find((c) => c.homeAway === "away");
  if (!home || !away) return undefined;
  const homeScore = home.score ?? 0;
  const awayScore = away.score ?? 0;
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return undefined;
  let winner: string | undefined;
  if (status === "final") {
    if (home.winner === true && away.winner !== true) winner = home.team.abbreviation;
    else if (away.winner === true && home.winner !== true) winner = away.team.abbreviation;
    else if (homeScore !== awayScore)
      winner = homeScore > awayScore ? home.team.abbreviation : away.team.abbreviation;
  }
  return {
    home: home.team.abbreviation,
    away: away.team.abbreviation,
    homeScore,
    awayScore,
    ...(winner ? { winner } : {}),
  };
}

export function parseEspnScoreboard(json: unknown): ScoreboardGame[] {
  const parsed = scoreboard.safeParse(json);
  if (!parsed.success) throw new PoolSourceError("ESPN scoreboard had an unexpected shape");
  return parsed.data.events.map((e) => {
    const status = liveStatusOf(e.status.type);
    const teams = readCompetitors(e.competitions[0]!.competitors, status);
    const kickoff = new Date(e.date);
    if (!teams || Number.isNaN(kickoff.getTime()))
      throw new PoolSourceError("ESPN scoreboard had an unreadable game");
    return { gameId: e.id, kickoff: kickoff.toISOString(), status, ...teams };
  });
}
