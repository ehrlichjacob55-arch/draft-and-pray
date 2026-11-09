/**
 * "Test League" (docs/design/11 §3.4, 13 §7): bootstrap, seed through the real API (the commissioner
 * adds managers; existing test users are auto-claimed on their next /me), and reset by
 * Query + BatchWrite (never Scan). Only ever deletes a league whose members are all test users.
 */
import type { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  bootstrapLeague,
  getUserByEmail,
  getUsers,
  leagueKey,
  leaguePk,
  listMemberships,
  listManagerRecords,
  listSeasonPointers,
  queryPrefix,
  seasonPk,
  userKey,
  type Dynamo,
} from "@dnp/db";
import type { ApiClient } from "./api";
import {
  TEST_LEAGUE_NAME,
  TEST_YEAR,
  isNewTestUserEmail,
  isTestUserEmail,
  testUserEmail,
  type EnvConfig,
} from "./env";
import { deleteNewTestCognitoUsers, subFor, type TestUser } from "./runtime";

type Key = { pk: string; sk: string };

async function batchDelete(db: Dynamo, keys: Key[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 25) {
    let pending: Key[] = keys.slice(i, i + 25);
    for (let attempt = 0; pending.length > 0; attempt++) {
      if (attempt > 8) throw new Error("BatchWrite kept returning unprocessed items");
      const res = await db.doc.send(
        new BatchWriteCommand({
          RequestItems: {
            [db.tableName]: pending.map((Key) => ({ DeleteRequest: { Key } })),
          },
        }),
      );
      pending = (res.UnprocessedItems?.[db.tableName] ?? []).map(
        (r) => r.DeleteRequest!.Key as Key,
      );
      if (pending.length) await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
    }
  }
}

const keyOf = (item: Record<string, unknown>): Key => ({
  pk: item.pk as string,
  sk: item.sk as string,
});

export interface ResetResult {
  leaguesDeleted: number;
  itemsDeleted: number;
  /** `dnp-new-*` Cognito users deleted (AWS envs only). */
  cognitoUsersDeleted: number;
}

export interface ResetOptions {
  userCount?: number;
  /** AWS envs: also delete the `dnp-new-*` Cognito users created by the smoke test. */
  cognito?: { client: CognitoIdentityProviderClient; userPoolId: string };
}

/**
 * Deletes every Test League (league, seasons incl. PRIVATE manager items), the test users'
 * profiles, the profiles of `dnp-new-*` managers, and those users' Cognito accounts.
 */
export async function resetTestLeague(db: Dynamo, opts: ResetOptions = {}): Promise<ResetResult> {
  const userCount = opts.userCount ?? 9;
  const emails = Array.from({ length: userCount }, (_, i) => testUserEmail(i + 1));
  const leagueIds = new Set<string>();
  const newEmails = new Set<string>();

  const cognitoDeleted = opts.cognito
    ? await deleteNewTestCognitoUsers(opts.cognito.client, opts.cognito.userPoolId)
    : [];
  for (const e of cognitoDeleted) newEmails.add(e);

  const baseProfiles = (await Promise.all(emails.map((e) => getUserByEmail(db, e)))).filter(
    (u) => u !== undefined,
  );
  for (const u of baseProfiles)
    for (const m of await listMemberships(db, u.userId)) leagueIds.add(m.leagueId);

  const keys: Key[] = [];
  let leaguesDeleted = 0;
  for (const leagueId of leagueIds) {
    const leagueItems = await queryPrefix(db, leaguePk(leagueId), undefined, {
      consistentRead: true,
    });
    const meta = leagueItems.find((i) => i.sk === leagueKey(leagueId).sk);
    if (meta?.name !== TEST_LEAGUE_NAME) continue;
    const memberIds = leagueItems
      .filter((i) => typeof i.sk === "string" && i.sk.startsWith("MEMBER#"))
      .map((i) => i.userId as string);
    const members = await getUsers(db, memberIds);
    if (memberIds.some((id) => !isTestUserEmail(members.get(id)?.email ?? ""))) {
      console.warn(`Skipping league ${leagueId}: it has non-test members`);
      continue;
    }
    keys.push(...leagueItems.map(keyOf));
    for (const p of await listSeasonPointers(db, leagueId)) {
      const seasonItems = await queryPrefix(db, seasonPk(p.seasonId), undefined, {
        consistentRead: true,
      });
      keys.push(...seasonItems.map(keyOf));
      for (const m of await listManagerRecords(db, p.seasonId))
        if (isNewTestUserEmail(m.email)) newEmails.add(m.email);
    }
    leaguesDeleted++;
  }
  const newProfiles = (await Promise.all([...newEmails].map((e) => getUserByEmail(db, e)))).filter(
    (u) => u !== undefined,
  );
  for (const u of [...baseProfiles, ...newProfiles]) keys.push(userKey(u.userId));
  await batchDelete(db, keys);
  return { leaguesDeleted, itemsDeleted: keys.length, cognitoUsersDeleted: cognitoDeleted.length };
}

