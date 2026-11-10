import { createEspnFieldSource } from "./espn";
import type { FetchLike } from "./http";
import { createSleeperPlayerSource } from "./sleeper";
import type { FieldSource, PlayerSource, PoolSource } from "./types";

export * from "./types";
export * from "./abbreviations";
export { parseEspnStandings, createEspnFieldSource } from "./espn";
export {
  parseSleeperPlayers,
  parseSleeperPlayersWithWarnings,
  createSleeperPlayerSource,
} from "./sleeper";
export { PROVIDER_USER_AGENT, type FetchLike } from "./http";

export function composePoolSource(
  source: string,
  field: FieldSource,
  players: PlayerSource,
): PoolSource {
  return {
    source,
    async load(seasonYear) {
      const teams = await field.fetchField(seasonYear);
      return { teams, ...(await players.fetchPlayers(teams)) };
    },
  };
}

/** ESPN standings (field + seeds) and Sleeper players. */
export function createRealPoolSource(opts: { fetchImpl?: FetchLike } = {}): PoolSource {
  return composePoolSource(
    "espn+sleeper",
    createEspnFieldSource(opts),
    createSleeperPlayerSource(opts),
  );
}
