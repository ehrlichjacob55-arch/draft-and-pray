/**
 * Persistence for docs/design/10 §4.1 (make a pick) and §4.2 (undo). The caller supplies
 * already-computed decisions (on-clock team, slot, deadline); this module only writes.
 */
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { TOTAL_PICKS, type Slot } from "@dnp/domain";
import type { Dynamo } from "../client";
import { TransactionConflictError, transactWrite, type TransactItems } from "../errors";
import { newId } from "../ids";
import type {
  DraftItem,
  PickItem,
  PlayerItem,
  RosterEntryItem,
  SeasonMetaItem,
  TeamItem,
} from "../items";
import {
  auditKey,
  draftKey,
  pickKey,
  playerKey,
  rosterEntryKey,
  seasonMetaKey,
  seasonPointerKey,
  teamKey,
} from "../keys";

export type MadeBy = PickItem["madeBy"];

export interface RecordPickInput {
  seasonId: string;
  expectedPick: number;
  teamId: string;
  playerId: string;
  slot: Slot;
  round: number;
  madeBy: MadeBy;
  madeByUserId: string | null;
  /** ISO deadline for the next pick (null when the clock is off or the draft just finished). */
  nextDeadline: string | null;
  isFinalPick: boolean;
  /** ISO timestamp. */
  now: string;
  /** When given, the league's season pointer status is kept in sync with META (doc 11 §8). */
  seasonPointer?: { leagueId: string; year: number };
}

/** §4.1. Throws TransactionConflictError labeled draft_state | pick_number | player | roster_slot. */
export async function recordPick(db: Dynamo, input: RecordPickInput): Promise<PickItem> {
  const { seasonId, expectedPick: n, now } = input;
  const TableName = db.tableName;
  const pick: PickItem = {
    ...pickKey(seasonId, n),
    type: "Pick",
    overallPick: n,
    round: input.round,
    teamId: input.teamId,
    playerId: input.playerId,
    slot: input.slot,
    madeBy: input.madeBy,
    madeByUserId: input.madeByUserId,
    madeAt: now,
  };
  const roster: RosterEntryItem = {
    ...rosterEntryKey(seasonId, input.teamId, input.slot, 1),
    type: "RosterEntry",
    teamId: input.teamId,
    slot: input.slot,
    playerId: input.playerId,
    fromRound: 1,
    acquiredVia: "draft",
  };
  const auditId = newId();
  const audit = {
    ...auditKey(seasonId, auditId),
    type: "Audit",
    auditId,
    actorUserId: input.madeByUserId,
    action: "draft.pick",
    details: {
      overallPick: n,
      teamId: input.teamId,
      playerId: input.playerId,
      slot: input.slot,
      madeBy: input.madeBy,
    },
    at: now,
  };

  const items: TransactItems = [
    {
      Update: {
        TableName,
        Key: draftKey(seasonId),
        // The alert-only clock belongs to one pick, so every pick clears it; `version` counts changes.
        UpdateExpression:
          (input.isFinalPick
            ? "SET currentPick = :next, currentPickDeadline = :dl, updatedAt = :now, #status = :complete"
            : "SET currentPick = :next, currentPickDeadline = :dl, updatedAt = :now") +
          " REMOVE clockStartedAt, clockSeconds, clockExpiresAt ADD version :one",
        ConditionExpression: "#status = :inProgress AND currentPick = :expected",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":next": n + 1,
          ":dl": input.isFinalPick ? null : input.nextDeadline,
          ":now": now,
          ":inProgress": "in_progress",
          ":expected": n,
          ":one": 1,
          ...(input.isFinalPick ? { ":complete": "complete" } : {}),
        },
      },
    },
    { Put: { TableName, Item: pick, ConditionExpression: "attribute_not_exists(pk)" } },
    {
      Update: {
        TableName,
        Key: playerKey(seasonId, input.playerId),
        UpdateExpression: "SET draftedByTeamId = :team, draftedAtPick = :n",
        ConditionExpression: "inPool = :true AND attribute_not_exists(draftedByTeamId)",
        ExpressionAttributeValues: { ":team": input.teamId, ":n": n, ":true": true },
      },
    },
    { Put: { TableName, Item: roster, ConditionExpression: "attribute_not_exists(pk)" } },
    { Put: { TableName, Item: audit } },
  ];
  const labels = ["draft_state", "pick_number", "player", "roster_slot", "audit"];
  if (input.isFinalPick) {
    items.push({
      Update: {
        TableName,
        Key: seasonMetaKey(seasonId),
        UpdateExpression: "SET #status = :s",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":s": "in_progress" },
      },
    });
    labels.push("season_meta");
    if (input.seasonPointer) {
      items.push(pointerUpdate(db.tableName, input.seasonPointer, "in_progress"));
      labels.push("season_pointer");
    }
  }
  await transactWrite(db.doc, items, labels);
  return pick;
}

function pointerUpdate(
  TableName: string,
  p: { leagueId: string; year: number },
  status: "drafting" | "in_progress",
) {
  return {
    Update: {
      TableName,
      Key: seasonPointerKey(p.leagueId, p.year),
      UpdateExpression: "SET #status = :s",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":s": status },
    },
  };
}

export interface UndoLastPickInput {
  seasonId: string;
  /** DRAFT.currentPick as read by the caller (n+1); the pick being undone is currentPick - 1. */
  currentPick: number;
  actorUserId: string;
  newDeadline: string | null;
  now: string;
  seasonPointer?: { leagueId: string; year: number };
}