/** Creates the Test League with test user 01 as commissioner (idempotent). */
export async function bootstrapTestLeague(cfg: EnvConfig, db: Dynamo) {
  const email = testUserEmail(1);
  return bootstrapLeague(db, {
    userId: await subFor(cfg, email),
    email,
    leagueName: TEST_LEAGUE_NAME,
    year: TEST_YEAR,
  });
}

/** Obviously fake person for a test user: "Test Manager02" -> default team "Team Manager02". */
export const testPerson = (email: string) => ({
  firstName: "Test",
  lastName: `Manager${email.slice(9, 11)}`,
});

/**
 * Bootstraps the league, then the commissioner (test user 01) adds every test user as a manager
 * through the real API and each user's next `/me` auto-claims their team (docs/design/13 §1).
 * Users already added are skipped; leftover not-yet-joined `dnp-new-*` managers are removed so
 * they cannot block the 9-team limit.
 */
export async function seedTestLeague(
  cfg: EnvConfig,
  db: Dynamo,
  api: ApiClient,
  users: TestUser[],
  cognito?: ResetOptions["cognito"],
): Promise<{ seasonId: string; added: number; alreadyAdded: number; claimed: number }> {
  let { seasonId } = await bootstrapTestLeague(cfg, db);
  const commissioner = testUserEmail(1);
  const listManagers = async () => {
    const list = await api.request("GET", `/seasons/${seasonId}/managers`, { as: commissioner });
    if (list.status !== 200)
      throw new Error(`list managers failed: ${list.status} ${list.json?.error?.code}`);
    return list.json as { teamId: string; email: string; status: string }[];
  };
  let existing = await listManagers();
  // A joined smoke-test manager cannot be removed and would block the 9-team limit: start over.
  if (existing.some((m) => isNewTestUserEmail(m.email) && m.status === "joined")) {
    await resetTestLeague(db, { cognito });
    ({ seasonId } = await bootstrapTestLeague(cfg, db));
    existing = await listManagers();
  }
  for (const m of existing)
    if (isNewTestUserEmail(m.email))
      await api.request("DELETE", `/seasons/${seasonId}/managers/${m.teamId}`, {
        as: commissioner,
      });
  const have = new Set(existing.map((m) => m.email));

  let added = 0;
  let alreadyAdded = 0;
  for (const { email } of users) {
    if (have.has(email)) {
      alreadyAdded++;
      continue;
    }
    const r = await api.request("POST", `/seasons/${seasonId}/managers`, {
      as: commissioner,
      body: { ...testPerson(email), email },
    });
    if (r.status !== 201)
      throw new Error(`add manager ${email} failed: ${r.status} ${r.json?.error?.code}`);
    added++;
  }
  // Every user signs in once (any /me call), which auto-claims their team.
  let claimed = 0;
  for (const { email } of users) {
    const me = await api.request("GET", "/me", { as: email });
    if (me.status !== 200) throw new Error(`/me ${email} failed: ${me.status}`);
    claimed += (me.json.justClaimed as unknown[]).length;
  }
  return { seasonId, added, alreadyAdded, claimed };
}
