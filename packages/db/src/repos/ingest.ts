/**
 * Live-stats ingest registry (docs/design/10 §2 `INGEST` partition, A15): one small item per
 * season holding the on/off switch, when the next poll is due, a lease so only one run works at a
 * time, and the last run's outcome. Every commissioner action is audited in the same transaction.
 */
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Dynamo } from "../client";
import { transactWrite } from "../errors";
import { INGEST_WARNINGS_MAX, parseItem, type IngestStateItem } from "../items";
import { INGEST_PK, ingestKey } from "../keys";
import { auditPut } from "./draft-lifecycle";
import { queryPrefix } from "./season";

const asState = (raw: Record<string, unknown>): IngestStateItem => {
  const item = parseItem(raw);
  if (item.type !== "IngestState") throw new Error(`Expected IngestState, got ${item.type}`);
  return item;
};

export async function getIngestState(
  db: Dynamo,
  seasonId: string,
): Promise<IngestStateItem | undefined> {
  const r = await db.doc.send(
    new GetCommand({ TableName: db.tableName, Key: ingestKey(seasonId), ConsistentRead: true }),
  );
  return r.Item ? asState(r.Item) : undefined;
}

/** A15: every season's registry item (`Query pk = INGEST`; the partition holds one item per season). */
export async function listIngestRegistry(db: Dynamo): Promise<IngestStateItem[]> {
  const raw = await queryPrefix(db, INGEST_PK, "SEASON#", { consistentRead: true });
  return raw.map(asState);
}

/**
 * Turns live stats on or off (creating the registry item the first time) and writes the audit
 * event in the same transaction. Enabling makes the next poll due now; disabling clears it.
 */
export async function setIngestEnabled(
  db: Dynamo,
  input: {
    seasonId: string;
    leagueId: string;
    year: number;
    enabled: boolean;
    actorUserId: string;
    now: string;
  },
): Promise<void> {
  await transactWrite(
    db.doc,
    [
      {
        Update: {
          TableName: db.tableName,
          Key: ingestKey(input.seasonId),
          UpdateExpression:
            "SET #type = :type, seasonId = :sid, leagueId = :lid, #year = :year, enabled = :en, nextPollAt = :next, warnings = if_not_exists(warnings, :empty)",
          ExpressionAttributeNames: { "#type": "type", "#year": "year" },
          ExpressionAttributeValues: {
            ":type": "IngestState",
            ":sid": input.seasonId,
            ":lid": input.leagueId,
            ":year": input.year,
            ":en": input.enabled,
            ":next": input.enabled ? input.now : null,
            ":empty": [],
          },
        },
      },
      auditPut(
        db.tableName,
        input.seasonId,
        input.actorUserId,
        input.enabled ? "ingest.enable" : "ingest.disable",
        {},
        input.now,
      ),
    ],
    ["ingest", "audit"],
  );
}

/** Audit event for a commissioner's "Refresh now" (the run itself is `runIngest`). */
export async function auditIngestRun(
  db: Dynamo,
  input: { seasonId: string; actorUserId: string; now: string },
): Promise<void> {
  await transactWrite(
    db.doc,
    [auditPut(db.tableName, input.seasonId, input.actorUserId, "ingest.run", {}, input.now)],
    ["audit"],
  );
}

/**
 * Takes the run lease for `ttlMs` (creating a disabled registry item if the season has none yet).
 * False when another run still holds an unexpired lease.
 */
export async function acquireIngestLease(
  db: Dynamo,
  input: { seasonId: string; leagueId: string; year: number; now: string; ttlMs: number },
): Promise<boolean> {
  const until = new Date(Date.parse(input.now) + input.ttlMs).toISOString();
  try {
    await db.doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: ingestKey(input.seasonId),
        UpdateExpression:
          "SET leaseUntil = :until, #type = if_not_exists(#type, :type), seasonId = if_not_exists(seasonId, :sid), leagueId = if_not_exists(leagueId, :lid), #year = if_not_exists(#year, :year), enabled = if_not_exists(enabled, :false), nextPollAt = if_not_exists(nextPollAt, :null), warnings = if_not_exists(warnings, :empty)",
        ConditionExpression: "attribute_not_exists(leaseUntil) OR leaseUntil < :now",
        ExpressionAttributeNames: { "#type": "type", "#year": "year" },
        ExpressionAttributeValues: {
          ":until": until,
          ":now": input.now,
          ":type": "IngestState",
          ":sid": input.seasonId,
          ":lid": input.leagueId,
          ":year": input.year,
          ":false": false,
          ":null": null,
          ":empty": [],
        },
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

export interface FinishIngestRun {
  seasonId: string;
  now: string;
  /** Present for a successful run; absent when it failed. */
  summary?: NonNullable<IngestStateItem["lastSummary"]>;
  /** Short, PII-free message of a failed run. */
  error?: string;
  warnings: string[];
  /** ISO time of the next due run, or null for "off". */
  nextPollAt: string | null;
}

/** Releases the lease and records the outcome. Warnings are deduplicated and capped at 100. */
export async function finishIngestRun(db: Dynamo, input: FinishIngestRun): Promise<void> {
  const warnings = [...new Set(input.warnings)].slice(0, INGEST_WARNINGS_MAX);
  const ok = input.error === undefined;
  await db.doc.send(
    new UpdateCommand({
      TableName: db.tableName,
      Key: ingestKey(input.seasonId),
      UpdateExpression: ok
        ? "SET lastRunAt = :now, lastSuccessAt = :now, lastSummary = :summary, nextPollAt = :next, warnings = :warnings REMOVE leaseUntil, lastError"
        : "SET lastRunAt = :now, lastError = :error, nextPollAt = :next, warnings = :warnings REMOVE leaseUntil",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: {
        ":now": input.now,
        ":next": input.nextPollAt,
        ":warnings": warnings,
        ...(ok ? { ":summary": input.summary } : { ":error": input.error }),
      },
    }),
  );
}

/** Makes the next poll due now (used when a commissioner asks for a refresh). */
export async function requestIngestRun(
  db: Dynamo,
  input: { seasonId: string; now: string },
): Promise<void> {
  await db.doc.send(
    new UpdateCommand({
      TableName: db.tableName,
      Key: ingestKey(input.seasonId),
      UpdateExpression: "SET nextPollAt = :now",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ":now": input.now },
    }),
  );
}
