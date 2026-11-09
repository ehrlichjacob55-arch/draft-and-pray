/** Teams: listing, owner lookup and rename (docs/design/11 §4). */
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { teamNameKey } from "@dnp/contract";
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

export async function listTeams(db: Dynamo, seasonId: string): Promise<TeamItem[]> {
  const raw = await queryPrefix(db, seasonPk(seasonId), skPrefix.teams, { consistentRead: true });
  return raw.map((r) => parseItem(r)).filter((i): i is TeamItem => i.type === "Team");
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
  actorUserId: string;
  /** Audit the change (commissioner renames another manager's team). */
  audit?: boolean;
  now?: Date;
}

/** Throws not_found / team_name_taken (case-insensitive, excluding the team itself). */
export async function renameTeam(db: Dynamo, input: RenameTeamInput): Promise<TeamItem> {
  const TableName = db.tableName;
  const teams = await listTeams(db, input.seasonId);
  const team = teams.find((t) => t.teamId === input.teamId);
  if (!team) throw new DomainError("not_found", "Team not found");
  if (
    teams.some((t) => t.teamId !== team.teamId && teamNameKey(t.name) === teamNameKey(input.name))
  )
    throw new DomainError("team_name_taken", "Another team already uses that name");

  const update = {
    Update: {
      TableName,
      Key: teamKey(input.seasonId, input.teamId),
      UpdateExpression: "SET #n = :n",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: { "#n": "name" },
      ExpressionAttributeValues: { ":n": input.name },
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
              action: "team.rename",
              details: { teamId: input.teamId, from: team.name, to: input.name },
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
  return { ...team, name: input.name };
}
