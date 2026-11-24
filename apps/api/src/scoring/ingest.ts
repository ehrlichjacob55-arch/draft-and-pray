/**
 * Live stats ingest (docs/design/12, 04 §3, 10 §4.4): poll ESPN, upsert games and per-game stat
 * lines, derive eliminations and round statuses, recompute scores, and schedule the next poll.
 * Idempotent: re-running with unchanged provider data writes nothing.
 */
import { createHash } from "node:crypto";
import {
  DomainError,
  acquireIngestLease,
  ensureRounds,
  finishIngestRun,
  getSeasonMeta,
  listRounds,
  loadSeason,
  markGameStatsFetched,
  markProviderChanged,
  updateNflTeamStatuses,
  updateRoundStatuses,
  upsertGameStats,
  upsertGames,
  type Dynamo,
  type GameItem,
  type GameWrite,
  type SeasonSnapshot,
  type StatLineWrite,
} from "@dnp/db";
import {
  ROUND_GAME_COUNTS,
  canonicalStatLineJson,
  deriveRoundStatus,
  deriveTeamStatuses,
  nextPollDelay,
  type LiveGameStatus,
  type LiveRoundStatus,
  type StatLine,
} from "@dnp/domain";
import {
  PoolSourceError,
  mapSummaryToStatLines,
  type LiveSource,
  type PoolPlayerRef,
} from "../providers";
import { logError } from "../redact";
import type { PublishScores } from "./publish";
import { recomputeSeason } from "./recompute";

/** A run holds the lease this long; a crashed run's lease simply expires. */
export const LEASE_TTL_MS = 5 * 60_000;
/** After a failed run, try again in this long. */
export const RETRY_AFTER_ERROR_MS = 15 * 60_000;
/** Final games are re-fetched this often (stat corrections, also after finalization to flag provider changes). */
export const FINAL_REFETCH_MS = 6 * 60 * 60_000;
/** Concurrent game-summary fetches. */
export const SUMMARY_CONCURRENCY = 4;

type IngestGame = Omit<GameWrite, "status"> & { status: LiveGameStatus };

export interface RunIngestInput {
  db: Dynamo;
  seasonId: string;
  now: Date;
  source: LiveSource;
  /** Broadcast `scores_updated` for this season (best-effort). */
  publish: PublishScores;
}

