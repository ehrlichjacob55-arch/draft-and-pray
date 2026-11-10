/**
 * Player pool (docs/design/14 §3): NFLTEAM#/PLAYER# upserts for the automatic import, listing, and
 * the commissioner's include/exclude + manual add. Pool edits are only allowed while the draft is
 * `scheduled`, `lobby` or `paused`.
 */
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Position } from "@dnp/domain";
import type { Dynamo } from "../client";
import {
  DomainError,
  TransactionConflictError,
  transactWrite,
  type TransactItems,
} from "../errors";
import { newId } from "../ids";
import { parseItem, type NflTeamItem, type PlayerItem, type PoolImportItem } from "../items";
import { draftKey, nflTeamKey, playerKey, poolImportKey, seasonPk, skPrefix } from "../keys";
import { auditPut, getDraft } from "./draft-lifecycle";
import { queryPrefix } from "./season";

export interface PoolTeamInput {
  abbr: string;
  name: string;
  conference: "AFC" | "NFC";
  seed: number;
}
export interface PoolPlayerInput {
  /** Fixed id (DST rows). Otherwise matched by `providerPlayerId` and given a new id. */
  playerId?: string;
  providerPlayerId: string | null;
  name: string;
  position: Position;
  nflTeam: string;
  injuryStatus: string | null;
  depthChartOrder?: number | null;
  /** Provider overall rank (lower = better); null/absent = unranked. */
  rank?: number | null;
  /** Last-season stats; null = no entry, undefined = not fetched (existing value is kept). */
  stats?: Record<string, number> | null;
}

export interface ImportPoolInput {
  seasonId: string;
  seasonYear: number;
  source: string;
  teams: PoolTeamInput[];
  players: PoolPlayerInput[];
  /** Season of the stats below; absent when the stats fetch failed (existing stats are kept). */
  statsSeason?: number;
  /** DST stats by team abbr (null = none); the importer generates the DST rows. */
  dstStats?: Record<string, Record<string, number> | null>;
  actorUserId: string | null;
  now: string;
}
export interface ImportPoolResult {
  teams: number;
  players: number;
  added: number;
  updated: number;
  removed: number;
}

const POOL_EDITABLE = ["scheduled", "lobby", "paused"];

export const dstPlayerId = (abbr: string) => `DST-${abbr}`;

async function mapPool<T>(items: T[], size: number, fn: (item: T) => Promise<unknown>) {
  for (let i = 0; i < items.length; i += size)
    await Promise.all(items.slice(i, i + size).map((it) => fn(it)));
}

export async function listPlayers(db: Dynamo, seasonId: string): Promise<PlayerItem[]> {
  const raw = await queryPrefix(db, seasonPk(seasonId), skPrefix.players, { consistentRead: true });
  return raw.map((r) => parseItem(r)).filter((i): i is PlayerItem => i.type === "Player");
}

export async function listNflTeams(db: Dynamo, seasonId: string): Promise<NflTeamItem[]> {
  const raw = await queryPrefix(db, seasonPk(seasonId), "NFLTEAM#", { consistentRead: true });
  return raw.map((r) => parseItem(r)).filter((i): i is NflTeamItem => i.type === "NflTeam");
}

export async function getPoolImport(
  db: Dynamo,
  seasonId: string,
): Promise<PoolImportItem | undefined> {
  const r = await db.doc.send(
    new GetCommand({ TableName: db.tableName, Key: poolImportKey(seasonId) }),
  );
  if (!r.Item) return undefined;
  const item = parseItem(r.Item);
  return item.type === "PoolImport" ? item : undefined;
}

export async function getPlayer(
  db: Dynamo,
  seasonId: string,
  playerId: string,
): Promise<PlayerItem | undefined> {
  const r = await db.doc.send(
    new GetCommand({
      TableName: db.tableName,
      Key: playerKey(seasonId, playerId),
      ConsistentRead: true,
    }),
  );
  if (!r.Item) return undefined;
  const item = parseItem(r.Item);
  return item.type === "Player" ? item : undefined;
}

/**
 * Idempotent upsert of the whole pool. Players are keyed by `providerPlayerId`; players no longer
 * returned become `inPool = false` unless drafted or commissioner-overridden; commissioner
 * overrides and drafted players keep their `inPool`. Generates one DST per team.
 */
