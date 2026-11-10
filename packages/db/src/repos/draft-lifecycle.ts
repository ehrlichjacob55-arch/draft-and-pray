/**
 * Draft state reads and lifecycle writes (docs/design/10 §4.3, 14 §4): order, start, pause,
 * resume, clock, auto-draft and queues. Every write bumps DRAFT.version and (for commissioner
 * actions) writes an AUDIT item holding ids only.
 */
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { TEAM_COUNT } from "@dnp/domain";
import type { Dynamo } from "../client";
import {
  DomainError,
  TransactionConflictError,
  transactWrite,
  type TransactItems,
} from "../errors";
import { newId } from "../ids";
import { parseItem, type DraftItem, type QueueItem } from "../items";
import { auditKey, draftKey, queueKey, seasonMetaKey, seasonPointerKey, teamKey } from "../keys";

export async function getDraft(db: Dynamo, seasonId: string): Promise<DraftItem | undefined> {
  const r = await db.doc.send(
    new GetCommand({ TableName: db.tableName, Key: draftKey(seasonId), ConsistentRead: true }),
  );
  if (!r.Item) return undefined;
  const item = parseItem(r.Item);
  return item.type === "Draft" ? item : undefined;
}

export async function requireDraft(db: Dynamo, seasonId: string): Promise<DraftItem> {
  const d = await getDraft(db, seasonId);
  if (!d) throw new DomainError("not_found", "Draft not found");
  return d;
}

export function auditPut(
  TableName: string,
  seasonId: string,
  actorUserId: string | null,
  action: string,
  details: Record<string, unknown>,
  now: string,
) {
  const auditId = newId();
  return {
    Put: {
      TableName,
      Item: {
        ...auditKey(seasonId, auditId),
        type: "Audit",
        auditId,
        actorUserId,
        action,
        details,
        at: now,
      },
    },
  };
}

interface Common {
  seasonId: string;
  actorUserId: string;
  now: string;
}

/** Runs a DRAFT-conditioned transaction; a failed DRAFT condition becomes `draft_wrong_status`. */
async function draftTx(
  db: Dynamo,
  items: TransactItems,
  labels: string[],
  wrongStatusMessage: string,
): Promise<void> {
  try {
    await transactWrite(db.doc, items, labels);
  } catch (err) {
    if (err instanceof TransactionConflictError && err.has("draft_state"))
      throw new DomainError("draft_wrong_status", wrongStatusMessage);
    throw err;
  }
}

const statusNames = { "#status": "status" };

/** Sets the draft order and every TEAM.draftPosition (only while `scheduled`/`lobby`). */
export async function setDraftOrder(
  db: Dynamo,
  input: Common & { order: string[] },
): Promise<void> {
  const { seasonId, order, now } = input;
  const TableName = db.tableName;
  if (order.length !== TEAM_COUNT || new Set(order).size !== TEAM_COUNT)
    throw new DomainError("validation_error", `Order must list ${TEAM_COUNT} distinct teams`);
  const items: TransactItems = [
    {
      Update: {
        TableName,
        Key: draftKey(seasonId),
        UpdateExpression: "SET #order = :order, updatedAt = :now ADD version :one",
        ConditionExpression: "#status IN (:scheduled, :lobby)",
        ExpressionAttributeNames: { "#order": "order", "#status": "status" },
        ExpressionAttributeValues: {
          ":order": order,
          ":now": now,
          ":one": 1,
          ":scheduled": "scheduled",
          ":lobby": "lobby",
        },
      },
    },
    ...order.map((teamId, i) => ({
      Update: {
        TableName,
        Key: teamKey(seasonId, teamId),
        UpdateExpression: "SET draftPosition = :p",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeValues: { ":p": i + 1 },
      },
    })),
    auditPut(TableName, seasonId, input.actorUserId, "draft.set_order", { order }, now),
  ];
  const labels = ["draft_state", ...order.map((_, i) => `team${i}`), "audit"];
  try {
    await draftTx(db, items, labels, "The draft order can only change before the draft starts");
  } catch (err) {
    if (err instanceof TransactionConflictError)
      throw new DomainError("validation_error", "Unknown team in the draft order");
    throw err;
  }
}

