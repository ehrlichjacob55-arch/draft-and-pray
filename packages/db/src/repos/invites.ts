/** Invites: docs/design/11 §2/§4 (A12 listing, bind, revoke) and 10 §4.5 (accept transaction). */
import { randomBytes } from "node:crypto";
import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { INVITE_TTL_DAYS, MAX_TEAMS, teamNameKey, type InviteStatus } from "@dnp/contract";
import type { Dynamo } from "../client";
import {
  DomainError,
  TransactionConflictError,
  transactWrite,
  type TransactItems,
} from "../errors";
import { newId } from "../ids";
import {
  parseItem,
  type InviteItem,
  type LeagueMemberItem,
  type TeamItem,
  type TeamOwnerItem,
  type UserItem,
} from "../items";
import {
  auditKey,
  gsiSeasonInvitesPk,
  inviteKey,
  inviteKeys,
  leagueMemberKey,
  teamKey,
  teamOwnerKey,
  userKeys,
} from "../keys";
import { GSI1 } from "../table";
import { getMember, getSeasonMeta, getUser } from "./leagues";
import { listTeams } from "./teams";

export const newInviteToken = (): string => randomBytes(32).toString("base64url");

const epochSeconds = (d: Date) => Math.floor(d.getTime() / 1000);

/** revoked > used > expired > pending (email bound) > open. */
export function inviteStatus(invite: InviteItem, now: Date = new Date()): InviteStatus {
  if (invite.revokedAt) return "revoked";
  if (invite.usedBy) return "used";
  if (invite.expiresAt <= epochSeconds(now)) return "expired";
  if (invite.pendingEmail) return "pending";
  return "open";
}

/** Throws the DomainError matching a non-usable invite status. */
export function assertInviteUsable(invite: InviteItem | undefined, now: Date): InviteItem {
  if (!invite) throw new DomainError("invite_not_found", "Invite not found");
  const status = inviteStatus(invite, now);
  if (status === "revoked") throw new DomainError("invite_revoked", "This invite was revoked");
  if (status === "used") throw new DomainError("invite_used", "This invite was already used");
  if (status === "expired") throw new DomainError("invite_expired", "This invite has expired");
  return invite;
}

export async function getInvite(
  db: Dynamo,
  token: string,
  opts: { consistentRead?: boolean } = {},
): Promise<InviteItem | undefined> {
  const r = await db.doc.send(
    new GetCommand({
      TableName: db.tableName,
      Key: inviteKey(token),
      ConsistentRead: opts.consistentRead ?? true,
    }),
  );
  if (!r.Item) return undefined;
  const item = parseItem(r.Item);
  return item.type === "Invite" ? item : undefined;
}

