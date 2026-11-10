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

export function parseSleeperPlayers(json: unknown, field: PoolTeamInput[]): PoolPlayerInput[] {
  if (!json || typeof json !== "object" || Array.isArray(json))
    throw new PoolSourceError("Sleeper players had an unexpected shape");
  const fieldAbbrs = new Set(field.map((t) => t.abbr));
  const out: PoolPlayerInput[] = [];
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
    out.push({
      providerPlayerId: id,
      name,
      position,
      nflTeam,
      injuryStatus: injury && injury !== "NA" ? injury : null,
      depthChartOrder:
        typeof raw.depth_chart_order === "number" && Number.isInteger(raw.depth_chart_order)
          ? raw.depth_chart_order
          : null,
    });
  }
  const withPlayers = new Set(out.map((p) => p.nflTeam));
  const missing = field.filter((t) => !withPlayers.has(t.abbr)).map((t) => t.abbr);
  if (missing.length > 0)
    throw new PoolSourceError(`Sleeper has no active players for: ${missing.join(", ")}`);
  return out.sort((a, b) => a.nflTeam.localeCompare(b.nflTeam) || a.name.localeCompare(b.name));
}

export function createSleeperPlayerSource(opts: { fetchImpl?: FetchLike } = {}): PlayerSource {
  return {
    async fetchPlayers(field) {
      const json = await fetchJson("https://api.sleeper.app/v1/players/nfl", {
        fetchImpl: opts.fetchImpl,
        timeoutMs: 20_000,
        label: "Sleeper players",
      });
      return parseSleeperPlayers(json, field);
    },
  };
}
