/** Recorded ESPN responses (2025 postseason) for tests: trimmed copies, see __fixtures__/espn. */
import { readFileSync } from "node:fs";
import type { PoolPlayerRef } from "./espn-stat-mapping";
import { parseEspnStandings } from "./espn";
import { parseEspnSummary, type ParsedSummary } from "./espn-boxscore";
import { parseEspnScoreboard, type ScoreboardGame } from "./espn-scoreboard";

const read = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/espn/${name}`, import.meta.url), "utf8"));

export const SCOREBOARD_WEEKS = [1, 2, 3, 5] as const;
export { parseEspnStandings };
export const standingsJson = (): unknown =>
  JSON.parse(
    readFileSync(
      new URL("./__fixtures__/espn-standings-2025.trimmed.json", import.meta.url),
      "utf8",
    ),
  );
export const scoreboardJson = (week: number) => read(`scoreboard-week${week}.json`);
export const summaryJson = (eventId: string) => read(`summary-${eventId}.json`);

/** Round (1-4) of each recorded week. */
export const ROUND_OF_WEEK: Record<number, number> = { 1: 1, 2: 2, 3: 3, 5: 4 };
export const allScoreboards = (): { round: number; games: ScoreboardGame[] }[] =>
  SCOREBOARD_WEEKS.map((w) => ({
    round: ROUND_OF_WEEK[w]!,
    games: parseEspnScoreboard(scoreboardJson(w)),
  }));
export const allEventIds = (): string[] =>
  allScoreboards().flatMap((r) => r.games.map((g) => g.gameId));
export const summary = (eventId: string): ParsedSummary => parseEspnSummary(summaryJson(eventId));

export const EVENTS = {
  golden: "401772979", // LAR @ CAR, Wild Card
  gbChi: "401772981",
  neDen: "401772986",
  houPit: "401772976",
  sfSea: "401772984",
  superBowl: "401772988", // SEA vs NE
} as const;

/** A pool containing every fantasy-relevant box-score athlete of the game, matched by ESPN id. */
export function poolFromSummary(s: ParsedSummary): PoolPlayerRef[] {
  const abbr = (teamId: string) => (s.home.id === teamId ? s.home.abbr : s.away.abbr);
  const out: PoolPlayerRef[] = s.athletes.map((a) => ({
    playerId: `espn-${a.id}`,
    name: a.name,
    position: a.stats.kicking ? "K" : a.stats.passing ? "QB" : a.stats.receiving ? "WR" : "RB",
    nflTeam: abbr(a.teamId),
    espnId: a.id,
  }));
  for (const t of [s.home, s.away])
    out.push({
      playerId: `DST-${t.abbr}`,
      name: `${t.abbr} D/ST`,
      position: "DST",
      nflTeam: t.abbr,
    });
  return out;
}