/** A12: invites of a season, oldest first. */
export async function listSeasonInvites(db: Dynamo, seasonId: string): Promise<InviteItem[]> {
  const out: InviteItem[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await db.doc.send(
      new QueryCommand({
        TableName: db.tableName,
        IndexName: GSI1,
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": gsiSeasonInvitesPk(seasonId) },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const raw of res.Items ?? []) {
      const it = parseItem(raw);
      if (it.type === "Invite") out.push(it);
    }
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return out;
}

export interface CreateInvitesInput {
  seasonId: string;
  leagueId: string;
  count: number;
  createdBy: string;
  now?: Date;
}

/**
 * Creates `count` invites. Rejects with season_not_setup / season_full when the season is not in
 * `setup` or teams + open/pending invites + count > MAX_TEAMS. The limit check is read-then-write
 * (acceptable at this scale; the commissioner is the only caller).
 */
export async function createInvites(db: Dynamo, input: CreateInvitesInput): Promise<InviteItem[]> {
  const now = input.now ?? new Date();
  const TableName = db.tableName;
  const meta = await getSeasonMeta(db, input.seasonId);
  if (!meta || meta.leagueId !== input.leagueId)
    throw new DomainError("not_found", "Season not found");
  if (meta.status !== "setup")
    throw new DomainError(
      "season_not_setup",
      "Invites can only be created while the season is in setup",
    );
  const [teams, invites] = await Promise.all([
    listTeams(db, input.seasonId),
    listSeasonInvites(db, input.seasonId),
  ]);
  const live = invites.filter((i) => {
    const s = inviteStatus(i, now);
    return s === "open" || s === "pending";
  }).length;
  if (teams.length + live + input.count > MAX_TEAMS)
    throw new DomainError(
      "season_full",
      `A season has at most ${MAX_TEAMS} teams (${teams.length} teams, ${live} open invites)`,
    );

  const createdAt = now.toISOString();
  const expiresAt = epochSeconds(now) + INVITE_TTL_DAYS * 24 * 3600;
  const created: InviteItem[] = Array.from({ length: input.count }, () => {
    const token = newInviteToken();
    return {
      ...inviteKeys(token, input.seasonId, createdAt),
      type: "Invite" as const,
      token,
      leagueId: input.leagueId,
      seasonId: input.seasonId,
      createdBy: input.createdBy,
      createdAt,
      expiresAt,
    };
  });
  const auditId = newId();
  const items: TransactItems = [
    ...created.map((Item) => ({
      Put: { TableName, Item, ConditionExpression: "attribute_not_exists(pk)" },
    })),
    {
      Put: {
        TableName,
        Item: {
          ...auditKey(input.seasonId, auditId),
          type: "Audit",
          auditId,
          actorUserId: input.createdBy,
          action: "invite.create",
          details: { count: input.count },
          at: createdAt,
        },
      },
    },
  ];
  await transactWrite(db.doc, items, [...created.map(() => "invite"), "audit"]);
  return created;
}

const UNUSABLE = "attribute_not_exists(usedBy) AND attribute_not_exists(revokedAt)";

/**
 * Binds `pendingEmail` (already normalized). Succeeds when unset or equal; otherwise throws
 * invite_bound. Throws invite_not_found / used / revoked / expired for unusable invites.
 */
export async function bindPendingEmail(
  db: Dynamo,
  token: string,
  email: string,
  now: Date = new Date(),
): Promise<InviteItem> {
  try {
    const res = await db.doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: inviteKey(token),
        UpdateExpression: "SET pendingEmail = :e",
        ConditionExpression: `attribute_exists(pk) AND ${UNUSABLE} AND expiresAt > :now AND (attribute_not_exists(pendingEmail) OR pendingEmail = :e)`,
        ExpressionAttributeValues: { ":e": email, ":now": epochSeconds(now) },
        ReturnValues: "ALL_NEW",
      }),
    );
    return parseItem(res.Attributes) as InviteItem;
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
    const invite = assertInviteUsable(await getInvite(db, token), now);
    if (invite.pendingEmail && invite.pendingEmail !== email)
      throw new DomainError("invite_bound", "This invite is already reserved for another email");
    throw err;
  }
}

export interface RevokeInviteInput {
  seasonId: string;
  token: string;
  actorUserId: string;
  now?: Date;
}

/** Revokes an unused invite and writes an audit item (condition attribute_not_exists(usedBy)). */
export async function revokeInvite(db: Dynamo, input: RevokeInviteInput): Promise<void> {
  const now = input.now ?? new Date();
  const TableName = db.tableName;
  const existing = await getInvite(db, input.token);
  if (!existing || existing.seasonId !== input.seasonId)
    throw new DomainError("invite_not_found", "Invite not found");
  const auditId = newId();
  try {
    await transactWrite(
      db.doc,
      [
        {
          Update: {
            TableName,
            Key: inviteKey(input.token),
            UpdateExpression: "SET revokedAt = :at",
            ConditionExpression: `attribute_exists(pk) AND ${UNUSABLE}`,
            ExpressionAttributeValues: { ":at": now.toISOString() },
          },
        },
        {
          Put: {
            TableName,
            Item: {
              ...auditKey(input.seasonId, auditId),
              type: "Audit",
              auditId,
              actorUserId: input.actorUserId,
              action: "invite.revoke",
              details: { tokenPrefix: input.token.slice(0, 6) },
              at: now.toISOString(),
            },
          },
        },
      ],
      ["invite", "audit"],
    );
  } catch (err) {
    if (err instanceof TransactionConflictError && err.has("invite")) {
      const cur = await getInvite(db, input.token);
      if (cur?.revokedAt) throw new DomainError("invite_revoked", "Invite already revoked");
      if (cur?.usedBy) throw new DomainError("invite_used", "Invite already used");
      throw new DomainError("invite_not_found", "Invite not found");
    }
    throw err;
  }
}

export interface AcceptInviteInput {
  token: string;
  userId: string;
  /** Normalized email of the signed-in user. */
  email: string;
  /** Already trimmed and validated. */
  teamName: string;
  now?: Date;
}
export interface AcceptInviteResult {
  leagueId: string;
  seasonId: string;
  teamId: string;
}

/**
 * docs/design/11 §4 accept transaction. USER and MEMBER are put only when missing (read first;
 * attribute_not_exists guards the race, in which case the whole accept is retried once).
 * Throws DomainError: invite_not_found | invite_used | invite_revoked | invite_expired |
 * email_mismatch | already_has_team | team_name_taken | season_not_setup.
 */
