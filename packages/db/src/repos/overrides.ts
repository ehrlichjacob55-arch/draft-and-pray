/**
 * Stat overrides and round finalization (docs/design/10 §4.4, §4.7; 04 §6-7). Every write is one
 * transaction that also holds its AUDIT item, so a commissioner action is never half-recorded.
 */
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Dynamo } from "../client";
import {
  DomainError,
  TransactionConflictError,
  transactWrite,
  type TransactItems,
} from "../errors";
import { parseItem, type OverrideItem, type TeamScoreItem } from "../items";
import { overrideKey, roundKey, seasonPk, skPrefix, teamScoreKey } from "../keys";
import { auditPut } from "./draft-lifecycle";
import { queryPrefix } from "./season";

/** Query `begins_with(sk, "OVERRIDE#")` (A11): every override of a season. */
export async function listOverrides(db: Dynamo, seasonId: string): Promise<OverrideItem[]> {
  const raw = await queryPrefix(db, seasonPk(seasonId), skPrefix.overrides, {
    consistentRead: true,
  });
  return raw.map((r) => parseItem(r)).filter((i): i is OverrideItem => i.type === "Override");
}

/** Query `begins_with(sk, "TEAMSCORE#<round>#")`: one round's team scores. */
export async function listRoundTeamScores(
  db: Dynamo,
  seasonId: string,
  round: number,
): Promise<TeamScoreItem[]> {
  const raw = await queryPrefix(db, seasonPk(seasonId), skPrefix.teamScoresOfRound(round), {
    consistentRead: true,
  });
  return raw.map((r) => parseItem(r)).filter((i): i is TeamScoreItem => i.type === "TeamScore");
}

const roundNotFinalized = () =>
  new DomainError("round_finalized", "This round is finalized. Unfreeze the round first.");

/** The round must still not be `finalized` when the transaction commits (a finalize may race us). */
const roundOpenCheck = (TableName: string, seasonId: string, round: number) => ({
  ConditionCheck: {
    TableName,
    Key: roundKey(seasonId, round),
    ConditionExpression: "attribute_not_exists(pk) OR #s <> :finalized",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":finalized": "finalized" },
  },
});

export interface SetOverrideInput {
  seasonId: string;
  round: number;
  gameId: string;
  playerId: string;
  statKey: string;
  value: number;
  reason: string;
  /** The effective value before this change (provider value with any earlier override). */
  from: number;
  actorUserId: string;
  now: string;
}

/** Puts (or replaces) `OVERRIDE#…` and its `override.set` audit event in one transaction. */
export async function setOverride(db: Dynamo, input: SetOverrideInput): Promise<void> {
  const { seasonId, now } = input;
  const items: TransactItems = [
    {
      Put: {
        TableName: db.tableName,
        Item: {
          ...overrideKey(seasonId, input.gameId, input.playerId, input.statKey),
          type: "Override",
          gameId: input.gameId,
          playerId: input.playerId,
          statKey: input.statKey,
          value: input.value,
          reason: input.reason,
          byUserId: input.actorUserId,
          at: now,
        },
      },
    },
    roundOpenCheck(db.tableName, seasonId, input.round),
    auditPut(
      db.tableName,
      seasonId,
      input.actorUserId,
      "override.set",
      {
        gameId: input.gameId,
        playerId: input.playerId,
        statKey: input.statKey,
        from: input.from,
        to: input.value,
        reason: input.reason,
      },
      now,
    ),
  ];
  try {
    await transactWrite(db.doc, items, ["override", "round", "audit"]);
  } catch (err) {
    if (err instanceof TransactionConflictError && err.has("round")) throw roundNotFinalized();
    throw err;
  }
}

export interface ClearOverrideInput {
  seasonId: string;
  round: number;
  gameId: string;
  playerId: string;
  statKey: string;
  /** The override's value being removed (for the audit event). */
  from: number;
  actorUserId: string;
  now: string;
}

/** Deletes `OVERRIDE#…` with an `override.clear` audit event; 404 when it does not exist. */
export async function clearOverride(db: Dynamo, input: ClearOverrideInput): Promise<void> {
  const { seasonId, now } = input;
  const items: TransactItems = [
    {
      Delete: {
        TableName: db.tableName,
        Key: overrideKey(seasonId, input.gameId, input.playerId, input.statKey),
        ConditionExpression: "attribute_exists(pk)",
      },
    },
    roundOpenCheck(db.tableName, seasonId, input.round),
    auditPut(
      db.tableName,
      seasonId,
      input.actorUserId,
      "override.clear",
      {
        gameId: input.gameId,
        playerId: input.playerId,
        statKey: input.statKey,
        from: input.from,
      },
      now,
    ),
  ];
  try {
    await transactWrite(db.doc, items, ["override", "round", "audit"]);
  } catch (err) {
    if (err instanceof TransactionConflictError) {
      if (err.has("round")) throw roundNotFinalized();
      if (err.has("override")) throw new DomainError("not_found", "Override not found");
    }
    throw err;
  }
}

