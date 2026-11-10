/** Pool sources (docs/design/14 §3): swappable behind `PoolSource` after the stats-provider spike. */
import type { PoolPlayerInput, PoolTeamInput } from "@dnp/db";

export interface PoolData {
  teams: PoolTeamInput[];
  /** Real players only; the importer generates one DST per team. */
  players: PoolPlayerInput[];
  /** Non-fatal notes for the commissioner (no PII), e.g. depth-chart fallbacks. */
  warnings?: string[];
}

/** Playoff field + seeds for a season. */
export interface FieldSource {
  fetchField(seasonYear: number): Promise<PoolTeamInput[]>;
}

/** Skill players + kickers on the field's teams. */
export interface PlayerSource {
  fetchPlayers(field: PoolTeamInput[]): Promise<{ players: PoolPlayerInput[]; warnings: string[] }>;
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
