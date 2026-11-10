/**
 * Managers (docs/design/13): a commissioner adds people by name + email; the team exists at once
 * (unclaimed) and is assigned when that email signs in (`claimPendingAssignments`, called by /me).
 *
 * PII rule (13 §6): names and emails live only in the `PRIVATE#MANAGER#…` item and `USER`.
 * Audit details here carry ids only, and no error message contains a name or an email.
 */
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  INVITE_VALID_DAYS,
  MAX_TEAMS,
  normalizeEmail,
  teamNameKey,
  type JustClaimed,
  type ManagerStatus,
} from "@dnp/contract";
import type { Dynamo } from "../client";
import {
  DomainError,
  TransactionConflictError,
  transactWrite,
  type TransactItems,
} from "../errors";
import { newId } from "../ids";
import { parseItem, type ManagerPrivateItem } from "../items";
import { defaultAbbr } from "@dnp/domain";
import {
  auditKey,
  gsiPendingPk,
  leagueMemberKey,
  managerPrivateKey,
  pendingManagerGsi1,
  seasonPk,
  skPrefix,
  teamKey,
  teamOwnerKey,
  userKeys,
} from "../keys";
import { GSI1 } from "../table";
import { getSeasonMeta } from "./leagues";
import { queryPrefix } from "./season";
import { getTeam, listTeams, type Team } from "./teams";

const DAY_MS = 24 * 60 * 60 * 1000;

/** `Team <LastName>`, made unique (case-insensitive) with " 2", " 3"… against `existing`. */
export function defaultTeamName(lastName: string, existing: readonly string[]): string {
  const taken = new Set(existing.map(teamNameKey));
  const base = `Team ${lastName.trim()}`;
  let candidate = base;
  for (let n = 2; taken.has(teamNameKey(candidate)); n++) candidate = `${base} ${n}`;
  return candidate;
}

