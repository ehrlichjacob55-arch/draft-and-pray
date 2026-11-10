/**
 * Redraft (docs/design/10 §4.8): reset a started draft back to `scheduled`.
 *
 * 90 picks + roster entries + player markers exceed DynamoDB's 100-item transaction limit, so
 * this is a crash-safe, resumable three-phase recipe:
 *   1. lock:     one transaction moves DRAFT to `resetting` (status + version conditions). While
 *                `resetting`, every pick / undo / clock / start / order / auto-draft write fails.
 *   2. cleanup:  Query the season partition by documented prefixes (A2) and delete / update in
 *                chunks. Every chunk is idempotent, so a retry simply re-queries what is left.
 *   3. finalize: one transaction moves DRAFT to `scheduled` (condition `status = resetting`),
 *                puts META and the league's season pointer back to `setup`, and writes the audit.
 * Draft order, teams, memberships, the pool, queues and auto-draft toggles are not touched.
 */
import type { Dynamo } from "../client";
import {
  DomainError,
  TransactionConflictError,
  transactWrite,
  type TransactItems,
} from "../errors";
import { getDraft, requireDraft, auditPut } from "./draft-lifecycle";
import { draftKey, playerKey, seasonMetaKey, seasonPk, seasonPointerKey, skPrefix } from "../keys";
import { queryPrefix } from "./season";

/** Draft statuses a redraft may start from (any draft that has started). */
export const REDRAFT_FROM_STATUSES = ["in_progress", "paused", "complete"] as const;

const CHUNK = 50;
const statusNames = { "#status": "status" };

export interface ResetDraftInput {
  seasonId: string;
  leagueId: string;
  year: number;
  actorUserId: string;
  now: string;
}

/**
 * Phase 1. Throws DomainError `draft_wrong_status` (not started / season already past the draft)
 * or `conflict` (DRAFT.version changed under us, e.g. a pick landed). Returns quietly when
 * another caller already holds the lock (the caller then resumes).
 */
export async function lockDraftForReset(
  db: Dynamo,
  input: ResetDraftInput & { expectedVersion: number; pickCount: number },
): Promise<void> {
  const TableName = db.tableName;
  const items: TransactItems = [
    {
      Update: {
        TableName,
        Key: draftKey(input.seasonId),
        UpdateExpression:
          "SET #status = :resetting, resetPickCount = :count, updatedAt = :now " +
          "REMOVE clockStartedAt, clockSeconds, clockExpiresAt ADD version :one",
        ConditionExpression: "#status IN (:a, :b, :c) AND version = :v",
        ExpressionAttributeNames: statusNames,
        ExpressionAttributeValues: {
          ":resetting": "resetting",
          ":count": input.pickCount,
          ":now": input.now,
          ":one": 1,
          ":a": "in_progress",
          ":b": "paused",
          ":c": "complete",
          ":v": input.expectedVersion,
        },
      },
    },
    {
      ConditionCheck: {
        TableName,
        Key: seasonMetaKey(input.seasonId),
        ConditionExpression: "#status IN (:drafting, :inProgress)",
        ExpressionAttributeNames: statusNames,
        ExpressionAttributeValues: { ":drafting": "drafting", ":inProgress": "in_progress" },
      },
    },
  ];
  try {
    await transactWrite(db.doc, items, ["draft_state", "season_meta"]);
  } catch (err) {
    if (!(err instanceof TransactionConflictError)) throw err;
    if (err.has("season_meta"))
      throw new DomainError("draft_wrong_status", "The season is past the draft");
    const old = err.reasons.find((r) => r.label === "draft_state")?.item;
    const status = old?.status;
    if (status === "resetting") return; // someone else locked it: the caller resumes
    if (!(REDRAFT_FROM_STATUSES as readonly unknown[]).includes(status))
      throw new DomainError("draft_wrong_status", "The draft has not started");
    throw new DomainError("conflict", "The draft changed; try again");
  }
}

/** Runs `items` in transactions of CHUNK; all operations here are idempotent. */
async function runChunks(db: Dynamo, items: TransactItems, label: string): Promise<void> {
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    await transactWrite(
      db.doc,
      chunk,
      chunk.map((_, j) => `${label}${i + j}`),
    );
  }
}

/**
 * Phase 2. Clears player `draftedBy…` markers, draft roster entries and picks. Exception roster
 * entries (`acquiredVia = exception`) are left alone. Returns how many items it touched.
 */
