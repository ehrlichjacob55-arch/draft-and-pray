/**
 * Sleeper last-season stats (docs/design/14 §3): one request, keyed by Sleeper player_id, with
 * team defenses keyed by team abbreviation. Display only; never used for scoring.
 */
import { STAT_KEYS } from "@dnp/contract";
import type { Position } from "@dnp/domain";
import { toSleeperAbbr } from "./abbreviations";
import { fetchJson, type FetchLike } from "./http";
import { PoolSourceError, type StatsLookup, type StatsSource } from "./types";

type RawStats = Record<string, unknown>;

/** Sleeper sends floats like 17.0; keep integers only (rounded), anything else is 0. */
const toInt = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;

/** Only the listed keys for the position; missing keys are 0. */
export function statLine(position: Position, raw: RawStats): Record<string, number> {
  const line: Record<string, number> = {};
  for (const key of STAT_KEYS[position]) line[key] = toInt(raw[key]);
  return line;
}

export function parseSleeperStats(json: unknown): StatsLookup {
  if (!json || typeof json !== "object" || Array.isArray(json))
    throw new PoolSourceError("Sleeper stats had an unexpected shape");
  const entries = json as Record<string, unknown>;
  const entry = (id: string): RawStats | null => {
    const e = Object.hasOwn(entries, id) ? entries[id] : undefined;
    return e && typeof e === "object" && !Array.isArray(e) ? (e as RawStats) : null;
  };
  return {
    forPlayer(id, position) {
      const e = entry(id);
      return e ? statLine(position, e) : null;
    },
    forTeam(espnAbbr) {
      const e = entry(toSleeperAbbr(espnAbbr));
      return e ? statLine("DST", e) : null;
    },
  };
}

export function createSleeperStatsSource(opts: { fetchImpl?: FetchLike } = {}): StatsSource {
  return {
    async fetchStats(seasonYear) {
      const json = await fetchJson(`https://api.sleeper.app/v1/stats/nfl/regular/${seasonYear}`, {
        fetchImpl: opts.fetchImpl,
        timeoutMs: 20_000,
        label: "Sleeper stats",
      });
      return parseSleeperStats(json);
    },
  };
}