/** §4.2. Throws TransactionConflictError labeled draft_state | pick | player | roster_slot. */
export async function undoLastPick(db: Dynamo, input: UndoLastPickInput): Promise<PickItem> {
  const { seasonId, currentPick, now } = input;
  const TableName = db.tableName;
  const n = currentPick - 1;
  if (n < 1) throw new Error("Nothing to undo");
  const got = await db.doc.send(
    new GetCommand({ TableName, Key: pickKey(seasonId, n), ConsistentRead: true }),
  );
  if (!got.Item) throw new TransactionConflictError([{ label: "pick", code: "NotFound" }]);
  const pick = got.Item as PickItem;
  const wasComplete = currentPick === TOTAL_PICKS + 1;
  const auditId = newId();

  const items: TransactItems = [
    {
      Update: {
        TableName,
        Key: draftKey(seasonId),
        UpdateExpression:
          (wasComplete
            ? "SET currentPick = :n, currentPickDeadline = :dl, updatedAt = :now, #status = :inProgress"
            : "SET currentPick = :n, currentPickDeadline = :dl, updatedAt = :now") +
          " REMOVE clockStartedAt, clockSeconds, clockExpiresAt ADD version :one",
        // Never during a redraft (`resetting`) or before the draft started.
        ConditionExpression:
          "currentPick = :n1 AND #status IN (:inProgressS, :pausedS, :completeS)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":inProgressS": "in_progress",
          ":pausedS": "paused",
          ":completeS": "complete",
          ":n": n,
          ":n1": currentPick,
          ":one": 1,
          ":dl": input.newDeadline,
          ":now": now,
          ...(wasComplete ? { ":inProgress": "in_progress" } : {}),
        },
      },
    },
    {
      Delete: {
        TableName,
        Key: pickKey(seasonId, n),
        ConditionExpression: "attribute_exists(pk)",
      },
    },
    {
      Update: {
        TableName,
        Key: playerKey(seasonId, pick.playerId),
        UpdateExpression: "REMOVE draftedByTeamId, draftedAtPick",
        ConditionExpression: "draftedByTeamId = :team",
        ExpressionAttributeValues: { ":team": pick.teamId },
      },
    },
    {
      Delete: {
        TableName,
        Key: rosterEntryKey(seasonId, pick.teamId, pick.slot, 1),
        ConditionExpression: "attribute_exists(pk)",
      },
    },
    {
      Put: {
        TableName,
        Item: {
          ...auditKey(seasonId, auditId),
          type: "Audit",
          auditId,
          actorUserId: input.actorUserId,
          action: "draft.undo_pick",
          details: {
            overallPick: n,
            teamId: pick.teamId,
            playerId: pick.playerId,
            slot: pick.slot,
          },
          at: now,
        },
      },
    },
  ];
  const labels = ["draft_state", "pick", "player", "roster_slot", "audit"];
  if (wasComplete) {
    items.push({
      Update: {
        TableName,
        Key: seasonMetaKey(seasonId),
        UpdateExpression: "SET #status = :s",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":s": "drafting" },
      },
    });
    labels.push("season_meta");
    if (input.seasonPointer) {
      items.push(pointerUpdate(TableName, input.seasonPointer, "drafting"));
      labels.push("season_pointer");
    }
  }
  await transactWrite(db.doc, items, labels);
  return pick;
}

// ---- Seed helpers (conditional puts) ----

async function putNew(db: Dynamo, item: Record<string, unknown>): Promise<void> {
  await db.doc.send(
    new PutCommand({
      TableName: db.tableName,
      Item: item,
      ConditionExpression: "attribute_not_exists(pk)",
    }),
  );
}

export async function putSeasonMeta(
  db: Dynamo,
  input: Omit<SeasonMetaItem, "pk" | "sk" | "type">,
): Promise<SeasonMetaItem> {
  const item: SeasonMetaItem = { ...seasonMetaKey(input.seasonId), type: "SeasonMeta", ...input };
  await putNew(db, item);
  return item;
}

export async function putDraftState(
  db: Dynamo,
  input: { seasonId: string } & Omit<
    DraftItem,
    "pk" | "sk" | "type" | "version" | "order" | "autoDraft"
  > &
    Partial<Pick<DraftItem, "version" | "order" | "autoDraft">>,
): Promise<DraftItem> {
  const { seasonId, autoDraft, ...rest } = input;
  const item: DraftItem = {
    ...draftKey(seasonId),
    type: "Draft",
    version: 0,
    order: [],
    autoDraft: autoDraft ?? [],
    ...rest,
  };
  // `autoDraft` is a DynamoDB string set (empty sets cannot be stored).
  await putNew(db, {
    ...item,
    autoDraft: autoDraft && autoDraft.length > 0 ? new Set(autoDraft) : undefined,
  });
  return item;
}

export async function putPlayer(
  db: Dynamo,
  input: { seasonId: string } & Omit<PlayerItem, "pk" | "sk" | "type">,
): Promise<PlayerItem> {
  const { seasonId, ...rest } = input;
  const item: PlayerItem = { ...playerKey(seasonId, rest.playerId), type: "Player", ...rest };
  await putNew(db, item);
  return item;
}

export async function putTeam(
  db: Dynamo,
  input: { seasonId: string } & Omit<TeamItem, "pk" | "sk" | "type">,
): Promise<TeamItem> {
  const { seasonId, ...rest } = input;
  const item: TeamItem = { ...teamKey(seasonId, rest.teamId), type: "Team", ...rest };
  await putNew(db, item);
  return item;
}
