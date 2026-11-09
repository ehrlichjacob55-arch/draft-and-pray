/** Users, leagues, memberships, seasons: docs/design/11 §1 (bootstrap) and A5/A7. */
import {
  BatchGetCommand,
  type BatchGetCommandOutput,
  GetCommand,
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { Dynamo } from "../client";
import { transactWrite, type TransactItems } from "../errors";
import { newId } from "../ids";
import {
  parseItem,
  type LeagueItem,
  type LeagueMemberItem,
  type SeasonMetaItem,
  type SeasonPointerItem,
  type UserItem,
} from "../items";
import {
  auditKey,
  draftKey,
  gsiEmailPk,
  gsiUserPk,
  leagueKey,
  leagueMemberKey,
  leaguePk,
  seasonMetaKey,
  seasonPointerKey,
  skPrefix,
  userKeys,
  userKey,
} from "../keys";
import { GSI1 } from "../table";

/** Put with `attribute_not_exists(pk)`; returns false when the item already exists. */
export async function putIfAbsent(db: Dynamo, item: Record<string, unknown>): Promise<boolean> {
  try {
    await db.doc.send(
      new PutCommand({
        TableName: db.tableName,
        Item: item,
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}

async function getOne(
  doc: DynamoDBDocumentClient,
  tableName: string,
  key: { pk: string; sk: string },
  consistentRead: boolean,
) {
  const r = await doc.send(
    new GetCommand({ TableName: tableName, Key: key, ConsistentRead: consistentRead }),
  );
  return r.Item ? parseItem(r.Item) : undefined;
}

export async function getUser(db: Dynamo, userId: string): Promise<UserItem | undefined> {
  const item = await getOne(db.doc, db.tableName, userKey(userId), true);
  return item?.type === "User" ? item : undefined;
}

/** BatchGet users (deduplicated). Returns a map userId -> item; missing users are absent. */
export async function getUsers(db: Dynamo, userIds: string[]): Promise<Map<string, UserItem>> {
  const ids = [...new Set(userIds)];
  const out = new Map<string, UserItem>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    let keys: { pk: string; sk: string }[] | undefined = chunk.map((id) => userKey(id));
    while (keys && keys.length > 0) {
      const res: BatchGetCommandOutput = await db.doc.send(
        new BatchGetCommand({ RequestItems: { [db.tableName]: { Keys: keys } } }),
      );
      for (const raw of res.Responses?.[db.tableName] ?? []) {
        const it = parseItem(raw);
        if (it.type === "User") out.set(it.userId, it);
      }
      const unprocessed = res.UnprocessedKeys?.[db.tableName]?.Keys as
        { pk: string; sk: string }[] | undefined;
      keys = unprocessed;
    }
  }
  return out;
}

/** A6: user by (normalized) email via gsi1 EMAIL#<email>. */
export async function getUserByEmail(db: Dynamo, email: string): Promise<UserItem | undefined> {
  const res = await db.doc.send(
    new QueryCommand({
      TableName: db.tableName,
      IndexName: GSI1,
      KeyConditionExpression: "gsi1pk = :pk",
      ExpressionAttributeValues: { ":pk": gsiEmailPk(email) },
      Limit: 1,
    }),
  );
  const raw = res.Items?.[0];
  if (!raw) return undefined;
  const item = parseItem(raw);
  return item.type === "User" ? item : undefined;
}

export async function getLeague(db: Dynamo, leagueId: string): Promise<LeagueItem | undefined> {
  const item = await getOne(db.doc, db.tableName, leagueKey(leagueId), true);
  return item?.type === "League" ? item : undefined;
}

export async function getMember(
  db: Dynamo,
  leagueId: string,
  userId: string,
): Promise<LeagueMemberItem | undefined> {
  const { pk, sk } = leagueMemberKey(leagueId, userId);
  const item = await getOne(db.doc, db.tableName, { pk, sk }, true);
  return item?.type === "LeagueMember" ? item : undefined;
}

/** A5: the user's league memberships (gsi1 USER#<id>). */
export async function listMemberships(db: Dynamo, userId: string): Promise<LeagueMemberItem[]> {
  const out: LeagueMemberItem[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await db.doc.send(
      new QueryCommand({
        TableName: db.tableName,
        IndexName: GSI1,
        KeyConditionExpression: "gsi1pk = :pk AND begins_with(gsi1sk, :p)",
        ExpressionAttributeValues: { ":pk": gsiUserPk(userId), ":p": "LEAGUE#" },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const raw of res.Items ?? []) {
      const it = parseItem(raw);
      if (it.type === "LeagueMember") out.push(it);
    }
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return out;
}

/** A7: the league's season pointers, oldest year first. */
export async function listSeasonPointers(
  db: Dynamo,
  leagueId: string,
): Promise<SeasonPointerItem[]> {
  const res = await db.doc.send(
    new QueryCommand({
      TableName: db.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)",
      ExpressionAttributeValues: { ":pk": leaguePk(leagueId), ":p": skPrefix.seasonPointers },
      ConsistentRead: true,
    }),
  );
  return (res.Items ?? [])
    .map((r) => parseItem(r))
    .filter((i): i is SeasonPointerItem => i.type === "SeasonPointer");
}

export async function getSeasonMeta(
  db: Dynamo,
  seasonId: string,
): Promise<SeasonMetaItem | undefined> {
  const item = await getOne(db.doc, db.tableName, seasonMetaKey(seasonId), true);
  return item?.type === "SeasonMeta" ? item : undefined;
}

export interface BootstrapLeagueInput {
  userId: string;
  /** Normalized email. */
  email: string;
  displayName?: string;
  leagueName: string;
  year: number;
  now?: Date;
}
export interface BootstrapLeagueResult {
  leagueId: string;
  seasonId: string;
  userId: string;
  /** False when everything already existed (re-run). */
  created: boolean;
}

/**
 * docs/design/11 §1. Idempotent: the league is found through the user's memberships by exact
 * name, the season through its pointer. Existing items are never modified.
 */
export async function bootstrapLeague(
  db: Dynamo,
  input: BootstrapLeagueInput,
): Promise<BootstrapLeagueResult> {
  const now = (input.now ?? new Date()).toISOString();
  const TableName = db.tableName;
  let created = false;

  const displayName = input.displayName ?? input.email.split("@")[0] ?? input.email;
  const user: UserItem = {
    ...userKeys(input.userId, input.email),
    type: "User",
    userId: input.userId,
    email: input.email,
    displayName,
  };
  if (await putIfAbsent(db, user)) created = true;

  // Find the league: one of the user's memberships with the same name.
  let leagueId: string | undefined;
  for (const m of await listMemberships(db, input.userId)) {
    if (m.role !== "commissioner") continue;
    const league = await getLeague(db, m.leagueId);
    if (league?.name === input.leagueName) {
      leagueId = league.leagueId;
      break;
    }
  }
  if (!leagueId) {
    leagueId = newId();
    const league: LeagueItem = {
      ...leagueKey(leagueId),
      type: "League",
      leagueId,
      name: input.leagueName,
      createdAt: now,
    };
    const member: LeagueMemberItem = {
      ...leagueMemberKey(leagueId, input.userId),
      type: "LeagueMember",
      leagueId,
      userId: input.userId,
      role: "commissioner",
    };
    await transactWrite(
      db.doc,
      [
        { Put: { TableName, Item: league, ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName, Item: member, ConditionExpression: "attribute_not_exists(pk)" } },
      ],
      ["league", "member"],
    );
    created = true;
  }

  const existingPointer = (await listSeasonPointers(db, leagueId)).find(
    (p) => p.year === input.year,
  );
  let seasonId = existingPointer?.seasonId;
  if (!seasonId) {
    seasonId = newId();
    const auditId = newId();
    const items: TransactItems = [
      {
        Put: {
          TableName,
          Item: {
            ...seasonPointerKey(leagueId, input.year),
            type: "SeasonPointer",
            leagueId,
            year: input.year,
            seasonId,
            status: "setup",
          } satisfies SeasonPointerItem,
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
      {
        Put: {
          TableName,
          Item: {
            ...seasonMetaKey(seasonId),
            type: "SeasonMeta",
            seasonId,
            leagueId,
            year: input.year,
            status: "setup",
            activeRulesetVersion: 1,
          } satisfies SeasonMetaItem,
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
      {
        Put: {
          TableName,
          Item: {
            ...draftKey(seasonId),
            type: "Draft",
            status: "scheduled",
            pickSeconds: null,
            currentPick: 1,
            currentPickDeadline: null,
            startedAt: null,
            updatedAt: now,
          },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
      {
        Put: {
          TableName,
          Item: {
            ...auditKey(seasonId, auditId),
            type: "Audit",
            auditId,
            actorUserId: null,
            action: "league.bootstrap",
            details: { leagueId, year: input.year, commissionerUserId: input.userId },
            at: now,
          },
        },
      },
    ];
    await transactWrite(db.doc, items, ["season_pointer", "season_meta", "draft", "audit"]);
    created = true;
  }

  return { leagueId, seasonId, userId: input.userId, created };
}
