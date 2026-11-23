/**
 * Live-stats writes (docs/design/10 §4.4): games, raw stat lines, NFL-team and round statuses, and
 * the derived POINTS/TEAMSCORE items. Everything here is idempotent and writes only what changed,
 * so re-running an ingest or recompute with the same inputs writes nothing. No Scan: each read is
 * a Query on a documented prefix (A2/A16).
 */
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { PLAYOFF_ROUNDS, type PointsRow, type TeamScoreRow } from "@dnp/domain";
import type { Dynamo } from "../client";
import {
  parseItem,
  type GameItem,
  type NflTeamItem,
  type PointsItem,
  type RoundItem,
  type StatLineItem,
  type TeamScoreItem,
} from "../items";
import {
  gameKey,
  nflTeamKey,
  pointsKey,
  roundKey,
  seasonPk,
  skPrefix,
  statsKey,
  teamScoreKey,
} from "../keys";
import { batchWrite, deleteRequest, putRequest, type WriteRequest } from "./batch";
import { queryPrefix } from "./season";

const isConditionFailure = (err: unknown) =>
  (err as { name?: string }).name === "ConditionalCheckFailedException";

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---- Reads (A2) ----
export async function listRounds(db: Dynamo, seasonId: string): Promise<RoundItem[]> {
  const raw = await queryPrefix(db, seasonPk(seasonId), "ROUND#", { consistentRead: true });
  return raw.map((r) => parseItem(r)).filter((i): i is RoundItem => i.type === "Round");
}
export async function listGames(db: Dynamo, seasonId: string): Promise<GameItem[]> {
  const raw = await queryPrefix(db, seasonPk(seasonId), "GAME#", { consistentRead: true });
  return raw.map((r) => parseItem(r)).filter((i): i is GameItem => i.type === "Game");
}

// ---- Rounds ----
/** Creates the missing ROUND#1..4 items (`upcoming`). Returns how many it created. */
export async function ensureRounds(
  db: Dynamo,
  seasonId: string,
  existing: readonly RoundItem[],
): Promise<number> {
  let created = 0;
  for (const [i, code] of PLAYOFF_ROUNDS.entries()) {
    const round = i + 1;
    if (existing.some((r) => r.round === round)) continue;
    try {
      await db.doc.send(
        new PutCommand({
          TableName: db.tableName,
          Item: { ...roundKey(seasonId, round), type: "Round", round, code, status: "upcoming" },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      created++;
    } catch (err) {
      if (!isConditionFailure(err)) throw err;
    }
  }
  return created;
}

/**
 * Sets round statuses that differ from `existing`. A `finalized` round is never touched (the
 * condition also guards a finalize that lands mid-run). Returns the number of rounds changed.
 */
export async function updateRoundStatuses(
  db: Dynamo,
  seasonId: string,
  updates: readonly { round: number; status: RoundItem["status"] }[],
  existing: readonly RoundItem[],
): Promise<number> {
  let changed = 0;
  for (const u of updates) {
    const cur = existing.find((r) => r.round === u.round);
    if (!cur || cur.status === "finalized" || cur.status === u.status) continue;
    try {
      await db.doc.send(
        new UpdateCommand({
          TableName: db.tableName,
          Key: roundKey(seasonId, u.round),
          UpdateExpression: "SET #s = :s",
          ConditionExpression: "attribute_exists(pk) AND #s <> :finalized",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":s": u.status, ":finalized": "finalized" },
        }),
      );
      changed++;
    } catch (err) {
      if (!isConditionFailure(err)) throw err;
    }
  }
  return changed;
}

// ---- NFL teams ----
/** Updates NFLTEAM status / eliminatedInRound where they differ. Returns the number changed. */
export async function updateNflTeamStatuses(
  db: Dynamo,
  seasonId: string,
  updates: readonly {
    abbr: string;
    status: NflTeamItem["status"];
    eliminatedInRound?: NflTeamItem["eliminatedInRound"];
  }[],
  existing: readonly NflTeamItem[],
): Promise<number> {
  let changed = 0;
  for (const u of updates) {
    const cur = existing.find((t) => t.abbr === u.abbr);
    if (!cur) continue;
    if (cur.status === u.status && cur.eliminatedInRound === u.eliminatedInRound) continue;
    await db.doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: nflTeamKey(seasonId, u.abbr),
        UpdateExpression: u.eliminatedInRound
          ? "SET #s = :s, eliminatedInRound = :r"
          : "SET #s = :s REMOVE eliminatedInRound",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":s": u.status,
          ...(u.eliminatedInRound ? { ":r": u.eliminatedInRound } : {}),
        },
      }),
    );
    changed++;
  }
  return changed;
}