export async function importPool(db: Dynamo, input: ImportPoolInput): Promise<ImportPoolResult> {
  const { seasonId, now } = input;
  const TableName = db.tableName;
  const draft = await getDraft(db, seasonId);
  if (!draft) throw new DomainError("not_found", "Draft not found");
  if (!POOL_EDITABLE.includes(draft.status))
    throw new DomainError(
      "pool_locked",
      "The pool cannot change while the draft is running or done",
    );

  const abbrs = new Set(input.teams.map((t) => t.abbr));
  if (abbrs.size !== input.teams.length)
    throw new DomainError("validation_error", "Duplicate team");
  for (const p of input.players)
    if (!abbrs.has(p.nflTeam))
      throw new DomainError("validation_error", `Player on unknown team ${p.nflTeam}`);

  const dst: PoolPlayerInput[] = input.teams.map((t) => ({
    playerId: dstPlayerId(t.abbr),
    providerPlayerId: null,
    name: `${t.name} D/ST`,
    position: "DST",
    nflTeam: t.abbr,
    injuryStatus: null,
    depthChartOrder: null,
    rank: null,
    stats: input.statsSeason === undefined ? undefined : (input.dstStats?.[t.abbr] ?? null),
  }));
  const statsSeason = input.statsSeason;
  const incoming = [...input.players, ...dst];

  const existing = await listPlayers(db, seasonId);
  const byId = new Map(existing.map((p) => [p.playerId, p]));
  const byProvider = new Map(
    existing.filter((p) => p.providerPlayerId).map((p) => [p.providerPlayerId as string, p]),
  );
  const seen = new Set<string>();
  const adds: PlayerItem[] = [];
  const updates: { item: PlayerItem; next: PoolPlayerInput; inPool: boolean }[] = [];
  for (const p of incoming) {
    const match = p.playerId
      ? byId.get(p.playerId)
      : p.providerPlayerId
        ? byProvider.get(p.providerPlayerId)
        : undefined;
    if (match) {
      if (seen.has(match.playerId)) continue; // duplicate in the feed
      seen.add(match.playerId);
      const keep = match.draftedByTeamId !== undefined || match.manualOverride === true;
      updates.push({ item: match, next: p, inPool: keep ? match.inPool : true });
    } else {
      const playerId = p.playerId ?? newId();
      seen.add(playerId);
      adds.push({
        ...playerKey(seasonId, playerId),
        type: "Player",
        playerId,
        name: p.name,
        position: p.position,
        nflTeam: p.nflTeam,
        providerPlayerId: p.providerPlayerId,
        injuryStatus: p.injuryStatus,
        inPool: true,
        depthChartOrder: p.depthChartOrder ?? null,
        rank: p.rank ?? null,
        ...(statsSeason !== undefined ? { stats: p.stats ?? null, statsSeason } : {}),
      });
    }
  }
  const removals = existing.filter(
    (p) =>
      !seen.has(p.playerId) && p.inPool && p.draftedByTeamId === undefined && !p.manualOverride,
  );

  await mapPool(input.teams, 20, (t) =>
    db.doc.send(
      new UpdateCommand({
        TableName,
        Key: nflTeamKey(seasonId, t.abbr),
        UpdateExpression:
          "SET #t = :type, abbr = :abbr, #n = :name, conference = :conf, seed = :seed, #s = if_not_exists(#s, :status)",
        ExpressionAttributeNames: { "#t": "type", "#n": "name", "#s": "status" },
        ExpressionAttributeValues: {
          ":type": "NflTeam",
          ":abbr": t.abbr,
          ":name": t.name,
          ":conf": t.conference,
          ":seed": t.seed,
          ":status": t.seed === 1 ? "bye" : "alive",
        },
      }),
    ),
  );
  await mapPool(adds, 20, (item) =>
    transactWrite(
      db.doc,
      [{ Put: { TableName, Item: item, ConditionExpression: "attribute_not_exists(pk)" } }],
      ["player"],
    ),
  );
  await mapPool(updates, 20, ({ item, next, inPool }) =>
    db.doc.send(
      new UpdateCommand({
        TableName,
        Key: playerKey(seasonId, item.playerId),
        UpdateExpression: `SET #n = :name, #p = :pos, nflTeam = :team, injuryStatus = :inj, depthChartOrder = :dco, #rk = :rank, providerPlayerId = :pp, inPool = :inPool${statsSeason === undefined ? "" : ", stats = :stats, statsSeason = :ss"}`,
        ExpressionAttributeNames: { "#n": "name", "#p": "position", "#rk": "rank" },
        ExpressionAttributeValues: {
          ...(statsSeason === undefined
            ? {}
            : { ":stats": next.stats ?? null, ":ss": statsSeason }),
          ":name": next.name,
          ":pos": next.position,
          ":team": next.nflTeam,
          ":inj": next.injuryStatus,
          ":dco": next.depthChartOrder ?? null,
          ":rank": next.rank ?? null,
          ":pp": next.providerPlayerId,
          ":inPool": inPool,
        },
      }),
    ),
  );
  await mapPool(removals, 20, (p) =>
    db.doc.send(
      new UpdateCommand({
        TableName,
        Key: playerKey(seasonId, p.playerId),
        UpdateExpression: "SET inPool = :f",
        ConditionExpression: "attribute_not_exists(draftedByTeamId)",
        ExpressionAttributeValues: { ":f": false },
      }),
    ),
  );

  const result: ImportPoolResult = {
    teams: input.teams.length,
    players: incoming.length,
    added: adds.length,
    updated: updates.length,
    removed: removals.length,
  };
  const record: PoolImportItem = {
    ...poolImportKey(seasonId),
    type: "PoolImport",
    importedAt: now,
    source: input.source,
    seasonYear: input.seasonYear,
    counts: { ...result },
  };
  try {
    await transactWrite(
      db.doc,
      [
        { Put: { TableName, Item: record } },
        draftEditable(TableName, seasonId, now),
        auditPut(
          TableName,
          seasonId,
          input.actorUserId,
          "pool.import",
          { source: input.source, seasonYear: input.seasonYear, ...result },
          now,
        ),
      ],
      ["pool_import", "draft_state", "audit"],
    );
  } catch (err) {
    if (err instanceof TransactionConflictError && err.has("draft_state"))
      throw new DomainError("pool_locked", "The draft started while the pool was importing");
    throw err;
  }
  return result;
}

