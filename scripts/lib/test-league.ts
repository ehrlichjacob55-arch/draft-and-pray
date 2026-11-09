/**
 * "Test League" (docs/design/11 §3.4): bootstrap, seed through the real API, and reset by
 * Query + BatchWrite (never Scan). Only ever deletes a league whose members are all test users.
 */
import { BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  bootstrapLeague,
  getUserByEmail,
  getUsers,
  leagueKey,
  leaguePk,
  listMemberships,
  listSeasonInvites,
  listSeasonPointers,
  queryPrefix,
  seasonPk,
  userKey,
  type Dynamo,
} from "@dnp/db";
import type { ApiClient } from "./api";
import { TEST_LEAGUE_NAME, TEST_YEAR, isTestUserEmail, testUserEmail, type EnvConfig } from "./env";
import { subFor, type TestUser } from "./runtime";

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
}

/** Deletes every Test League (league, seasons, invites) and the test users' profiles. */
export async function resetTestLeague(db: Dynamo, userCount = 9): Promise<ResetResult> {
  const emails = Array.from({ length: userCount }, (_, i) => testUserEmail(i + 1));
  const profiles = (await Promise.all(emails.map((e) => getUserByEmail(db, e)))).filter(
    (u) => u !== undefined,
  );
  const leagueIds = new Set<string>();
  for (const u of profiles)
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
      for (const inv of await listSeasonInvites(db, p.seasonId)) keys.push(keyOf(inv));
    }
    leaguesDeleted++;
  }
  for (const u of profiles) keys.push(userKey(u.userId));
  await batchDelete(db, keys);
  return { leaguesDeleted, itemsDeleted: keys.length };
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

export const testTeamName = (email: string) => `Test Team ${email.slice(9, 11)}`;

/**
 * Bootstraps the league, then has every test user get a team through the real API
 * (commissioner creates an invite; user registers and accepts). Skips users who already have one.
 */
export async function seedTestLeague(
  cfg: EnvConfig,
  db: Dynamo,
  api: ApiClient,
  users: TestUser[],
): Promise<{ seasonId: string; joined: number; alreadyJoined: number }> {
  const { seasonId } = await bootstrapTestLeague(cfg, db);
  const commissioner = testUserEmail(1);
  let joined = 0;
  let alreadyJoined = 0;
  // Leftover open/pending invites (e.g. from a smoke run) count toward the 9-team limit: revoke them.
  const existing = await api.request("GET", `/seasons/${seasonId}/invites`, { as: commissioner });
  if (existing.status === 200) {
    for (const inv of existing.json as { token: string; status: string }[]) {
      if (inv.status === "open" || inv.status === "pending")
        await api.request("DELETE", `/seasons/${seasonId}/invites/${inv.token}`, {
          as: commissioner,
        });
    }
  }
  for (const { email } of users) {
    const season = await api.request("GET", `/seasons/${seasonId}`, { as: email });
    if (season.status === 200 && season.json.myTeamId) {
      alreadyJoined++;
      continue;
    }
    const created = await api.request("POST", `/seasons/${seasonId}/invites`, {
      as: commissioner,
      body: { count: 1 },
    });
    if (created.status !== 201)
      throw new Error(`create invite failed: ${created.status} ${JSON.stringify(created.json)}`);
    const token = created.json[0].token as string;
    const reg = await api.request("POST", `/invites/${token}/register`, { body: { email } });
    if (reg.status !== 200)
      throw new Error(`register ${email} failed: ${reg.status} ${reg.json?.error?.code}`);
    const acc = await api.request("POST", `/invites/${token}/accept`, {
      as: email,
      body: { teamName: testTeamName(email) },
    });
    if (acc.status !== 200)
      throw new Error(`accept ${email} failed: ${acc.status} ${acc.json?.error?.code}`);
    joined++;
  }
  return { seasonId, joined, alreadyJoined };
}
