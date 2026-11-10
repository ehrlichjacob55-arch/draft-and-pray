/**
 * ESPN standings -> playoff field and seeds. The endpoint is unofficial and undocumented, so the
 * response is validated defensively: exactly 7 distinct seeds 1-7 per conference or we refuse.
 */
import type { PoolTeamInput } from "@dnp/db";
import { z } from "zod";
import { fetchJson, type FetchLike } from "./http";
import { PoolSourceError, type FieldSource } from "./types";

const standings = z.object({
  children: z.array(
    z.object({
      name: z.string(),
      abbreviation: z.string().optional(),
      standings: z.object({
        entries: z.array(
          z.object({
            team: z.object({ abbreviation: z.string().min(1), displayName: z.string().min(1) }),
            stats: z.array(z.object({ name: z.string(), value: z.number().optional() })),
          }),
        ),
      }),
    }),
  ),
});

const conferenceOf = (name: string, abbreviation?: string): "AFC" | "NFC" | undefined => {
  if (abbreviation === "AFC" || /american/i.test(name)) return "AFC";
  if (abbreviation === "NFC" || /national/i.test(name)) return "NFC";
  return undefined;
};

export function parseEspnStandings(json: unknown): PoolTeamInput[] {
  const parsed = standings.safeParse(json);
  if (!parsed.success) throw new PoolSourceError("ESPN standings had an unexpected shape");
  const teams: PoolTeamInput[] = [];
  const seen = new Set<string>();
  for (const child of parsed.data.children) {
    const conference = conferenceOf(child.name, child.abbreviation);
    if (!conference) continue;
    for (const entry of child.standings.entries) {
      const seed = entry.stats.find((s) => s.name === "playoffSeed")?.value;
      if (seed === undefined || !Number.isInteger(seed) || seed < 1 || seed > 7) continue;
      teams.push({
        abbr: entry.team.abbreviation,
        name: entry.team.displayName,
        conference,
        seed,
      });
    }
  }
  for (const conference of ["AFC", "NFC"] as const) {
    const seeds = teams.filter((t) => t.conference === conference).map((t) => t.seed);
    if (seeds.length !== 7 || new Set(seeds).size !== 7)
      throw new PoolSourceError(
        `ESPN standings do not show exactly 7 distinct playoff seeds for the ${conference}`,
      );
  }
  for (const t of teams) {
    if (seen.has(t.abbr)) throw new PoolSourceError(`ESPN standings list ${t.abbr} twice`);
    seen.add(t.abbr);
  }
  return teams.sort((a, b) => a.conference.localeCompare(b.conference) || a.seed - b.seed);
}

export function createEspnFieldSource(opts: { fetchImpl?: FetchLike } = {}): FieldSource {
  return {
    async fetchField(seasonYear) {
      const json = await fetchJson(
        `https://site.api.espn.com/apis/v2/sports/football/nfl/standings?season=${seasonYear}`,
        { fetchImpl: opts.fetchImpl, timeoutMs: 10_000, label: "ESPN standings" },
      );
      return parseEspnStandings(json);
    },
  };
}
