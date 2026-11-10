/** Pool tooling shared by `pnpm admin` and the smoke test (docs/design/14 §3). */
import { readFileSync } from "node:fs";
import {
  getUserByEmail,
  importPool,
  listMemberships,
  listSeasonPointers,
  getLeague,
  syntheticPool,
  type Dynamo,
  type ImportPoolResult,
} from "@dnp/db";
import { createRealPoolSource } from "../../apps/api/src/providers";
import { normalizeEmail } from "@dnp/contract";
import { TEST_LEAGUE_NAME, TEST_YEAR, testUserEmail } from "./env";
import { parsePlayersCsv, parseTeamsCsv } from "./csv";

export interface SeasonFlags {
  "season-id"?: string;
  email?: string;
  league?: string;
  /** Season year of the league (NOT the NFL data year). */
  year?: string;
  "test-league"?: boolean;
}

/** Finds the league season: `--season-id`, or `--test-league`, or `--email` + `--league` [+ `--year`]. */
export async function resolveSeasonId(db: Dynamo, flags: SeasonFlags): Promise<string> {
  if (flags["season-id"]) return flags["season-id"];
  const email = flags["test-league"] ? testUserEmail(1) : flags.email;
  const leagueName = flags["test-league"] ? TEST_LEAGUE_NAME : flags.league;
  if (!email || !leagueName)
    throw new Error("Pick the season with --season-id, --test-league, or --email and --league");
  const year = Number(flags.year ?? TEST_YEAR);
  const user = await getUserByEmail(db, normalizeEmail(email));
  if (!user) throw new Error("No such commissioner");
  for (const m of await listMemberships(db, user.userId)) {
    const league = await getLeague(db, m.leagueId);
    if (league?.name !== leagueName) continue;
    const pointer = (await listSeasonPointers(db, m.leagueId)).find((p) => p.year === year);
    if (pointer) return pointer.seasonId;
  }
  throw new Error(`No league "${leagueName}" with a ${year} season for that commissioner`);
}

/** Imports from ESPN + Sleeper (network). `seasonYear` is the NFL season (2025 for mock drafts). */
export async function importRealPool(
  db: Dynamo,
  seasonId: string,
  seasonYear: number,
): Promise<ImportPoolResult> {
  const source = createRealPoolSource();
  const data = await source.load(seasonYear);
  return importPool(db, {
    seasonId,
    seasonYear,
    source: source.source,
    ...data,
    actorUserId: null,
    now: new Date().toISOString(),
  });
}

/** Synthetic, fictional pool (tests/e2e/local). */
export async function importSyntheticPool(
  db: Dynamo,
  seasonId: string,
  seasonYear: number,
): Promise<ImportPoolResult> {
  return importPool(db, {
    seasonId,
    seasonYear,
    source: "synthetic",
    ...syntheticPool(),
    actorUserId: null,
    now: new Date().toISOString(),
  });
}

/** Emergency fallback: teams.csv + players.csv. */
export async function importCsvPool(
  db: Dynamo,
  seasonId: string,
  seasonYear: number,
  teamsPath: string,
  playersPath: string,
): Promise<ImportPoolResult> {
  const teams = parseTeamsCsv(readFileSync(teamsPath, "utf8"));
  const players = parsePlayersCsv(readFileSync(playersPath, "utf8"), teams);
  return importPool(db, {
    seasonId,
    seasonYear,
    source: "csv",
    teams,
    players,
    actorUserId: null,
    now: new Date().toISOString(),
  });
}