export async function clearDraftData(
  db: Dynamo,
  seasonId: string,
): Promise<{ players: number; rosters: number; picks: number }> {
  const TableName = db.tableName;
  const pk = seasonPk(seasonId);
  const players = (await queryPrefix(db, pk, skPrefix.players, { consistentRead: true })).filter(
    (p) => p.draftedByTeamId !== undefined || p.draftedAtPick !== undefined,
  );
  await runChunks(
    db,
    players.map((p) => ({
      Update: {
        TableName,
        Key: playerKey(seasonId, String(p.playerId)),
        UpdateExpression: "REMOVE draftedByTeamId, draftedAtPick",
        ConditionExpression: "attribute_exists(pk)",
      },
    })),
    "player",
  );
  const rosters = (await queryPrefix(db, pk, skPrefix.rosters, { consistentRead: true })).filter(
    (r) => r.acquiredVia === "draft",
  );
  await runChunks(
    db,
    rosters.map((r) => ({
      Delete: { TableName, Key: { pk: r.pk as string, sk: r.sk as string } },
    })),
    "roster",
  );
  const picks = await queryPrefix(db, pk, skPrefix.picks, { consistentRead: true });
  await runChunks(
    db,
    picks.map((p) => ({
      Delete: { TableName, Key: { pk: p.pk as string, sk: p.sk as string } },
    })),
    "pick",
  );
  return { players: players.length, rosters: rosters.length, picks: picks.length };
}

/** Phase 3. A no-op success when another resume already finished the reset (idempotent). */
export async function finalizeDraftReset(
  db: Dynamo,
  input: ResetDraftInput & { picksCleared: number },
): Promise<void> {
  const TableName = db.tableName;
  const pointer = (s: string) => ({
    Update: {
      TableName,
      Key: seasonPointerKey(input.leagueId, input.year),
      UpdateExpression: "SET #status = :s",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: statusNames,
      ExpressionAttributeValues: { ":s": s },
    },
  });
  const items: TransactItems = [
    {
      Update: {
        TableName,
        Key: draftKey(input.seasonId),
        UpdateExpression:
          "SET #status = :scheduled, currentPick = :one, currentPickDeadline = :null, " +
          "startedAt = :null, updatedAt = :now " +
          "REMOVE clockStartedAt, clockSeconds, clockExpiresAt, resetPickCount ADD version :one",
        ConditionExpression: "#status = :resetting",
        ExpressionAttributeNames: statusNames,
        ExpressionAttributeValues: {
          ":scheduled": "scheduled",
          ":resetting": "resetting",
          ":one": 1,
          ":null": null,
          ":now": input.now,
        },
      },
    },
    {
      // Back to the pre-start value, consistent with startDraft (setup -> drafting).
      Update: {
        TableName,
        Key: seasonMetaKey(input.seasonId),
        UpdateExpression: "SET #status = :s",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: statusNames,
        ExpressionAttributeValues: { ":s": "setup" },
      },
    },
    pointer("setup"),
    auditPut(
      TableName,
      input.seasonId,
      input.actorUserId,
      "draft.reset",
      { picksCleared: input.picksCleared },
      input.now,
    ),
  ];
  try {
    await transactWrite(db.doc, items, ["draft_state", "season_meta", "season_pointer", "audit"]);
  } catch (err) {
    if (err instanceof TransactionConflictError && err.has("draft_state")) {
      // A concurrent resume may have finished already; that is success.
      if ((await getDraft(db, input.seasonId))?.status === "scheduled") return;
      throw new DomainError("draft_wrong_status", "The draft reset could not be completed");
    }
    throw err;
  }
}

/**
 * Whole recipe; safe to call again while `resetting` (resumes). Returns the number of picks the
 * redraft removed.
 */
export async function resetDraft(db: Dynamo, input: ResetDraftInput): Promise<number> {
  let draft = await requireDraft(db, input.seasonId);
  if (draft.status !== "resetting") {
    await lockDraftForReset(db, {
      ...input,
      expectedVersion: draft.version,
      pickCount: Math.max(0, draft.currentPick - 1),
    });
    draft = await requireDraft(db, input.seasonId);
  }
  const picksCleared = draft.resetPickCount ?? 0;
  await clearDraftData(db, input.seasonId);
  await finalizeDraftReset(db, { ...input, picksCleared });
  return picksCleared;
}
