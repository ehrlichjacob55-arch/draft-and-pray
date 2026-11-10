/** Emergency manual pool fallback (docs/design/14 §3): teams.csv + players.csv -> importer input. */
import type { PoolPlayerInput, PoolTeamInput } from "@dnp/db";
import { POSITIONS, type Position } from "@dnp/domain";

/** Minimal RFC 4180 parser: quoted fields, doubled quotes, CRLF. Returns rows of fields. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

function records(text: string, required: string[], what: string) {
  const [header, ...rest] = parseCsv(text);
  if (!header) throw new Error(`${what}: file is empty`);
  const cols = header.map((h) => h.trim());
  for (const r of required)
    if (!cols.includes(r)) throw new Error(`${what}: missing column "${r}"`);
  return rest.map((row, i) => {
    const rec: Record<string, string> = {};
    cols.forEach((c, k) => (rec[c] = (row[k] ?? "").trim()));
    return { rec, line: i + 2 };
  });
}

export function parseTeamsCsv(text: string): PoolTeamInput[] {
  const teams: PoolTeamInput[] = records(
    text,
    ["abbr", "name", "conference", "seed"],
    "teams.csv",
  ).map(({ rec, line }) => {
    const seed = Number(rec.seed);
    if (!rec.abbr || !rec.name) throw new Error(`teams.csv line ${line}: abbr and name required`);
    if (rec.conference !== "AFC" && rec.conference !== "NFC")
      throw new Error(`teams.csv line ${line}: conference must be AFC or NFC`);
    if (!Number.isInteger(seed) || seed < 1 || seed > 7)
      throw new Error(`teams.csv line ${line}: seed must be 1-7`);
    return { abbr: rec.abbr, name: rec.name, conference: rec.conference as "AFC" | "NFC", seed };
  });
  if (teams.length !== 14) throw new Error(`teams.csv: expected 14 teams, found ${teams.length}`);
  for (const conf of ["AFC", "NFC"] as const) {
    const seeds = teams.filter((t) => t.conference === conf).map((t) => t.seed);
    if (seeds.length !== 7 || new Set(seeds).size !== 7)
      throw new Error(`teams.csv: ${conf} needs seeds 1-7 exactly once`);
  }
  if (new Set(teams.map((t) => t.abbr)).size !== 14) throw new Error("teams.csv: duplicate abbr");
  return teams;
}

export function parsePlayersCsv(text: string, teams: PoolTeamInput[]): PoolPlayerInput[] {
  const abbrs = new Set(teams.map((t) => t.abbr));
  const seen = new Set<string>();
  return records(text, ["name", "position", "nflTeam"], "players.csv").map(({ rec, line }) => {
    const position = rec.position as Position;
    if (!rec.name) throw new Error(`players.csv line ${line}: name required`);
    if (!POSITIONS.includes(position) || position === "DST")
      throw new Error(`players.csv line ${line}: position must be QB, RB, WR, TE or K`);
    if (!abbrs.has(rec.nflTeam!))
      throw new Error(`players.csv line ${line}: unknown nflTeam ${rec.nflTeam}`);
    // Stable key so re-imports upsert: the given playerId, else team + name + position.
    const providerPlayerId = rec.playerId
      ? `csv:${rec.playerId}`
      : `csv:${rec.nflTeam}:${rec.name!.toLowerCase()}:${position}`;
    if (seen.has(providerPlayerId)) throw new Error(`players.csv line ${line}: duplicate player`);
    seen.add(providerPlayerId);
    return {
      providerPlayerId,
      name: rec.name,
      position,
      nflTeam: rec.nflTeam!,
      injuryStatus: rec.injuryStatus || null,
      depthChartOrder: null,
    };
  });
}