/** Whether `name` is the generated default for `lastName` (possibly with a numeric suffix). */
export function isDefaultTeamName(name: string, lastName: string): boolean {
  const base = teamNameKey(`Team ${lastName}`);
  const key = teamNameKey(name);
  return (
    key === base || new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\d+$`).test(key)
  );
}

/** joined (claimed) > expired (invitation older than the temporary-password validity) > invited. */
export function managerStatus(m: ManagerPrivateItem, now: Date = new Date()): ManagerStatus {
  if (m.claimedAt) return "joined";
  if (m.lastSentAt && now.getTime() - Date.parse(m.lastSentAt) > INVITE_VALID_DAYS * DAY_MS)
    return "expired";
  return "invited";
}

export async function listManagerRecords(
  db: Dynamo,
  seasonId: string,
): Promise<ManagerPrivateItem[]> {
  const raw = await queryPrefix(db, seasonPk(seasonId), skPrefix.privateManagers, {
    consistentRead: true,
  });
  return raw
    .map((r) => parseItem(r))
    .filter((i): i is ManagerPrivateItem => i.type === "ManagerPrivate");
}

export interface ManagerRow {
  manager: ManagerPrivateItem;
  team: Team;
}

/** Commissioner view: every manager record joined with its team. */
export async function listManagers(db: Dynamo, seasonId: string): Promise<ManagerRow[]> {
  const [managers, teams] = await Promise.all([
    listManagerRecords(db, seasonId),
    listTeams(db, seasonId),
  ]);
  const byId = new Map(teams.map((t) => [t.teamId, t]));
  const rows: ManagerRow[] = [];
  for (const manager of managers) {
    const team = byId.get(manager.teamId);
    if (team) rows.push({ manager, team });
  }
  return rows.sort((a, b) => a.manager.invitedAt.localeCompare(b.manager.invitedAt));
}

export async function getManagerRow(
  db: Dynamo,
  seasonId: string,
  teamId: string,
): Promise<ManagerRow | undefined> {
  return (await listManagers(db, seasonId)).find((r) => r.team.teamId === teamId);
}

const auditPut = (
  TableName: string,
  seasonId: string,
  action: string,
  actorUserId: string | null,
  details: Record<string, unknown>,
  at: string,
) => {
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
        at,
      },
    },
  };
};

export interface AddManagerInput {
  seasonId: string;
  firstName: string;
  lastName: string;
  /** Normalized. */
  email: string;
  actorUserId: string;
  now?: Date;
}

/**
 * Creates the team (`Team <LastName>`, managerUserId null) and the private item in one
 * transaction. 409: season_not_setup, season_full (9 teams; read-then-write, like doc 11's
 * invite limit), email_already_added (same email already in this season).
 */
export async function addManager(db: Dynamo, input: AddManagerInput): Promise<ManagerRow> {
  const TableName = db.tableName;
  const now = (input.now ?? new Date()).toISOString();
  const email = normalizeEmail(input.email);
  const meta = await getSeasonMeta(db, input.seasonId);
  if (!meta) throw new DomainError("not_found", "Season not found");
  if (meta.status !== "setup")
    throw new DomainError("season_not_setup", "Managers can only be added during setup");
  const [teams, managers] = await Promise.all([
    listTeams(db, input.seasonId),
    listManagerRecords(db, input.seasonId),
  ]);
  if (teams.length >= MAX_TEAMS)
    throw new DomainError("season_full", `A season has at most ${MAX_TEAMS} teams`);
  if (managers.some((m) => m.email === email))
    throw new DomainError("email_already_added", "That email was already added to this season");

  const teamId = newId();
  const name = defaultTeamName(
    input.lastName,
    teams.map((t) => t.name),
  );
  const team: Team = {
    ...teamKey(input.seasonId, teamId),
    type: "Team",
    teamId,
    name,
    abbr: defaultAbbr(
      name,
      teams.map((t) => t.abbr),
    ),
    managerUserId: null,
    draftPosition: null,
  };
  const manager: ManagerPrivateItem = {
    ...managerPrivateKey(input.seasonId, teamId),
    ...pendingManagerGsi1(email, input.seasonId),
    type: "ManagerPrivate",
    seasonId: input.seasonId,
    leagueId: meta.leagueId,
    teamId,
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    email,
    invitedAt: now,
  };
  await transactWrite(
    db.doc,
    [
      { Put: { TableName, Item: team, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName, Item: manager, ConditionExpression: "attribute_not_exists(pk)" } },
      auditPut(TableName, input.seasonId, "manager_added", input.actorUserId, { teamId }, now),
    ],
    ["team", "manager", "audit"],
  );
  return { manager, team };
}

/** Records the Cognito username and/or the time an invitation email went out. */
export async function recordManagerInvite(
  db: Dynamo,
  input: {
    seasonId: string;
    teamId: string;
    cognitoUsername?: string;
    lastSentAt?: Date;
  },
): Promise<void> {
  const sets: string[] = [];
  const values: Record<string, unknown> = {};
  if (input.cognitoUsername) {
    sets.push("cognitoUsername = :cu");
    values[":cu"] = input.cognitoUsername;
  }
  if (input.lastSentAt) {
    sets.push("lastSentAt = :ls");
    values[":ls"] = input.lastSentAt.toISOString();
  }
  if (sets.length === 0) return;
  await transactWrite(
    db.doc,
    [
      {
        Update: {
          TableName: db.tableName,
          Key: managerPrivateKey(input.seasonId, input.teamId),
          UpdateExpression: `SET ${sets.join(", ")}`,
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeValues: values,
        },
      },
    ],
    ["manager"],
  ).catch((err) => {
    // The manager was removed in the meantime: nothing to record.
    if (err instanceof TransactionConflictError) return;
    throw err;
  });
}

/** Audit a resend (ids only). */
export async function auditManagerResent(
  db: Dynamo,
  input: { seasonId: string; teamId: string; actorUserId: string; now?: Date },
): Promise<void> {
  await transactWrite(
    db.doc,
    [
      auditPut(
        db.tableName,
        input.seasonId,
        "manager_resent",
        input.actorUserId,
        { teamId: input.teamId },
        (input.now ?? new Date()).toISOString(),
      ),
    ],
    ["audit"],
  );
}

async function requirePending(db: Dynamo, seasonId: string, teamId: string): Promise<ManagerRow> {
  const row = await getManagerRow(db, seasonId, teamId);
  if (!row) throw new DomainError("not_found", "Manager not found");
  if (row.manager.claimedAt)
    throw new DomainError("manager_joined", "This manager has already joined");
  return row;
}

export { requirePending as getPendingManager };

export interface UpdatePendingManagerInput {
  seasonId: string;
  teamId: string;
  firstName?: string;
  lastName?: string;
  /** Normalized. */
  email?: string;
  actorUserId: string;
  now?: Date;
}
export interface UpdatePendingManagerResult extends ManagerRow {
  /** True when the email changed: the old invitation is void and a new one must be sent. */
  emailChanged: boolean;
  previous: { email: string; cognitoUsername?: string };
}

/**
 * Edit name/email while not joined. An email change re-keys the A13 entry and clears the Cognito
 * username/lastSentAt (the caller deletes the old pending user and invites the new address).
 * The team keeps its name unless it is still the generated default for the old last name.
 */
export async function updatePendingManager(
  db: Dynamo,
  input: UpdatePendingManagerInput,
): Promise<UpdatePendingManagerResult> {
  const TableName = db.tableName;
  const now = (input.now ?? new Date()).toISOString();
  const { manager, team } = await requirePending(db, input.seasonId, input.teamId);
  const firstName = input.firstName?.trim() ?? manager.firstName;
  const lastName = input.lastName?.trim() ?? manager.lastName;
  const email = input.email ? normalizeEmail(input.email) : manager.email;
  const emailChanged = email !== manager.email;

  if (emailChanged) {
    const all = await listManagerRecords(db, input.seasonId);
    if (all.some((m) => m.teamId !== manager.teamId && m.email === email))
      throw new DomainError("email_already_added", "That email was already added to this season");
  }

  let teamName = team.name;
  let teamAbbr = team.abbr;
  if (lastName !== manager.lastName && isDefaultTeamName(team.name, manager.lastName)) {
    const others = (await listTeams(db, input.seasonId)).filter((t) => t.teamId !== team.teamId);
    const otherAbbrs = others.map((t) => t.abbr);
    teamName = defaultTeamName(
      lastName,
      others.map((t) => t.name),
    );
    // An auto-default abbreviation follows the name; a custom one stays.
    if (team.abbr === defaultAbbr(team.name, otherAbbrs))
      teamAbbr = defaultAbbr(teamName, otherAbbrs);
  }

  const sets = ["firstName = :f", "lastName = :l", "email = :e"];
  const removes: string[] = [];
  const values: Record<string, unknown> = { ":f": firstName, ":l": lastName, ":e": email };
  if (emailChanged) {
    sets.push("gsi1pk = :g1", "gsi1sk = :g2");
    values[":g1"] = gsiPendingPk(email);
    values[":g2"] = pendingManagerGsi1(email, input.seasonId).gsi1sk;
    removes.push("cognitoUsername", "lastSentAt");
  }
  const items: TransactItems = [
    {
      Update: {
        TableName,
        Key: managerPrivateKey(input.seasonId, input.teamId),
        UpdateExpression: `SET ${sets.join(", ")}${removes.length ? ` REMOVE ${removes.join(", ")}` : ""}`,
        ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(claimedAt)",
        ExpressionAttributeValues: values,
      },
    },
    teamName !== team.name
      ? {
          Update: {
            TableName,
            Key: teamKey(input.seasonId, input.teamId),
            UpdateExpression: "SET #n = :n, abbr = :a",
            ConditionExpression: "attribute_exists(pk) AND managerUserId = :null",
            ExpressionAttributeNames: { "#n": "name" },
            ExpressionAttributeValues: { ":n": teamName, ":a": teamAbbr, ":null": null },
          },
        }
      : {
          ConditionCheck: {
            TableName,
            Key: teamKey(input.seasonId, input.teamId),
            ConditionExpression: "attribute_exists(pk) AND managerUserId = :null",
            ExpressionAttributeValues: { ":null": null },
          },
        },
    auditPut(
      TableName,
      input.seasonId,
      "manager_updated",
      input.actorUserId,
      { teamId: input.teamId },
      now,
    ),
  ];
  try {
    await transactWrite(db.doc, items, ["manager", "team", "audit"]);
  } catch (err) {
    if (err instanceof TransactionConflictError)
      throw new DomainError("manager_joined", "This manager has already joined");
    throw err;
  }
  const updated: ManagerPrivateItem = {
    ...manager,
    firstName,
    lastName,
    email,
    ...(emailChanged ? pendingManagerGsi1(email, input.seasonId) : {}),
  };
  if (emailChanged) {
    delete updated.cognitoUsername;
    delete updated.lastSentAt;
  }
  return {
    manager: updated,
    team: { ...team, name: teamName, abbr: teamAbbr },
    emailChanged,
    previous: { email: manager.email, cognitoUsername: manager.cognitoUsername },
  };
}

/**
 * Removes a not-yet-joined manager: deletes the team and the private item (and with it the A13
 * entry). Returns the removed record so the caller can clean up its Cognito user.
 */
export async function removePendingManager(
  db: Dynamo,
  input: { seasonId: string; teamId: string; actorUserId: string; now?: Date },
): Promise<ManagerPrivateItem> {
  const TableName = db.tableName;
  const now = (input.now ?? new Date()).toISOString();
  const { manager } = await requirePending(db, input.seasonId, input.teamId);
  try {
    await transactWrite(
      db.doc,
      [
        {
          Delete: {
            TableName,
            Key: teamKey(input.seasonId, input.teamId),
            ConditionExpression: "attribute_exists(pk) AND managerUserId = :null",
            ExpressionAttributeValues: { ":null": null },
          },
        },
        {
          Delete: {
            TableName,
            Key: managerPrivateKey(input.seasonId, input.teamId),
            ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(claimedAt)",
          },
        },
        auditPut(
          TableName,
          input.seasonId,
          "manager_removed",
          input.actorUserId,
          { teamId: input.teamId },
          now,
        ),
      ],
      ["team", "manager", "audit"],
    );
  } catch (err) {
    if (err instanceof TransactionConflictError)
      throw new DomainError("manager_joined", "This manager has already joined");
    throw err;
  }
  return manager;
}

/** A13: unclaimed assignments for a (normalized) email, across seasons. */
export async function listPendingAssignments(
  db: Dynamo,
  email: string,
): Promise<ManagerPrivateItem[]> {
  const out: ManagerPrivateItem[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await db.doc.send(
      new QueryCommand({
        TableName: db.tableName,
        IndexName: GSI1,
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": gsiPendingPk(normalizeEmail(email)) },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const raw of res.Items ?? []) {
      const it = parseItem(raw);
      if (it.type === "ManagerPrivate") out.push(it);
    }
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return out;
}

export interface ClaimInput {
  userId: string;
  /** The caller's VERIFIED email (any case; normalized here). */
  email: string;
  now?: Date;
}

/**
 * docs/design/13 §1.4: for every pending assignment of `email`, one transaction sets
 * TEAM.managerUserId, puts TEAMOWNER, creates MEMBER (role manager) and USER if absent (existing
 * ones are left as they are: a commissioner stays commissioner), stamps the private item
 * (claimedAt, drops the A13 keys) and audits. Idempotent and race-safe: every write is
 * conditional, so concurrent claims, a removal in between, or a user who already owns another
 * team in that season just leave that assignment unclaimed. Returns only what THIS call claimed.
 */
export async function claimPendingAssignments(
  db: Dynamo,
  input: ClaimInput,
): Promise<JustClaimed[]> {
  const TableName = db.tableName;
  const email = normalizeEmail(input.email);
  const nowIso = (input.now ?? new Date()).toISOString();
  const claimed: JustClaimed[] = [];
  for (const m of await listPendingAssignments(db, email)) {
    if (m.claimedAt) continue;
    const items: TransactItems = [
      {
        Update: {
          TableName,
          Key: teamKey(m.seasonId, m.teamId),
          UpdateExpression: "SET managerUserId = :u",
          ConditionExpression:
            "attribute_exists(pk) AND (attribute_not_exists(managerUserId) OR managerUserId = :null)",
          ExpressionAttributeValues: { ":u": input.userId, ":null": null },
        },
      },
      {
        Put: {
          TableName,
          Item: {
            ...teamOwnerKey(m.seasonId, input.userId),
            type: "TeamOwner",
            userId: input.userId,
            teamId: m.teamId,
          },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
      {
        Update: {
          TableName,
          Key: (({ pk, sk }) => ({ pk, sk }))(leagueMemberKey(m.leagueId, input.userId)),
          UpdateExpression:
            "SET #t = if_not_exists(#t, :t), leagueId = if_not_exists(leagueId, :l), userId = if_not_exists(userId, :u), #r = if_not_exists(#r, :r), gsi1pk = if_not_exists(gsi1pk, :g1), gsi1sk = if_not_exists(gsi1sk, :g2)",
          ExpressionAttributeNames: { "#t": "type", "#r": "role" },
          ExpressionAttributeValues: {
            ":t": "LeagueMember",
            ":l": m.leagueId,
            ":u": input.userId,
            ":r": "manager",
            ":g1": leagueMemberKey(m.leagueId, input.userId).gsi1pk,
            ":g2": leagueMemberKey(m.leagueId, input.userId).gsi1sk,
          },
        },
      },
      {
        Update: {
          TableName,
          Key: (({ pk, sk }) => ({ pk, sk }))(userKeys(input.userId, email)),
          UpdateExpression:
            "SET #t = if_not_exists(#t, :t), userId = if_not_exists(userId, :u), email = if_not_exists(email, :e), displayName = if_not_exists(displayName, :d), gsi1pk = if_not_exists(gsi1pk, :g1), gsi1sk = if_not_exists(gsi1sk, :g2)",
          ExpressionAttributeNames: { "#t": "type" },
          ExpressionAttributeValues: {
            ":t": "User",
            ":u": input.userId,
            ":e": email,
            ":d": m.firstName,
            ":g1": userKeys(input.userId, email).gsi1pk,
            ":g2": userKeys(input.userId, email).gsi1sk,
          },
        },
      },
      {
        Update: {
          TableName,
          Key: managerPrivateKey(m.seasonId, m.teamId),
          UpdateExpression: "SET claimedAt = :now, claimedByUserId = :u REMOVE gsi1pk, gsi1sk",
          ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(claimedAt)",
          ExpressionAttributeValues: { ":now": nowIso, ":u": input.userId },
        },
      },
      auditPut(
        TableName,
        m.seasonId,
        "manager_claimed",
        input.userId,
        { teamId: m.teamId, userId: input.userId },
        nowIso,
      ),
    ];
    try {
      await transactWrite(db.doc, items, ["team", "owner", "member", "user", "manager", "audit"]);
    } catch (err) {
      if (err instanceof TransactionConflictError) continue;
      throw err;
    }
    const team = await getTeam(db, m.seasonId, m.teamId);
    claimed.push({ seasonId: m.seasonId, teamId: m.teamId, teamName: team?.name ?? "" });
  }
  return claimed;
}