export interface RunIngestResult {
  /** Another run holds the lease; nothing was done. */
  busy: boolean;
  summary?: {
    games: number;
    statLines: number;
    changedStatLines: number;
    pointsWritten: number;
    teamScoresWritten: number;
  };
  warnings: string[];
  nextPollAt?: string | null;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

export const hashStatLine = (line: StatLine): string =>
  createHash("sha256").update(canonicalStatLineJson(line)).digest("hex");

/** Short, PII-free text for `lastError`. */
const safeMessage = (err: unknown): string =>
  err instanceof PoolSourceError ? err.message : "Unexpected error while updating stats";

const poolOf = (snap: SeasonSnapshot): PoolPlayerRef[] =>
  snap.players.map((p) => ({
    playerId: p.playerId,
    name: p.name,
    position: p.position,
    nflTeam: p.nflTeam,
    ...(p.espnId ? { espnId: p.espnId } : {}),
  }));

export async function runIngest(input: RunIngestInput): Promise<RunIngestResult> {
  const { db, seasonId, now } = input;
  const nowIso = now.toISOString();
  const meta = await getSeasonMeta(db, seasonId);
  if (!meta) throw new DomainError("not_found", "Season not found");
  const leased = await acquireIngestLease(db, {
    seasonId,
    leagueId: meta.leagueId,
    year: meta.year,
    now: nowIso,
    ttlMs: LEASE_TTL_MS,
  });
  if (!leased) return { busy: true, warnings: [] };

  try {
    const outcome = await ingestOnce(input, meta.year);
    await finishIngestRun(db, {
      seasonId,
      now: nowIso,
      summary: outcome.summary,
      warnings: outcome.warnings,
      nextPollAt: outcome.nextPollAt,
    });
    return { busy: false, ...outcome };
  } catch (err) {
    logError("Stats ingest failed", err, { seasonId });
    await finishIngestRun(db, {
      seasonId,
      now: nowIso,
      error: safeMessage(err),
      warnings: [],
      nextPollAt: new Date(now.getTime() + RETRY_AFTER_ERROR_MS).toISOString(),
    }).catch((e: unknown) => logError("Could not record the failed ingest run", e));
    throw err;
  }
}

async function ingestOnce(
  { db, seasonId, now, source, publish }: RunIngestInput,
  seasonYear: number,
): Promise<Required<Pick<RunIngestResult, "summary" | "warnings" | "nextPollAt">>> {
  const nowIso = now.toISOString();
  const warnings: string[] = [];
  const snap = await loadSeason(db, seasonId, { consistentRead: true });
  // Games must come from the same NFL season the pool's field was imported from.
  const year = snap.poolImport?.seasonYear ?? seasonYear;
  const field = new Set(snap.nflTeams.map((t) => t.abbr));
  if (field.size === 0) throw new PoolSourceError("The playoff field has not been imported yet");

  // ---- 1. Games ----
  const rounds = await source.fetchRoundGames(year, field);
  const gameWrites: IngestGame[] = [];
  for (const r of rounds)
    for (const g of r.games) {
      const inField = [g.home, g.away].filter((t) => field.has(t)).length;
      if (inField === 1)
        warnings.push(`${g.away} @ ${g.home} has a team outside the playoff field; ignored`);
      if (inField !== 2) continue;
      gameWrites.push({
        gameId: g.gameId,
        round: r.round,
        home: g.home,
        away: g.away,
        kickoff: g.kickoff,
        status: g.status,
        homeScore: g.homeScore,
        awayScore: g.awayScore,
        ...(g.winner ? { winner: g.winner } : {}),
      });
    }
  const createdRounds = await ensureRounds(db, seasonId, snap.rounds);
  const gamesWritten = await upsertGames(db, seasonId, gameWrites, snap.games);

  // ---- 2. Which summaries to fetch ----
  const known = new Map<string, GameItem>(snap.games.map((g) => [g.gameId, g]));
  const roundStatus = new Map<number, LiveRoundStatus>(snap.rounds.map((r) => [r.round, r.status]));
  const toFetch = gameWrites.filter((g) => {
    if (g.status === "in_progress") return true;
    if (g.status !== "final") return false;
    const fetchedAt = known.get(g.gameId)?.statsFetchedAt;
    if (!fetchedAt) return true;
    // A finalized round is re-fetched too: its points stay frozen, but a provider correction is
    // kept as raw stats and flagged on the ROUND (doc 04 §6).
    return now.getTime() - Date.parse(fetchedAt) >= FINAL_REFETCH_MS;
  });

  // ---- 3. Stats ----
  const pool = poolOf(snap);
  let statLines = 0;
  let changedStatLines = 0;
  await mapLimit(toFetch, SUMMARY_CONCURRENCY, async (g) => {
    try {
      const summary = await source.fetchSummary(g.gameId);
      const mapped = mapSummaryToStatLines(summary, pool);
      warnings.push(...mapped.warnings);
      const writes: StatLineWrite[] = mapped.lines.map((l) => ({
        playerId: l.playerId,
        raw: l.raw,
        canonical: l.canonical as Record<string, number>,
        ...(l.events ? { events: l.events } : {}),
        providerHash: hashStatLine({
          counts: l.canonical,
          ...(l.events ? { events: l.events } : {}),
        }),
      }));
      const res = await upsertGameStats(db, seasonId, g.gameId, writes, nowIso);
      statLines += writes.length;
      changedStatLines += res.changed + res.deleted;
      if (res.changed + res.deleted > 0 && roundStatus.get(g.round) === "finalized")
        await markProviderChanged(db, seasonId, g.round, nowIso);
      if (g.status === "final") await markGameStatsFetched(db, seasonId, g.gameId, nowIso);
    } catch (err) {
      logError("Game summary failed", err, { gameId: g.gameId });
      warnings.push(`${g.away} @ ${g.home}: ${safeMessage(err)}`);
    }
  });

  // ---- 4. Eliminations and round statuses (pure functions of the games) ----
  const teamUpdates = deriveTeamStatuses({
    teams: snap.nflTeams.map((t) => ({ abbr: t.abbr, seed: t.seed })),
    games: gameWrites,
  });
  const teamsChanged = await updateNflTeamStatuses(db, seasonId, teamUpdates, snap.nflTeams);
  const roundItems = createdRounds > 0 ? await listRounds(db, seasonId) : snap.rounds;
  const roundUpdates = roundItems.map((r) => ({
    round: r.round,
    status: deriveRoundStatus(
      gameWrites.filter((g) => g.round === r.round),
      r.status,
      ROUND_GAME_COUNTS[r.round - 1],
    ),
  }));
  const roundsChanged = await updateRoundStatuses(db, seasonId, roundUpdates, roundItems);

  // ---- 5. Recompute ----
  let published = false;
  const recompute = await recomputeSeason(
    db,
    seasonId,
    async () => {
      published = true;
      await publish();
    },
    now,
  );
  warnings.push(...recompute.issues);
  if (
    !published &&
    gamesWritten + teamsChanged + roundsChanged + changedStatLines + createdRounds > 0
  )
    await publish();

  // ---- 6. Next poll ----
  const delay = nextPollDelay({ now, games: gameWrites, rounds: roundUpdates });
  return {
    summary: {
      games: gameWrites.length,
      statLines,
      changedStatLines,
      pointsWritten: recompute.pointsWritten,
      teamScoresWritten: recompute.teamScoresWritten,
    },
    warnings,
    nextPollAt: delay === null ? null : new Date(now.getTime() + delay).toISOString(),
  };
}
