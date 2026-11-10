/**
 * Scoring rulesets (docs/design/10 §2 RULESET, I-6): immutable-once-locked versions plus the
 * season's active pointer (`META.activeRulesetVersion`). Every commissioner action writes an
 * AUDIT item in the same transaction.
 */
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { BUILTIN_RULESETS, parseRuleset, type BuiltinRulesetName, type Ruleset } from "@dnp/domain";
import type { Dynamo } from "../client";
import {
  DomainError,
  TransactionConflictError,
  transactWrite,
  type TransactItems,
} from "../errors";
import { parseItem, type RulesetItem } from "../items";
import { rulesetKey, seasonMetaKey, seasonPk } from "../keys";
import { auditPut } from "./draft-lifecycle";
import { queryPrefix } from "./season";

export interface StoredRuleset {
  item: RulesetItem;
  /** The parsed, validated ruleset the engine uses. */
  ruleset: Ruleset;
}

interface Actor {
  seasonId: string;
  actorUserId: string | null;
  /** ISO timestamp; defaults to now. */
  now?: string;
}

function validated(
  rules: unknown,
  version: number,
): { json: Record<string, unknown>; ruleset: Ruleset } {
  if (typeof rules !== "object" || rules === null || Array.isArray(rules))
    throw new DomainError("validation_error", "A ruleset must be a JSON object");
  const json = { ...(rules as Record<string, unknown>), version };
  try {
    return { json, ruleset: parseRuleset(json) };
  } catch (err) {
    throw new DomainError("validation_error", (err as Error).message);
  }
}

function toStored(raw: Record<string, unknown>): StoredRuleset {
  const item = parseItem(raw);
  if (item.type !== "Ruleset") throw new Error(`Expected a Ruleset item, got ${item.type}`);
  return { item, ruleset: parseRuleset({ ...item.rules, version: item.version }) };
}

/** A8-style point read of one version. */
export async function getRuleset(
  db: Dynamo,
  seasonId: string,
  version: number,
): Promise<StoredRuleset | undefined> {
  const r = await db.doc.send(
    new GetCommand({
      TableName: db.tableName,
      Key: rulesetKey(seasonId, version),
      ConsistentRead: true,
    }),
  );
  return r.Item ? toStored(r.Item) : undefined;
}

/** Every version, ascending. One Query on `begins_with(sk, "RULESET#")`. */
export async function listRulesets(db: Dynamo, seasonId: string): Promise<StoredRuleset[]> {
  const raw = await queryPrefix(db, seasonPk(seasonId), "RULESET#", { consistentRead: true });
  return raw.map(toStored);
}

/** The version `META.activeRulesetVersion` points at; undefined if no such version exists yet. */
export async function getActiveRuleset(
  db: Dynamo,
  seasonId: string,
): Promise<StoredRuleset | undefined> {
  const meta = await db.doc.send(
    new GetCommand({ TableName: db.tableName, Key: seasonMetaKey(seasonId), ConsistentRead: true }),
  );
  if (!meta.Item) throw new DomainError("not_found", "Season not found");
  return getRuleset(db, seasonId, Number(meta.Item.activeRulesetVersion));
}

/**
 * Creates the next version (highest existing + 1), unlocked. `rules` is the ruleset JSON; its
 * `version` field is overwritten with the assigned one. Validation errors are a `validation_error`
 * listing every problem; a concurrent creator of the same version gets a `conflict`.
 */
export async function createRulesetVersion(
  db: Dynamo,
  input: Actor & { rules: unknown; note?: string },
): Promise<StoredRuleset> {
  const existing = await queryPrefix(db, seasonPk(input.seasonId), "RULESET#", {
    consistentRead: true,
  });
  const version = existing.reduce((max, r) => Math.max(max, Number(r.version)), 0) + 1;
  const { json } = validated(input.rules, version);
  const now = input.now ?? new Date().toISOString();
  const item: RulesetItem = {
    ...rulesetKey(input.seasonId, version),
    type: "Ruleset",
    version,
    rules: json,
    locked: false,
    createdAt: now,
    createdBy: input.actorUserId,
    ...(input.note !== undefined ? { note: input.note } : {}),
  };
  const items: TransactItems = [
    {
      ConditionCheck: {
        TableName: db.tableName,
        Key: seasonMetaKey(input.seasonId),
        ConditionExpression: "attribute_exists(pk)",
      },
    },
    {
      Put: { TableName: db.tableName, Item: item, ConditionExpression: "attribute_not_exists(pk)" },
    },
    auditPut(db.tableName, input.seasonId, input.actorUserId, "ruleset.create", { version }, now),
  ];
  await write(db, items, ["season", "ruleset", "audit"]);
  return toStored(item);
}

