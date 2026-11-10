/**
 * Sleeper players -> pool players for the playoff field. Sleeper asks for at most one fetch per
 * day; the import is a commissioner action, so that holds.
 */
import type { PoolPlayerInput, PoolTeamInput } from "@dnp/db";
import { POSITIONS, type Position } from "@dnp/domain";
import { toEspnAbbr } from "./abbreviations";
import { fetchJson, type FetchLike } from "./http";
import { PoolSourceError, type PlayerSource } from "./types";

const FANTASY_POSITIONS = POSITIONS.filter((p) => p !== "DST") as Position[];

interface SleeperPlayer {
  player_id?: unknown;
  full_name?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  position?: unknown;
  team?: unknown;
  status?: unknown;
  injury_status?: unknown;
  depth_chart_order?: unknown;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

export interface ParsedSleeperPlayers {
  players: PoolPlayerInput[];
  warnings: string[];
}

export function parseSleeperPlayers(json: unknown, field: PoolTeamInput[]): PoolPlayerInput[] {
  return parseSleeperPlayersWithWarnings(json, field).players;
}

/**
 * Keeps Active players with a depth-chart entry (Sleeper still lists retired and practice-squad
 * players as Active, without one). Safety net: a field team with zero players at a draftable
 * position gets its Active players there regardless of depth chart, with a warning.
 */
export function parseSleeperPlayersWithWarnings(
  json: unknown,
  field: PoolTeamInput[],
): ParsedSleeperPlayers {
  if (!json || typeof json !== "object" || Array.isArray(json))
    throw new PoolSourceError("Sleeper players had an unexpected shape");
  const fieldAbbrs = new Set(field.map((t) => t.abbr));
  const out: PoolPlayerInput[] = [];
  const noDepth: PoolPlayerInput[] = [];
  for (const raw of Object.values(json as Record<string, SleeperPlayer>)) {
    if (!raw || typeof raw !== "object") continue;
    const team = str(raw.team);
    const position = str(raw.position) as Position | undefined;
    const id = str(raw.player_id);
    if (!team || !position || !id) continue;
    const nflTeam = toEspnAbbr(team);
    if (!fieldAbbrs.has(nflTeam)) continue;
    if (!FANTASY_POSITIONS.includes(position)) continue;
    if (raw.status !== "Active") continue;
    const name =
      str(raw.full_name) ?? [str(raw.first_name), str(raw.last_name)].filter(Boolean).join(" ");
    if (!name) continue;
    const injury = str(raw.injury_status);
    const depth =
      typeof raw.depth_chart_order === "number" && Number.isInteger(raw.depth_chart_order)
        ? raw.depth_chart_order
        : null;
    (raw.depth_chart_order == null ? noDepth : out).push({
      providerPlayerId: id,
      name,
      position,
      nflTeam,
      injuryStatus: injury && injury !== "NA" ? injury : null,
      depthChartOrder: depth,
    });
  }
  const warnings: string[] = [];
  const covered = new Set(out.map((p) => `${p.nflTeam}|${p.position}`));
  for (const team of field) {
    for (const position of FANTASY_POSITIONS) {
      if (covered.has(`${team.abbr}|${position}`)) continue;
      const fallback = noDepth.filter((p) => p.nflTeam === team.abbr && p.position === position);
      if (fallback.length === 0) continue;
      out.push(...fallback);
      warnings.push(
        `${team.abbr} ${position}: no depth-chart players; included ${fallback.length} without depth chart`,
      );
    }
  }
  const withPlayers = new Set(out.map((p) => p.nflTeam));
  const missing = field.filter((t) => !withPlayers.has(t.abbr)).map((t) => t.abbr);
  if (missing.length > 0)
    throw new PoolSourceError(`Sleeper has no active players for: ${missing.join(", ")}`);
  out.sort((a, b) => a.nflTeam.localeCompare(b.nflTeam) || a.name.localeCompare(b.name));
  return { players: out, warnings };
}

export function createSleeperPlayerSource(opts: { fetchImpl?: FetchLike } = {}): PlayerSource {
  return {
    async fetchPlayers(field) {
      const json = await fetchJson("https://api.sleeper.app/v1/players/nfl", {
        fetchImpl: opts.fetchImpl,
        timeoutMs: 20_000,
        label: "Sleeper players",
      });
      return parseSleeperPlayersWithWarnings(json, field);
    },
  };
}