// ---- Games ----
export interface GameWrite {
  gameId: string;
  round: number;
  home: string;
  away: string;
  kickoff: string;
  status: string;
  homeScore: number;
  awayScore: number;
  winner?: string;
}

/** Upserts GAME items whose fields changed (keeping `statsFetchedAt`). Returns the number written. */
export async function upsertGames(
  db: Dynamo,
  seasonId: string,
  games: readonly GameWrite[],
  existing: readonly GameItem[],
): Promise<number> {
  let written = 0;
  for (const g of games) {
    const cur = existing.find((e) => e.gameId === g.gameId);
    if (
      cur &&
      cur.round === g.round &&
      cur.home === g.home &&
      cur.away === g.away &&
      cur.kickoff === g.kickoff &&
      cur.status === g.status &&
      cur.homeScore === g.homeScore &&
      cur.awayScore === g.awayScore &&
      cur.winner === g.winner
    )
      continue;
    await db.doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: gameKey(seasonId, g.gameId),
        UpdateExpression: `SET #type = :type, gameId = :id, providerGameId = :id, round = :round, home = :home, away = :away, kickoff = :kickoff, #s = :status, homeScore = :hs, awayScore = :as${g.winner ? ", winner = :winner" : " REMOVE winner"}`,
        ExpressionAttributeNames: { "#type": "type", "#s": "status" },
        ExpressionAttributeValues: {
          ":type": "Game",
          ":id": g.gameId,
          ":round": g.round,
          ":home": g.home,
          ":away": g.away,
          ":kickoff": g.kickoff,
          ":status": g.status,
          ":hs": g.homeScore,
          ":as": g.awayScore,
          ...(g.winner ? { ":winner": g.winner } : {}),
        },
      }),
    );
    written++;
  }
  return written;
}

/** Records when a final game's summary was last fetched (the 6 h stat-correction re-poll). */
export async function markGameStatsFetched(
  db: Dynamo,
  seasonId: string,
  gameId: string,
  now: string,
): Promise<void> {
  await db.doc.send(
    new UpdateCommand({
      TableName: db.tableName,
      Key: gameKey(seasonId, gameId),
      UpdateExpression: "SET statsFetchedAt = :now",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ":now": now },
    }),
  );
}

// ---- Raw stat lines ----
export interface StatLineWrite {
  playerId: string;
  raw: Record<string, unknown>;
  canonical: Record<string, number>;
  events?: StatLineItem["events"];
  providerHash: string;
}

/**
 * Upserts one game's STATS items (A16: Query `begins_with(sk, "STATS#<gameId>#")`). A line whose
 * `providerHash` is unchanged is skipped; lines for players no longer in the parsed output are
 * deleted. Returns counts.
 */
export async function upsertGameStats(
  db: Dynamo,
  seasonId: string,
  gameId: string,
  lines: readonly StatLineWrite[],
  now: string,
): Promise<{ changed: number; unchanged: number; deleted: number }> {
  const raw = await queryPrefix(db, seasonPk(seasonId), skPrefix.statsOfGame(gameId), {
    consistentRead: true,
  });
  const existing = new Map<string, StatLineItem>();
  for (const r of raw) {
    const item = parseItem(r);
    if (item.type === "StatLine") existing.set(item.playerId, item);
  }
  const requests: WriteRequest[] = [];
  let unchanged = 0;
  for (const line of lines) {
    if (existing.get(line.playerId)?.providerHash === line.providerHash) {
      unchanged++;
      continue;
    }
    requests.push(
      putRequest({
        ...statsKey(seasonId, gameId, line.playerId),
        type: "StatLine",
        gameId,
        playerId: line.playerId,
        raw: line.raw,
        canonical: line.canonical,
        ...(line.events ? { events: line.events } : {}),
        fetchedAt: now,
        providerHash: line.providerHash,
      }),
    );
  }
  const keep = new Set(lines.map((l) => l.playerId));
  let deleted = 0;
  for (const playerId of existing.keys())
    if (!keep.has(playerId)) {
      requests.push(deleteRequest(statsKey(seasonId, gameId, playerId)));
      deleted++;
    }
  await batchWrite(db, requests);
  return { changed: requests.length - deleted, unchanged, deleted };
}

