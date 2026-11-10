/** Teams: listing, owner lookup and rename (docs/design/11 §4). */
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { teamNameKey } from "@dnp/contract";
import { defaultAbbr } from "@dnp/domain";
import type { Dynamo } from "../client";
import {
  DomainError,
  TransactionConflictError,
  transactWrite,
  type TransactItems,
} from "../errors";
import { newId } from "../ids";
import { parseItem, type TeamItem } from "../items";
import { auditKey, seasonPk, skPrefix, teamKey } from "../keys";
import { queryPrefix } from "./season";

/** A team whose abbreviation is guaranteed present (see `listTeams`). */
export type Team = TeamItem & { abbr: string };

/**
 * All teams of a season. Rows created before abbreviations existed get their default abbreviation
 * computed (in teamId order, against the abbreviations already taken) and persisted here, lazily.
 * Each write is conditional on `attribute_not_exists(abbr)`: concurrent readers compute the same
 * deterministic values, a loser of the race simply re-reads, and a custom abbreviation set in the
 * meantime is never overwritten.
 */
export async function listTeams(db: Dynamo, seasonId: string): Promise<Team[]> {
  for (;;) {
    const raw = await queryPrefix(db, seasonPk(seasonId), skPrefix.teams, { consistentRead: true });
    const teams = raw.map((r) => parseItem(r)).filter((i): i is TeamItem => i.type === "Team");
    const taken = new Set(teams.flatMap((t) => (t.abbr === undefined ? [] : [t.abbr])));
    const filled = new Map<string, string>();
    let lost = false;
    for (const t of teams) {
      if (t.abbr !== undefined) continue;
      const abbr = defaultAbbr(t.name, taken);
      taken.add(abbr);
      try {
        await db.doc.send(
          new UpdateCommand({
            TableName: db.tableName,
            Key: teamKey(seasonId, t.teamId),
            UpdateExpression: "SET abbr = :a",
            ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(abbr)",
            ExpressionAttributeValues: { ":a": abbr },
          }),
        );
        filled.set(t.teamId, abbr);
      } catch (err) {
        if ((err as { name?: string }).name !== "ConditionalCheckFailedException") throw err;
        lost = true;
      }
    }
    // Lost a race (another reader backfilled first): re-read the settled state.
    if (!lost)
      return teams.map((t) => ({ ...t, abbr: t.abbr ?? (filled.get(t.teamId) as string) }));
  }
}

export async function getTeam(
  db: Dynamo,
  seasonId: string,
  teamId: string,
): Promise<TeamItem | undefined> {
  const r = await db.doc.send(
    new GetCommand({
      TableName: db.tableName,
      Key: teamKey(seasonId, teamId),
      ConsistentRead: true,
    }),
  );
  if (!r.Item) return undefined;
  const item = parseItem(r.Item);
  return item.type === "Team" ? item : undefined;
}

export interface RenameTeamInput {
  seasonId: string;
  teamId: string;
  /** Already trimmed and validated. */
  name: string;
  /** Already validated and uppercased. Omitted: keep the abbreviation (recomputed only if it is still the default). */
  abbr?: string;
  actorUserId: string;
  /** Audit the change (commissioner renames another manager's team). */
  audit?: boolean;
  now?: Date;
}

/** Throws not_found / team_name_taken (case-insensitive) / team_abbr_taken (both excluding the team itself). */
export async function renameTeam(db: Dynamo, input: RenameTeamInput): Promise<Team> {
  const TableName = db.tableName;
  const teams = await listTeams(db, input.seasonId);
  const team = teams.find((t) => t.teamId === input.teamId);
  if (!team) throw new DomainError("not_found", "Team not found");
  if (
    teams.some((t) => t.teamId !== team.teamId && teamNameKey(t.name) === teamNameKey(input.name))
  )
    throw new DomainError("team_name_taken", "Another team already uses that name");

  const othersAbbrs = teams.filter((t) => t.teamId !== team.teamId).map((t) => t.abbr);
  if (input.abbr !== undefined && othersAbbrs.includes(input.abbr))
    throw new DomainError("team_abbr_taken", "Another team already uses that abbreviation");
  // A custom abbreviation survives a rename; an auto-default follows the name.
  const abbr =
    input.abbr ??
    (team.abbr === defaultAbbr(team.name, othersAbbrs)
      ? defaultAbbr(input.name, othersAbbrs)
      : team.abbr);

  const update = {
    Update: {
      TableName,
      Key: teamKey(input.seasonId, input.teamId),
      UpdateExpression: "SET #n = :n, abbr = :a",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: { "#n": "name" },
      ExpressionAttributeValues: { ":n": input.name, ":a": abbr },
    },
  };
  try {
    if (input.audit) {
      const auditId = newId();
      const items: TransactItems = [
        update,
        {
          Put: {
            TableName,
            Item: {
              ...auditKey(input.seasonId, auditId),
              type: "Audit",
              auditId,
              actorUserId: input.actorUserId,
              action: "team_renamed",
              details: { teamId: input.teamId },
              at: (input.now ?? new Date()).toISOString(),
            },
          },
        },
      ];
      await transactWrite(db.doc, items, ["team", "audit"]);
    } else {
      await transactWrite(db.doc, [update], ["team"]);
    }
  } catch (err) {
    if (err instanceof TransactionConflictError && err.has("team"))
      throw new DomainError("not_found", "Team not found");
    throw err;
  }
  return { ...team, name: input.name, abbr };
}
