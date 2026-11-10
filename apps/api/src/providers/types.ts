/** Pool sources (docs/design/14 §3): swappable behind `PoolSource` after the stats-provider spike. */
import type { Position } from "@dnp/domain";
import type { PoolPlayerInput, PoolTeamInput } from "@dnp/db";

export interface PoolData {
  teams: PoolTeamInput[];
  /** Real players only; the importer generates one DST per team. */
  players: PoolPlayerInput[];
  /** Non-fatal notes for the commissioner (no PII), e.g. depth-chart fallbacks. */
  warnings?: string[];
  /** Season of the stats on `players` / `dstStats`; absent when stats were unavailable. */
  statsSeason?: number;
  /** DST stat lines by (ESPN) team abbr; null = no entry. */
  dstStats?: Record<string, Record<string, number> | null>;
}

/** Playoff field + seeds for a season. */
export interface FieldSource {
  fetchField(seasonYear: number): Promise<PoolTeamInput[]>;
}

/** Skill players + kickers on the field's teams. */
export interface PlayerSource {
  fetchPlayers(field: PoolTeamInput[]): Promise<{ players: PoolPlayerInput[]; warnings: string[] }>;
}

export interface StatsLookup {
  /** Stat line for a player (filtered per position) or null when there is no stats entry. */
  forPlayer(providerPlayerId: string, position: Position): Record<string, number> | null;
  /** DST stat line for an ESPN team abbr, or null. */
  forTeam(espnAbbr: string): Record<string, number> | null;
}

/** Last-season stats; display only. */
export interface StatsSource {
  fetchStats(seasonYear: number): Promise<StatsLookup>;
}

export interface PoolSource {
  /** Short label stored on the POOLIMPORT record, e.g. `espn+sleeper`. */
  readonly source: string;
  load(seasonYear: number): Promise<PoolData>;
}

/** A source returned something unusable; the message is safe to show the commissioner. */
export class PoolSourceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PoolSourceError";
  }
}