/** Replaces an UNLOCKED version's rules/note. A locked version can only be superseded by a new one (I-6). */
export async function updateRuleset(
  db: Dynamo,
  input: Actor & { version: number; rules: unknown; note?: string },
): Promise<StoredRuleset> {
  const { json } = validated(input.rules, input.version);
  const now = input.now ?? new Date().toISOString();
  const noteSet = input.note !== undefined;
  await write(
    db,
    [
      {
        Update: {
          TableName: db.tableName,
          Key: rulesetKey(input.seasonId, input.version),
          UpdateExpression: `SET #rules = :rules, updatedAt = :now${noteSet ? ", note = :note" : ""}`,
          ConditionExpression: "attribute_exists(pk) AND locked = :false",
          ExpressionAttributeNames: { "#rules": "rules" },
          ExpressionAttributeValues: {
            ":rules": json,
            ":now": now,
            ":false": false,
            ...(noteSet ? { ":note": input.note } : {}),
          },
        },
      },
      auditPut(
        db.tableName,
        input.seasonId,
        input.actorUserId,
        "ruleset.update",
        { version: input.version },
        now,
      ),
    ],
    ["ruleset", "audit"],
    input.version,
  );
  return (await getRuleset(db, input.seasonId, input.version))!;
}

/** Locks a version (I-6): conditional on `locked = false`, so a second lock is a `conflict`. */
export async function lockRuleset(
  db: Dynamo,
  input: Actor & { version: number },
): Promise<StoredRuleset> {
  const now = input.now ?? new Date().toISOString();
  await write(
    db,
    [
      {
        Update: {
          TableName: db.tableName,
          Key: rulesetKey(input.seasonId, input.version),
          UpdateExpression: "SET locked = :true, lockedAt = :now, lockedBy = :by",
          ConditionExpression: "attribute_exists(pk) AND locked = :false",
          ExpressionAttributeValues: {
            ":true": true,
            ":false": false,
            ":now": now,
            ":by": input.actorUserId,
          },
        },
      },
      auditPut(
        db.tableName,
        input.seasonId,
        input.actorUserId,
        "ruleset.lock",
        { version: input.version },
        now,
      ),
    ],
    ["ruleset", "audit"],
    input.version,
  );
  return (await getRuleset(db, input.seasonId, input.version))!;
}

/** Points `META.activeRulesetVersion` at an existing version (any lock state). */
export async function setActiveRuleset(
  db: Dynamo,
  input: Actor & { version: number },
): Promise<void> {
  const now = input.now ?? new Date().toISOString();
  await write(
    db,
    [
      {
        ConditionCheck: {
          TableName: db.tableName,
          Key: rulesetKey(input.seasonId, input.version),
          ConditionExpression: "attribute_exists(pk)",
        },
      },
      {
        Update: {
          TableName: db.tableName,
          Key: seasonMetaKey(input.seasonId),
          UpdateExpression: "SET activeRulesetVersion = :v",
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeValues: { ":v": input.version },
        },
      },
      auditPut(
        db.tableName,
        input.seasonId,
        input.actorUserId,
        "ruleset.activate",
        { version: input.version },
        now,
      ),
    ],
    ["ruleset", "season", "audit"],
    input.version,
  );
}

async function write(
  db: Dynamo,
  items: TransactItems,
  labels: string[],
  version?: number,
): Promise<void> {
  try {
    await transactWrite(db.doc, items, labels);
  } catch (err) {
    if (!(err instanceof TransactionConflictError)) throw err;
    if (err.has("season")) throw new DomainError("not_found", "Season not found");
    if (err.has("ruleset")) {
      const missing =
        err.reasons.find((r) => r.label === "ruleset")?.item === undefined && version !== undefined;
      if (missing) throw new DomainError("not_found", `Ruleset v${version} not found`);
      throw new DomainError(
        "conflict",
        version === undefined
          ? "Another ruleset version was created at the same time; try again"
          : `Ruleset v${version} is locked; create a new version instead`,
      );
    }
    throw err;
  }
}

/**
 * Seeds a shipped ruleset (`packages/domain/rulesets`) as version 1 of a season, unlocked.
 * Idempotent: does nothing when v1 already exists (it never overwrites or re-versions).
 */
export async function seedBuiltinRuleset(
  db: Dynamo,
  input: { seasonId: string; name: BuiltinRulesetName },
): Promise<{ created: boolean }> {
  if (await getRuleset(db, input.seasonId, 1)) return { created: false };
  try {
    await createRulesetVersion(db, {
      seasonId: input.seasonId,
      actorUserId: null,
      rules: BUILTIN_RULESETS[input.name],
      note: `Seeded from ${input.name}.v1.json`,
    });
  } catch (err) {
    if (err instanceof DomainError && err.code === "conflict") return { created: false };
    throw err;
  }
  return { created: true };
}