export interface FinalizeRoundInput {
  seasonId: string;
  round: number;
  actorUserId: string;
  now: string;
  /** The round's TEAMSCORE items as just recomputed; they are frozen as final in the same transaction. */
  teamScores: readonly Pick<TeamScoreItem, "teamId" | "points">[];
}

/**
 * `final` -> `finalized` (doc 10 §4.4): the ROUND update, the `provisional = false` flip of the
 * round's TEAMSCORE items (each conditioned on the points that were audited, so a score that
 * moved meanwhile cancels the finalize) and the `round.finalize` audit event commit together.
 * This is the only write ever made to a finalized round's scores and it changes only `provisional`.
 */
export async function finalizeRound(db: Dynamo, input: FinalizeRoundInput): Promise<void> {
  const { seasonId, round, now } = input;
  const items: TransactItems = [
    {
      Update: {
        TableName: db.tableName,
        Key: roundKey(seasonId, round),
        UpdateExpression:
          "SET #s = :finalized, finalizedAt = :now, finalizedBy = :by REMOVE providerChangedAt",
        ConditionExpression: "#s = :final",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":finalized": "finalized",
          ":final": "final",
          ":now": now,
          ":by": input.actorUserId,
        },
      },
    },
    ...input.teamScores.map((t) => ({
      Update: {
        TableName: db.tableName,
        Key: teamScoreKey(seasonId, round, t.teamId),
        UpdateExpression: "SET provisional = :false",
        ConditionExpression: "points = :points",
        ExpressionAttributeValues: { ":false": false, ":points": t.points },
      },
    })),
    auditPut(
      db.tableName,
      seasonId,
      input.actorUserId,
      "round.finalize",
      { round, teamScores: Object.fromEntries(input.teamScores.map((t) => [t.teamId, t.points])) },
      now,
    ),
  ];
  const labels = ["round", ...input.teamScores.map((t) => `score:${t.teamId}`), "audit"];
  try {
    await transactWrite(db.doc, items, labels);
  } catch (err) {
    if (err instanceof TransactionConflictError) {
      if (err.has("round"))
        throw new DomainError(
          "round_not_final",
          "The round is no longer final. Refresh and retry.",
        );
      throw new DomainError("conflict", "Scores changed while finalizing. Try again.");
    }
    throw err;
  }
}

export interface UnfreezeRoundInput {
  seasonId: string;
  round: number;
  reason: string;
  actorUserId: string;
  now: string;
}

/** `finalized` -> `final` with a `round.unfreeze` audit event (the next recompute updates the scores). */
export async function unfreezeRound(db: Dynamo, input: UnfreezeRoundInput): Promise<void> {
  const { seasonId, round, now } = input;
  try {
    await transactWrite(
      db.doc,
      [
        {
          Update: {
            TableName: db.tableName,
            Key: roundKey(seasonId, round),
            UpdateExpression: "SET #s = :final REMOVE finalizedAt, finalizedBy, providerChangedAt",
            ConditionExpression: "#s = :finalized",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":final": "final", ":finalized": "finalized" },
          },
        },
        auditPut(
          db.tableName,
          seasonId,
          input.actorUserId,
          "round.unfreeze",
          { round, reason: input.reason },
          now,
        ),
      ],
      ["round", "audit"],
    );
  } catch (err) {
    if (err instanceof TransactionConflictError && err.has("round"))
      throw new DomainError("round_not_finalized", "This round is not finalized.");
    throw err;
  }
}

/**
 * Flags a finalized round whose raw stats changed after it was frozen (doc 04 §6). A no-op unless
 * the round is still `finalized`. Returns whether it was set.
 */
export async function markProviderChanged(
  db: Dynamo,
  seasonId: string,
  round: number,
  now: string,
): Promise<boolean> {
  try {
    await db.doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: roundKey(seasonId, round),
        UpdateExpression: "SET providerChangedAt = :now",
        ConditionExpression: "#s = :finalized",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":now": now, ":finalized": "finalized" },
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}