export async function acceptInvite(
  db: Dynamo,
  input: AcceptInviteInput,
): Promise<AcceptInviteResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await acceptOnce(db, input);
    } catch (err) {
      if (attempt === 0 && err instanceof RetryAccept) continue;
      if (err instanceof RetryAccept) throw new DomainError("conflict", "Please try again");
      throw err;
    }
  }
}

class RetryAccept extends Error {}

async function acceptOnce(db: Dynamo, input: AcceptInviteInput): Promise<AcceptInviteResult> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const TableName = db.tableName;
  const invite = assertInviteUsable(await getInvite(db, input.token), now);
  if (invite.pendingEmail !== input.email)
    throw new DomainError("email_mismatch", "This invite was issued for a different email");
  const meta = await getSeasonMeta(db, invite.seasonId);
  if (!meta) throw new DomainError("not_found", "Season not found");
  if (meta.status !== "setup")
    throw new DomainError("season_not_setup", "This season is no longer accepting teams");

  const teams = await listTeams(db, invite.seasonId);
  if (teams.some((t) => teamNameKey(t.name) === teamNameKey(input.teamName)))
    throw new DomainError("team_name_taken", "Another team already uses that name");
  if (teams.length >= MAX_TEAMS) throw new DomainError("season_full", "The season is full");

  const [existingUser, existingMember] = await Promise.all([
    getUser(db, input.userId),
    getMember(db, invite.leagueId, input.userId),
  ]);

  const teamId = newId();
  const team: TeamItem = {
    ...teamKey(invite.seasonId, teamId),
    type: "Team",
    teamId,
    name: input.teamName,
    managerUserId: input.userId,
    draftPosition: null,
  };
  const owner: TeamOwnerItem = {
    ...teamOwnerKey(invite.seasonId, input.userId),
    type: "TeamOwner",
    userId: input.userId,
    teamId,
  };
  const auditId = newId();
  const items: TransactItems = [
    {
      Update: {
        TableName,
        Key: inviteKey(input.token),
        UpdateExpression: "SET usedBy = :u, usedAt = :at, teamId = :t",
        ConditionExpression: `attribute_exists(pk) AND ${UNUSABLE} AND expiresAt > :nowSec AND pendingEmail = :email`,
        ExpressionAttributeValues: {
          ":u": input.userId,
          ":at": nowIso,
          ":t": teamId,
          ":nowSec": epochSeconds(now),
          ":email": input.email,
        },
      },
    },
  ];
  const labels = ["invite"];
  if (!existingUser) {
    const user: UserItem = {
      ...userKeys(input.userId, input.email),
      type: "User",
      userId: input.userId,
      email: input.email,
      displayName: input.email.split("@")[0] ?? input.email,
    };
    items.push({ Put: { TableName, Item: user, ConditionExpression: "attribute_not_exists(pk)" } });
    labels.push("user");
  }
  if (!existingMember) {
    const member: LeagueMemberItem = {
      ...leagueMemberKey(invite.leagueId, input.userId),
      type: "LeagueMember",
      leagueId: invite.leagueId,
      userId: input.userId,
      role: "manager",
    };
    items.push({
      Put: { TableName, Item: member, ConditionExpression: "attribute_not_exists(pk)" },
    });
    labels.push("member");
  }
  items.push(
    { Put: { TableName, Item: team, ConditionExpression: "attribute_not_exists(pk)" } },
    { Put: { TableName, Item: owner, ConditionExpression: "attribute_not_exists(pk)" } },
    {
      Put: {
        TableName,
        Item: {
          ...auditKey(invite.seasonId, auditId),
          type: "Audit",
          auditId,
          actorUserId: input.userId,
          action: "invite.accept",
          details: { teamId, tokenPrefix: input.token.slice(0, 6) },
          at: nowIso,
        },
      },
    },
  );
  labels.push("team", "team_owner", "audit");

  try {
    await transactWrite(db.doc, items, labels);
  } catch (err) {
    if (!(err instanceof TransactionConflictError)) throw err;
    if (err.reasons.some((r) => r.code === "TransactionConflict"))
      throw new DomainError("conflict", "Another request is in progress, please retry");
    if (err.has("team_owner"))
      throw new DomainError("already_has_team", "You already have a team in this season");
    if (err.has("invite")) {
      assertInviteUsable(await getInvite(db, input.token), now);
      throw new DomainError("email_mismatch", "This invite was issued for a different email");
    }
    if (err.has("user") || err.has("member")) throw new RetryAccept();
    throw err;
  }
  return { leagueId: invite.leagueId, seasonId: invite.seasonId, teamId };
}