/** Bumps DRAFT.version (so clients refetch the available list) while the pool is editable. */
const draftEditable = (TableName: string, seasonId: string, now: string) => ({
  Update: {
    TableName,
    Key: draftKey(seasonId),
    UpdateExpression: "SET updatedAt = :now ADD version :one",
    ConditionExpression: "#status IN (:a, :b, :c)",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":a": "scheduled",
      ":b": "lobby",
      ":c": "paused",
      ":now": now,
      ":one": 1,
    },
  },
});

/** Commissioner include/exclude. Never for a drafted player; sets `manualOverride`. */
export async function setPlayerInPool(
  db: Dynamo,
  input: { seasonId: string; playerId: string; inPool: boolean; actorUserId: string; now: string },
): Promise<PlayerItem> {
  const TableName = db.tableName;
  const items: TransactItems = [
    draftEditable(TableName, input.seasonId, input.now),
    {
      Update: {
        TableName,
        Key: playerKey(input.seasonId, input.playerId),
        UpdateExpression: "SET inPool = :v, manualOverride = :true",
        ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(draftedByTeamId)",
        ExpressionAttributeValues: { ":v": input.inPool, ":true": true },
      },
    },
    auditPut(
      TableName,
      input.seasonId,
      input.actorUserId,
      "pool.set_in_pool",
      { playerId: input.playerId, inPool: input.inPool },
      input.now,
    ),
  ];
  try {
    await transactWrite(db.doc, items, ["draft_state", "player", "audit"]);
  } catch (err) {
    if (err instanceof TransactionConflictError) {
      if (err.has("draft_state"))
        throw new DomainError(
          "pool_locked",
          "The pool can only change before the draft or while paused",
        );
      const reason = err.reasons.find((r) => r.label === "player");
      if (reason?.item)
        throw new DomainError("player_taken", "That player has already been drafted");
      throw new DomainError("not_found", "Player not found");
    }
    throw err;
  }
  const p = await getPlayer(db, input.seasonId, input.playerId);
  /* c8 ignore next */
  if (!p) throw new DomainError("not_found", "Player not found");
  return p;
}

/** Commissioner manual add (late call-up). The team must exist in the season's field. */
export async function addManualPlayer(
  db: Dynamo,
  input: {
    seasonId: string;
    name: string;
    position: Exclude<Position, "DST">;
    nflTeam: string;
    injuryStatus: string | null;
    actorUserId: string;
    now: string;
  },
): Promise<PlayerItem> {
  const TableName = db.tableName;
  const playerId = newId();
  const item: PlayerItem = {
    ...playerKey(input.seasonId, playerId),
    type: "Player",
    playerId,
    name: input.name,
    position: input.position,
    nflTeam: input.nflTeam,
    providerPlayerId: null,
    injuryStatus: input.injuryStatus,
    inPool: true,
    manualOverride: true,
    depthChartOrder: null,
    rank: null,
  };
  try {
    await transactWrite(
      db.doc,
      [
        draftEditable(TableName, input.seasonId, input.now),
        {
          ConditionCheck: {
            TableName,
            Key: nflTeamKey(input.seasonId, input.nflTeam),
            ConditionExpression: "attribute_exists(pk)",
          },
        },
        { Put: { TableName, Item: item, ConditionExpression: "attribute_not_exists(pk)" } },
        auditPut(
          TableName,
          input.seasonId,
          input.actorUserId,
          "pool.add_player",
          { playerId, position: input.position, nflTeam: input.nflTeam },
          input.now,
        ),
      ],
      ["draft_state", "nfl_team", "player", "audit"],
    );
  } catch (err) {
    if (err instanceof TransactionConflictError) {
      if (err.has("draft_state"))
        throw new DomainError(
          "pool_locked",
          "The pool can only change before the draft or while paused",
        );
      if (err.has("nfl_team"))
        throw new DomainError("validation_error", "That NFL team is not in the playoff field");
    }
    throw err;
  }
  return item;
}