/** scheduled|lobby -> in_progress; season META and pointer -> drafting. Preconditions are checked by the caller. */
export async function startDraft(
  db: Dynamo,
  input: Common & { leagueId: string; year: number },
): Promise<void> {
  const { seasonId, now } = input;
  const TableName = db.tableName;
  const items: TransactItems = [
    {
      Update: {
        TableName,
        Key: draftKey(seasonId),
        UpdateExpression:
          "SET #status = :ip, currentPick = :one, startedAt = :now, updatedAt = :now ADD version :one",
        ConditionExpression: "#status IN (:scheduled, :lobby) AND size(#order) = :nine",
        ExpressionAttributeNames: { "#status": "status", "#order": "order" },
        ExpressionAttributeValues: {
          ":ip": "in_progress",
          ":one": 1,
          ":now": now,
          ":nine": TEAM_COUNT,
          ":scheduled": "scheduled",
          ":lobby": "lobby",
        },
      },
    },
    {
      Update: {
        TableName,
        Key: seasonMetaKey(seasonId),
        UpdateExpression: "SET #status = :s",
        ConditionExpression: "#status = :setup",
        ExpressionAttributeNames: statusNames,
        ExpressionAttributeValues: { ":s": "drafting", ":setup": "setup" },
      },
    },
    {
      Update: {
        TableName,
        Key: seasonPointerKey(input.leagueId, input.year),
        UpdateExpression: "SET #status = :s",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: statusNames,
        ExpressionAttributeValues: { ":s": "drafting" },
      },
    },
    auditPut(TableName, seasonId, input.actorUserId, "draft.start", {}, now),
  ];
  await draftTx(
    db,
    items,
    ["draft_state", "season_meta", "season_pointer", "audit"],
    "The draft cannot be started",
  );
}

/** in_progress -> paused; clears the clock. */
export async function pauseDraft(db: Dynamo, input: Common): Promise<void> {
  const TableName = db.tableName;
  await draftTx(
    db,
    [
      {
        Update: {
          TableName,
          Key: draftKey(input.seasonId),
          UpdateExpression:
            "SET #status = :paused, updatedAt = :now REMOVE clockStartedAt, clockSeconds, clockExpiresAt ADD version :one",
          ConditionExpression: "#status = :ip",
          ExpressionAttributeNames: statusNames,
          ExpressionAttributeValues: {
            ":paused": "paused",
            ":ip": "in_progress",
            ":now": input.now,
            ":one": 1,
          },
        },
      },
      auditPut(TableName, input.seasonId, input.actorUserId, "draft.pause", {}, input.now),
    ],
    ["draft_state", "audit"],
    "Only a draft in progress can be paused",
  );
}

/** paused -> in_progress. */
export async function resumeDraft(db: Dynamo, input: Common): Promise<void> {
  const TableName = db.tableName;
  await draftTx(
    db,
    [
      {
        Update: {
          TableName,
          Key: draftKey(input.seasonId),
          UpdateExpression: "SET #status = :ip, updatedAt = :now ADD version :one",
          ConditionExpression: "#status = :paused",
          ExpressionAttributeNames: statusNames,
          ExpressionAttributeValues: {
            ":paused": "paused",
            ":ip": "in_progress",
            ":now": input.now,
            ":one": 1,
          },
        },
      },
      auditPut(TableName, input.seasonId, input.actorUserId, "draft.resume", {}, input.now),
    ],
    ["draft_state", "audit"],
    "Only a paused draft can be resumed",
  );
}