// ---- Derived scores ----
export interface ScoreWriteResult {
  pointsWritten: number;
  pointsDeleted: number;
  teamScoresWritten: number;
  teamScoresDeleted: number;
}

const samePoints = (cur: PointsItem, row: PointsRow) =>
  cur.points === row.points &&
  cur.rulesetVersion === row.rulesetVersion &&
  sameJson(cur.breakdown, row.breakdown) &&
  sameJson(cur.overridden ?? [], row.overridden);

/**
 * Writes the recompute output (docs/design/10 §4.4 step 4): puts changed POINTS/TEAMSCORE items,
 * deletes the ones of non-finalized rounds that recompute no longer produces, in BatchWrite
 * chunks. Rows and existing items of a `finalized` round are never written or deleted (the pure
 * `computeSeason` already omits them; this is the second guard). Unchanged items are skipped.
 */
export async function writeComputedScores(
  db: Dynamo,
  input: {
    seasonId: string;
    rounds: readonly Pick<RoundItem, "round" | "status">[];
    points: readonly PointsRow[];
    teamScores: readonly TeamScoreRow[];
    existingPoints: readonly PointsItem[];
    existingTeamScores: readonly TeamScoreItem[];
    now: string;
  },
): Promise<ScoreWriteResult> {
  const { seasonId, now } = input;
  const frozen = new Set(input.rounds.filter((r) => r.status === "finalized").map((r) => r.round));
  const requests: WriteRequest[] = [];
  const result: ScoreWriteResult = {
    pointsWritten: 0,
    pointsDeleted: 0,
    teamScoresWritten: 0,
    teamScoresDeleted: 0,
  };

  const curPoints = new Map(input.existingPoints.map((p) => [`${p.gameId}#${p.playerId}`, p]));
  const wantedPoints = new Set<string>();
  for (const row of input.points) {
    if (frozen.has(row.round)) continue;
    const k = `${row.gameId}#${row.playerId}`;
    wantedPoints.add(k);
    const cur = curPoints.get(k);
    if (cur && samePoints(cur, row)) continue;
    requests.push(
      putRequest({
        ...pointsKey(seasonId, row.gameId, row.playerId),
        type: "Points",
        gameId: row.gameId,
        playerId: row.playerId,
        round: row.round,
        points: row.points,
        breakdown: row.breakdown,
        overridden: row.overridden,
        rulesetVersion: row.rulesetVersion,
        computedAt: now,
      }),
    );
    result.pointsWritten++;
  }
  for (const [k, cur] of curPoints)
    if (!wantedPoints.has(k) && !frozen.has(cur.round)) {
      requests.push(deleteRequest(pointsKey(seasonId, cur.gameId, cur.playerId)));
      result.pointsDeleted++;
    }

  const curScores = new Map(input.existingTeamScores.map((s) => [`${s.round}#${s.teamId}`, s]));
  const wantedScores = new Set<string>();
  for (const row of input.teamScores) {
    if (frozen.has(row.round)) continue;
    const k = `${row.round}#${row.teamId}`;
    wantedScores.add(k);
    const cur = curScores.get(k);
    if (cur && cur.points === row.points && cur.provisional === row.provisional) continue;
    requests.push(
      putRequest({
        ...teamScoreKey(seasonId, row.round, row.teamId),
        type: "TeamScore",
        round: row.round,
        teamId: row.teamId,
        points: row.points,
        provisional: row.provisional,
        computedAt: now,
      }),
    );
    result.teamScoresWritten++;
  }
  for (const [k, cur] of curScores)
    if (!wantedScores.has(k) && !frozen.has(cur.round)) {
      requests.push(deleteRequest(teamScoreKey(seasonId, cur.round, cur.teamId)));
      result.teamScoresDeleted++;
    }

  await batchWrite(db, requests);
  return result;
}
