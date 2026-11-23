/**
 * Live ESPN source for the stats ingest (docs/design/12): the four postseason scoreboards and
 * per-game summaries, fetched politely (descriptive User-Agent, short timeouts) and parsed
 * strictly. Tests swap this interface for recorded fixtures; they never touch the network.
 */
import type { ParsedSummary } from "./espn-boxscore";
import { parseEspnSummary } from "./espn-boxscore";
import { parseEspnScoreboard, type ScoreboardGame } from "./espn-scoreboard";
import { fetchJson, type FetchLike } from "./http";

export interface RoundGames {
  /** 1 = Wild Card ... 4 = Super Bowl. */
  round: number;
  games: ScoreboardGame[];
}

export interface LiveSource {
  /** The four rounds' games for a season (`field` = the playoff teams' ESPN abbreviations). */
  fetchRoundGames(year: number, field: ReadonlySet<string>): Promise<RoundGames[]>;
  /** One game's box score and plays; `eventId` is the game id. */
  fetchSummary(eventId: string): Promise<ParsedSummary>;
}

const SITE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
/** ESPN postseason weeks: 1 Wild Card, 2 Divisional, 3 Conference, 4 Pro Bowl, 5 Super Bowl. */
const ROUND_WEEKS = [1, 2, 3, 5] as const;
const PRO_BOWL_WEEK = 4;

export function createEspnLiveSource(opts: { fetchImpl?: FetchLike } = {}): LiveSource {
  const scoreboard = async (year: number, week: number) =>
    parseEspnScoreboard(
      await fetchJson(`${SITE}/scoreboard?seasontype=3&dates=${year}&week=${week}`, {
        fetchImpl: opts.fetchImpl,
        timeoutMs: 10_000,
        label: `ESPN scoreboard (week ${week})`,
      }),
    );
  return {
    async fetchRoundGames(year, field) {
      const weeks = await Promise.all(ROUND_WEEKS.map((w) => scoreboard(year, w)));
      const rounds: RoundGames[] = weeks.map((games, i) => ({ round: i + 1, games }));
      // Some seasons number the Super Bowl week 4: when week 5 is empty and week 4 holds exactly
      // one game between two playoff teams (not the Pro Bowl), that is the Super Bowl.
      if (rounds[3]!.games.length === 0) {
        const week4 = await scoreboard(year, PRO_BOWL_WEEK);
        const [only] = week4;
        if (week4.length === 1 && only && field.has(only.home) && field.has(only.away))
          rounds[3] = { round: 4, games: week4 };
      }
      return rounds;
    },
    async fetchSummary(eventId) {
      return parseEspnSummary(
        await fetchJson(`${SITE}/summary?event=${encodeURIComponent(eventId)}`, {
          fetchImpl: opts.fetchImpl,
          timeoutMs: 15_000,
          label: `ESPN game ${eventId}`,
        }),
      );
    },
  };
}