/** Starts the alert-only clock on pick `expectedPick` (must still be the current pick). */
export async function startClock(
  db: Dynamo,
  input: Common & { expectedPick: number; seconds: number },
): Promise<{ startedAt: string; expiresAt: string }> {
  const TableName = db.tableName;
  const expiresAt = new Date(Date.parse(input.now) + input.seconds * 1000).toISOString();
  try {
    await transactWrite(
      db.doc,
      [
        {
          Update: {
            TableName,
            Key: draftKey(input.seasonId),
            UpdateExpression:
              "SET clockStartedAt = :now, clockSeconds = :sec, clockExpiresAt = :exp, updatedAt = :now ADD version :one",
            ConditionExpression: "#status = :ip AND currentPick = :pick",
            ExpressionAttributeNames: statusNames,
            ExpressionAttributeValues: {
              ":ip": "in_progress",
              ":pick": input.expectedPick,
              ":now": input.now,
              ":sec": input.seconds,
              ":exp": expiresAt,
              ":one": 1,
            },
          },
        },
        auditPut(
          TableName,
          input.seasonId,
          input.actorUserId,
          "draft.clock_start",
          { overallPick: input.expectedPick, seconds: input.seconds },
          input.now,
        ),
      ],
      ["draft_state", "audit"],
    );
  } catch (err) {
    if (err instanceof TransactionConflictError && err.has("draft_state"))
      throw new DomainError("stale_pick", "The pick changed or the draft is not in progress");
    throw err;
  }
  return { startedAt: input.now, expiresAt };
}

export async function clearClock(db: Dynamo, input: Common): Promise<void> {
  const TableName = db.tableName;
  await draftTx(
    db,
    [
      {
        Update: {
          TableName,
          Key: draftKey(input.seasonId),
          UpdateExpression:
            "SET updatedAt = :now REMOVE clockStartedAt, clockSeconds, clockExpiresAt ADD version :one",
          ConditionExpression: "#status = :ip AND attribute_exists(clockExpiresAt)",
          ExpressionAttributeNames: statusNames,
          ExpressionAttributeValues: { ":ip": "in_progress", ":now": input.now, ":one": 1 },
        },
      },
      auditPut(TableName, input.seasonId, input.actorUserId, "draft.clock_clear", {}, input.now),
    ],
    ["draft_state", "audit"],
    "There is no running clock to clear",
  );
}

/** Atomic ADD/DELETE on the `autoDraft` string set (any status except complete). */
export async function setAutoDraft(
  db: Dynamo,
  input: { seasonId: string; teamId: string; enabled: boolean; actorUserId: string; now: string },
): Promise<void> {
  const TableName = db.tableName;
  await draftTx(
    db,
    [
      {
        Update: {
          TableName,
          Key: draftKey(input.seasonId),
          UpdateExpression: input.enabled
            ? "SET updatedAt = :now ADD autoDraft :team, version :one"
            : "SET updatedAt = :now DELETE autoDraft :team ADD version :one",
          ConditionExpression: "#status <> :complete",
          ExpressionAttributeNames: statusNames,
          ExpressionAttributeValues: {
            ":complete": "complete",
            ":now": input.now,
            ":team": new Set([input.teamId]),
            ":one": 1,
          },
        },
      },
      auditPut(
        TableName,
        input.seasonId,
        input.actorUserId,
        "draft.auto_draft",
        { teamId: input.teamId, enabled: input.enabled },
        input.now,
      ),
    ],
    ["draft_state", "audit"],
    "The draft is complete",
  );
}

export async function getQueue(
  db: Dynamo,
  seasonId: string,
  teamId: string,
): Promise<QueueItem | undefined> {
  const r = await db.doc.send(
    new GetCommand({ TableName: db.tableName, Key: queueKey(seasonId, teamId) }),
  );
  if (!r.Item) return undefined;
  const item = parseItem(r.Item);
  return item.type === "Queue" ? item : undefined;
}

/** Private to the team (no version bump, no broadcast). */
export async function putQueue(
  db: Dynamo,
  input: { seasonId: string; teamId: string; playerIds: string[]; now: string },
): Promise<void> {
  const item: QueueItem = {
    ...queueKey(input.seasonId, input.teamId),
    type: "Queue",
    teamId: input.teamId,
    playerIds: input.playerIds,
    updatedAt: input.now,
  };
  await db.doc.send(new PutCommand({ TableName: db.tableName, Item: item }));
}
