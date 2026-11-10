import { logError } from "../redact";
import { createEspnFieldSource } from "./espn";
import type { FetchLike } from "./http";
import { createSleeperPlayerSource } from "./sleeper";
import { createSleeperStatsSource } from "./sleeper-stats";
import type { FieldSource, PlayerSource, PoolSource, StatsSource } from "./types";

export * from "./types";
export * from "./abbreviations";
export { parseEspnStandings, createEspnFieldSource } from "./espn";
export {
  parseSleeperPlayers,
  parseSleeperPlayersWithWarnings,
  createSleeperPlayerSource,
} from "./sleeper";
export { parseSleeperStats, createSleeperStatsSource, statLine } from "./sleeper-stats";
export { PROVIDER_USER_AGENT, type FetchLike } from "./http";

export function composePoolSource(
  source: string,
  field: FieldSource,
  players: PlayerSource,
  stats?: StatsSource,
): PoolSource {
  return {
    source,
    async load(seasonYear) {
      const teams = await field.fetchField(seasonYear);
      const fetched = await players.fetchPlayers(teams);
      if (!stats) return { teams, ...fetched };
      // Stats are display-only: a failure must not fail the import.
      let lookup;
      try {
        lookup = await stats.fetchStats(seasonYear);
      } catch (err) {
        logError("Sleeper stats failed", err);
        return {
          teams,
          players: fetched.players,
          warnings: [...fetched.warnings, `stats unavailable for ${seasonYear}`],
        };
      }
      const dstStats: Record<string, Record<string, number> | null> = {};
      for (const t of teams) dstStats[t.abbr] = lookup.forTeam(t.abbr);
      return {
        teams,
        players: fetched.players.map((p) => ({
          ...p,
          stats: p.providerPlayerId ? lookup.forPlayer(p.providerPlayerId, p.position) : null,
        })),
        warnings: fetched.warnings,
        statsSeason: seasonYear,
        dstStats,
      };
    },
  };
}

/** ESPN standings (field + seeds) and Sleeper players. */
export function createRealPoolSource(opts: { fetchImpl?: FetchLike } = {}): PoolSource {
  return composePoolSource(
    "espn+sleeper",
    createEspnFieldSource(opts),
    createSleeperPlayerSource(opts),
    createSleeperStatsSource(opts),
  );
}
