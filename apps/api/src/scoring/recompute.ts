/**
 * Season recompute (docs/design/10 §4.4 steps 3-4): load the season, run the pure scoring engine
 * over raw stats + overrides under the active ruleset, and write only what changed. Finalized
 * rounds are never written. Called after an ingest, a ruleset change and a roster change.
 */
import { loadSeason, writeComputedScores, type Dynamo, type SeasonSnapshot } from "@dnp/db";
import {
  computeSeason,
  parseRuleset,
  parseStatLine,
  type PlayerGameInput,
  type SeasonInput,
  type StatOverrides,
} from "@dnp/domain";
import type { PublishScores } from "./publish";

export interface RecomputeResult {
  /** False when there was nothing to compute with (no active ruleset). */
  ran: boolean;
  /** Anything was written or deleted. */
  changed: boolean;
  pointsWritten: number;
  pointsDeleted: number;
  teamScoresWritten: number;
  teamScoresDeleted: number;
  /** Player-games that could not be scored, as short messages (no user data). */
  issues: string[];
}

const EMPTY: RecomputeResult = {
  ran: false,
  changed: false,
  pointsWritten: 0,
  pointsDeleted: 0,
  teamScoresWritten: 0,
  teamScoresDeleted: 0,
  issues: [],
};

/** The season's active ruleset (`META.activeRulesetVersion`), parsed; undefined when none is set. */
function activeRuleset(snap: SeasonSnapshot) {
  const item = snap.rulesets.find((r) => r.version === snap.meta?.activeRulesetVersion);
  return item ? parseRuleset({ ...item.rules, version: item.version }) : undefined;
}

/** Builds the pure engine's input from a loaded season; unreadable stat lines become issues. */
export function buildSeasonInput(snap: SeasonSnapshot, issues: string[]): SeasonInput | undefined {
  const ruleset = activeRuleset(snap);
  if (!ruleset) return undefined;
  const players = new Map(snap.players.map((p) => [p.playerId, p]));
  const games = new Map(snap.games.map((g) => [g.gameId, g]));
  const label = (gameId: string, playerId: string) => {
    const g = games.get(gameId);
    return `${players.get(playerId)?.name ?? playerId} (${g ? `${g.away} @ ${g.home}` : gameId})`;
  };

  const overrides = new Map<string, StatOverrides>();
  for (const o of snap.overrides) {
    const k = `${o.gameId}#${o.playerId}`;
    overrides.set(k, { ...overrides.get(k), [o.statKey]: o.value });
  }
  const playerGames: PlayerGameInput[] = [];
  const seen = new Set<string>();
  for (const s of snap.stats) {
    const k = `${s.gameId}#${s.playerId}`;
    seen.add(k);
    try {
      playerGames.push({
        gameId: s.gameId,
        playerId: s.playerId,
        stats: parseStatLine({ counts: s.canonical, ...(s.events ? { events: s.events } : {}) }),
        ...(overrides.has(k) ? { overrides: overrides.get(k) } : {}),
      });
    } catch (err) {
      issues.push(`${label(s.gameId, s.playerId)}: ${(err as Error).message}`);
    }
  }
  // An override for a player-game with no provider stats still scores.
  for (const [k, o] of overrides) {
    if (seen.has(k)) continue;
    const [gameId, playerId] = k.split("#") as [string, string];
    playerGames.push({ gameId, playerId, stats: { counts: {} }, overrides: o });
  }

  const roundStatus = new Map(snap.rounds.map((r) => [r.round, r.status]));
  return {
    ruleset,
    // A round with no ROUND item yet is simply upcoming: standings still get their zero rows.
    rounds: [1, 2, 3, 4].map((round) => ({ round, status: roundStatus.get(round) ?? "upcoming" })),
    games: snap.games.map((g) => ({
      gameId: g.gameId,
      round: g.round,
      home: g.home,
      away: g.away,
      status: g.status,
    })),
    players: snap.players.map((p) => ({
      playerId: p.playerId,
      position: p.position,
      nflTeam: p.nflTeam,
    })),
    playerGames,
    teams: snap.teams.map((t) => ({
      teamId: t.teamId,
      assignments: snap.rosterEntries
        .filter((e) => e.teamId === t.teamId)
        .map((e) => ({ slot: e.slot, playerId: e.playerId, fromRound: e.fromRound })),
    })),
  };
}

/**
 * Recomputes POINTS and TEAMSCORE for every non-finalized round. Idempotent: with unchanged
 * inputs nothing is written. `publish` runs only when something changed. With no active ruleset
 * nothing is written and the result carries a note.
 */
export async function recomputeSeason(
  db: Dynamo,
  seasonId: string,
  publish: PublishScores,
  now: Date = new Date(),
): Promise<RecomputeResult> {
  const snap = await loadSeason(db, seasonId, { consistentRead: true });
  const issues: string[] = [];
  const input = buildSeasonInput(snap, issues);
  if (!input) return { ...EMPTY, issues: ["No active scoring rules, so scores were not computed"] };

  const result = computeSeason(input);
  const players = new Map(snap.players.map((p) => [p.playerId, p.name]));
  const games = new Map(snap.games.map((g) => [g.gameId, `${g.away} @ ${g.home}`]));
  for (const i of result.issues)
    issues.push(
      `${players.get(i.playerId) ?? i.playerId} (${games.get(i.gameId) ?? i.gameId}): ${i.message}`,
    );

  const written = await writeComputedScores(db, {
    seasonId,
    rounds: snap.rounds,
    points: result.points,
    teamScores: result.teamScores,
    existingPoints: snap.points,
    existingTeamScores: snap.teamScores,
    now: now.toISOString(),
  });
  const changed =
    written.pointsWritten +
      written.pointsDeleted +
      written.teamScoresWritten +
      written.teamScoresDeleted >
    0;
  if (changed) await publish();
  return { ran: true, changed, ...written, issues };
}
