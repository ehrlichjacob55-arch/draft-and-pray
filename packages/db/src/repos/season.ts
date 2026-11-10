import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { Dynamo } from "../client";
import { seasonPk, skPrefix } from "../keys";
import {
  parseItem,
  type AuditItem,
  type DraftItem,
  type GameItem,
  type NflTeamItem,
  type OverrideItem,
  type PickItem,
  type PlayerItem,
  type PoolImportItem,
  type PointsItem,
  type QueueItem,
  type RosterEntryItem,
  type RosterTxnItem,
  type RoundItem,
  type RulesetItem,
  type SeasonMetaItem,
  type StatLineItem,
  type TeamItem,
  type TeamOwnerItem,
  type TeamScoreItem,
} from "../items";

export interface QueryPrefixOptions {
  consistentRead?: boolean;
  /** Default true (ascending). Use false for "newest first" (A9). */
  scanIndexForward?: boolean;
  /** Max items to return in total. */
  limit?: number;
  /** Items per DynamoDB page (Limit on each request); mainly for tests. */
  pageSize?: number;
}

/** Paginated Query on one partition, optionally restricted to `begins_with(sk, skPrefix)`. */
export async function queryPrefix(
  db: Dynamo,
  pk: string,
  skPrefix?: string,
  opts: QueryPrefixOptions = {},
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const remaining = opts.limit === undefined ? undefined : opts.limit - items.length;
    const pageLimit =
      remaining === undefined ? opts.pageSize : Math.min(remaining, opts.pageSize ?? remaining);
    const res = await db.doc.send(
      new QueryCommand({
        TableName: db.tableName,
        KeyConditionExpression: skPrefix ? "pk = :pk AND begins_with(sk, :p)" : "pk = :pk",
        ExpressionAttributeValues: skPrefix ? { ":pk": pk, ":p": skPrefix } : { ":pk": pk },
        ConsistentRead: opts.consistentRead,
        ScanIndexForward: opts.scanIndexForward,
        Limit: pageLimit,
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...(res.Items ?? []));
    startKey = res.LastEvaluatedKey;
  } while (startKey && (opts.limit === undefined || items.length < opts.limit));
  return items;
}

export interface SeasonSnapshot {
  seasonId: string;
  meta?: SeasonMetaItem;
  rulesets: RulesetItem[];
  teams: TeamItem[];
  teamOwners: TeamOwnerItem[];
  draft?: DraftItem;
  picks: PickItem[];
  queues: QueueItem[];
  rosterEntries: RosterEntryItem[];
  nflTeams: NflTeamItem[];
  players: PlayerItem[];
  poolImport?: PoolImportItem;
  rounds: RoundItem[];
  games: GameItem[];
  stats: StatLineItem[];
  overrides: OverrideItem[];
  points: PointsItem[];
  teamScores: TeamScoreItem[];
  txns: RosterTxnItem[];
  audit: AuditItem[];
}

export interface LoadSeasonOptions {
  consistentRead?: boolean;
  pageSize?: number;
}

/** A1: one paginated Query of the whole season partition, parsed and grouped by entity. */
export async function loadSeason(
  db: Dynamo,
  seasonId: string,
  opts: LoadSeasonOptions = {},
): Promise<SeasonSnapshot> {
  // PRIVATE#… items (manager names/emails) are commissioner-only and never part of a snapshot.
  const raw = (await queryPrefix(db, seasonPk(seasonId), undefined, opts)).filter(
    (r) => !String(r.sk).startsWith(skPrefix.private),
  );
  const snap: SeasonSnapshot = {
    seasonId,
    rulesets: [],
    teams: [],
    teamOwners: [],
    picks: [],
    queues: [],
    rosterEntries: [],
    nflTeams: [],
    players: [],
    rounds: [],
    games: [],
    stats: [],
    overrides: [],
    points: [],
    teamScores: [],
    txns: [],
    audit: [],
  };
  for (const r of raw) {
    const item = parseItem(r);
    switch (item.type) {
      case "SeasonMeta":
        snap.meta = item;
        break;
      case "Ruleset":
        snap.rulesets.push(item);
        break;
      case "Team":
        snap.teams.push(item);
        break;
      case "TeamOwner":
        snap.teamOwners.push(item);
        break;
      case "Draft":
        snap.draft = item;
        break;
      case "Pick":
        snap.picks.push(item);
        break;
      case "Queue":
        snap.queues.push(item);
        break;
      case "RosterEntry":
        snap.rosterEntries.push(item);
        break;
      case "NflTeam":
        snap.nflTeams.push(item);
        break;
      case "Player":
        snap.players.push(item);
        break;
      case "PoolImport":
        snap.poolImport = item;
        break;
      case "Round":
        snap.rounds.push(item);
        break;
      case "Game":
        snap.games.push(item);
        break;
      case "StatLine":
        snap.stats.push(item);
        break;
      case "Override":
        snap.overrides.push(item);
        break;
      case "Points":
        snap.points.push(item);
        break;
      case "TeamScore":
        snap.teamScores.push(item);
        break;
      case "RosterTxn":
        snap.txns.push(item);
        break;
      case "Audit":
        snap.audit.push(item);
        break;
      default:
        throw new Error(`Unexpected item type in season partition: ${item.type}`);
    }
  }
  return snap;
}
