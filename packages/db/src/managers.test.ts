import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeAll, describe, expect, it } from "vitest";
import type { Dynamo } from "./client";
import { DomainError } from "./errors";
import { managerPrivateKey, seasonMetaKey, teamKey, teamOwnerKey } from "./keys";
import {
  addManager,
  claimPendingAssignments,
  defaultTeamName,
  getManagerRow,
  isDefaultTeamName,
  listManagers,
  listPendingAssignments,
  managerStatus,
  recordManagerInvite,
  removePendingManager,
  updatePendingManager,
} from "./repos/managers";
import { bootstrapLeague, getMember, getUser } from "./repos/leagues";
import { loadSeason, queryPrefix } from "./repos/season";
import { seasonPk } from "./keys";
import { getTeam, listTeams, renameTeam } from "./repos/teams";
import { createTestDynamo } from "./testing";

let db: Dynamo;
beforeAll(async () => {
  db = await createTestDynamo("managers");
});

let n = 0;
async function setup(year = 2026) {
  n++;
  const commish = { userId: `c${n}`, email: `boss${n}@local.test` };
  const r = await bootstrapLeague(db, { ...commish, leagueName: `L${n}`, year });
  return { ...r, commish };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const add = (s: Ctx, lastName: string, email: string, firstName = "Alex") =>
  addManager(db, {
    seasonId: s.seasonId,
    firstName,
    lastName,
    email,
    actorUserId: s.commish.userId,
  });

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
  return "no error";
};

describe("defaultTeamName", () => {
  it("is Team <Last>, uniquified case-insensitively", () => {
    expect(defaultTeamName(" Example ", [])).toBe("Team Example");
    expect(defaultTeamName("Example", ["team example"])).toBe("Team Example 2");
    expect(defaultTeamName("Example", ["Team Example", "Team Example 2"])).toBe("Team Example 3");
    expect(isDefaultTeamName("Team Example 3", "Example")).toBe(true);
    expect(isDefaultTeamName("Gridiron Gang", "Example")).toBe(false);
  });
});

describe("addManager", () => {
  it("creates an unclaimed team and a private item indexed by pending email, with ids-only audit", async () => {
    const s = await setup();
    const now = new Date("2026-01-01T00:00:00Z");
    const { team, manager } = await addManager(db, {
      seasonId: s.seasonId,
      firstName: " Alex ",
      lastName: "Example",
      email: "alex@example.com",
      actorUserId: s.commish.userId,
      now,
    });
    expect(team).toMatchObject({ name: "Team Example", managerUserId: null, draftPosition: null });
    expect(manager).toMatchObject({
      sk: `PRIVATE#MANAGER#${team.teamId}`,
      gsi1pk: "PENDING#alex@example.com",
      gsi1sk: `SEASON#${s.seasonId}`,
      firstName: "Alex",
      lastName: "Example",
      email: "alex@example.com",
      invitedAt: now.toISOString(),
    });
    expect((await listTeams(db, s.seasonId)).map((t) => t.name)).toEqual(["Team Example"]);
    expect((await listPendingAssignments(db, "ALEX@example.com")).map((m) => m.teamId)).toEqual([
      team.teamId,
    ]);
    const snap = await loadSeason(db, s.seasonId, { consistentRead: true });
    const added = snap.audit.find((a) => a.action === "manager_added");
    expect(added?.details).toEqual({ teamId: team.teamId });
    expect(JSON.stringify(snap.audit)).not.toMatch(/alex|example/i);
  });

  it("uniquifies team names for the same last name", async () => {
    const s = await setup();
    await add(s, "Example", "a1@example.com");
    await add(s, "Example", "a2@example.com");
    await add(s, "Example", "a3@example.com");
    expect((await listTeams(db, s.seasonId)).map((t) => t.name).sort()).toEqual([
      "Team Example",
      "Team Example 2",
      "Team Example 3",
    ]);
  });

  it("rejects a duplicate email in the same season, but allows it in another season", async () => {
    const s = await setup();
    await add(s, "One", "dup@example.com");
    expect(await code(add(s, "Two", "DUP@example.com "))).toBe("email_already_added");
    const s2 = await bootstrapLeague(db, {
      ...s.commish,
      leagueName: `L${n}`,
      year: 2027,
    });
    await expect(
      addManager(db, {
        seasonId: s2.seasonId,
        firstName: "A",
        lastName: "One",
        email: "dup@example.com",
        actorUserId: s.commish.userId,
      }),
    ).resolves.toBeDefined();
  });

  it("allows 9 teams and rejects the 10th (season_full)", async () => {
    const s = await setup();
    for (let i = 1; i <= 9; i++) await add(s, `Last${i}`, `m${i}@example.com`);
    expect(await code(add(s, "Ten", "m10@example.com"))).toBe("season_full");
  });

  it("requires the season to be in setup, and to exist", async () => {
    const s = await setup();
    await db.doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: seasonMetaKey(s.seasonId),
        UpdateExpression: "SET #s = :s",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": "drafting" },
      }),
    );
    expect(await code(add(s, "Late", "late@example.com"))).toBe("season_not_setup");
    expect(
      await code(
        addManager(db, {
          seasonId: "nope",
          firstName: "A",
          lastName: "B",
          email: "a@example.com",
          actorUserId: "x",
        }),
      ),
    ).toBe("not_found");
  });
});

describe("PII isolation", () => {
  it("loadSeason never returns PRIVATE items or any email/firstName/lastName key", async () => {
    const s = await setup();
    await add(s, "Example", "pii@example.com", "Alex");
    const snap = await loadSeason(db, s.seasonId, { consistentRead: true });
    expect(snap.teams).toHaveLength(1);
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) {
          keys.add(k);
          walk(x);
        }
    };
    walk(snap);
    for (const k of ["email", "firstName", "lastName", "cognitoUsername"])
      expect(keys.has(k)).toBe(false);
    expect(JSON.stringify(snap)).not.toContain("PRIVATE#");
    // ...but the private item does exist for the commissioner path.
    expect(await queryPrefix(db, seasonPk(s.seasonId), "PRIVATE#")).toHaveLength(1);
  });
});

describe("listManagers / status / recordManagerInvite", () => {
  it("joins team + private, derives status and records invite details", async () => {
    const s = await setup();
    const { team } = await add(s, "Example", "lm@example.com");
    const sent = new Date("2026-01-01T00:00:00Z");
    await recordManagerInvite(db, {
      seasonId: s.seasonId,
      teamId: team.teamId,
      cognitoUsername: "uuid-1",
      lastSentAt: sent,
    });
    const [row] = await listManagers(db, s.seasonId);
    expect(row).toMatchObject({
      team: { name: "Team Example" },
      manager: { cognitoUsername: "uuid-1", lastSentAt: sent.toISOString() },
    });
    expect(managerStatus(row!.manager, new Date("2026-01-05T00:00:00Z"))).toBe("invited");
    expect(managerStatus(row!.manager, new Date("2026-01-09T00:00:00Z"))).toBe("expired");
    expect(managerStatus({ ...row!.manager, claimedAt: "x" }, new Date("2030-01-01"))).toBe(
      "joined",
    );
  });
});

describe("claimPendingAssignments", () => {
  it("claims the team in one transaction: owner, member, user, claimedAt, audit; drops A13 keys", async () => {
    const s = await setup();
    const { team } = await add(s, "Example", "Claim.One@Example.com", "Alex");
    const now = new Date("2026-02-01T00:00:00Z");
    const claimed = await claimPendingAssignments(db, {
      userId: "u-alex",
      email: "claim.one@example.com",
      now,
    });
    expect(claimed).toEqual([
      { seasonId: s.seasonId, teamId: team.teamId, teamName: "Team Example" },
    ]);
    expect((await getTeam(db, s.seasonId, team.teamId))?.managerUserId).toBe("u-alex");
    expect(await getMember(db, s.leagueId, "u-alex")).toMatchObject({ role: "manager" });
    expect(await getUser(db, "u-alex")).toMatchObject({
      displayName: "Alex",
      email: "claim.one@example.com",
    });
    const row = await getManagerRow(db, s.seasonId, team.teamId);
    expect(row?.manager).toMatchObject({ claimedAt: now.toISOString(), claimedByUserId: "u-alex" });
    expect(row?.manager.gsi1pk).toBeUndefined();
    expect(await listPendingAssignments(db, "claim.one@example.com")).toEqual([]);
    const own = await queryPrefix(db, seasonPk(s.seasonId), teamOwnerKey(s.seasonId, "u-alex").sk);
    expect(own).toHaveLength(1);
    const snap = await loadSeason(db, s.seasonId, { consistentRead: true });
    expect(snap.audit.find((a) => a.action === "manager_claimed")?.details).toEqual({
      teamId: team.teamId,
      userId: "u-alex",
    });
  });

  it("is idempotent", async () => {
    const s = await setup();
    await add(s, "Example", "idem@example.com");
    const input = { userId: "u-idem", email: "idem@example.com" };
    expect(await claimPendingAssignments(db, input)).toHaveLength(1);
    expect(await claimPendingAssignments(db, input)).toEqual([]);
  });

  it("claims assignments in two seasons of the same league (one membership)", async () => {
    const s = await setup(2026);
    const s2 = await bootstrapLeague(db, { ...s.commish, leagueName: `L${n}`, year: 2027 });
    expect(s2.leagueId).toBe(s.leagueId);
    await add(s, "Example", "two@example.com");
    await addManager(db, {
      seasonId: s2.seasonId,
      firstName: "Alex",
      lastName: "Example",
      email: "two@example.com",
      actorUserId: s.commish.userId,
    });
    const claimed = await claimPendingAssignments(db, {
      userId: "u-two",
      email: "two@example.com",
    });
    expect(claimed.map((c) => c.seasonId).sort()).toEqual([s.seasonId, s2.seasonId].sort());
    expect(await getMember(db, s.leagueId, "u-two")).toMatchObject({ role: "manager" });
  });

  it("keeps the commissioner role when the commissioner adds themselves", async () => {
    const s = await setup();
    await add(s, "Boss", s.commish.email);
    const claimed = await claimPendingAssignments(db, s.commish);
    expect(claimed).toHaveLength(1);
    expect(await getMember(db, s.leagueId, s.commish.userId)).toMatchObject({
      role: "commissioner",
    });
    expect(await getUser(db, s.commish.userId)).toMatchObject({ displayName: "boss" + n });
  });

  it("only one of two concurrent claims wins; the team has one owner", async () => {
    const s = await setup();
    const { team } = await add(s, "Example", "race@example.com");
    const results = await Promise.all(
      ["u-r1", "u-r2", "u-r3"].map((userId) =>
        claimPendingAssignments(db, { userId, email: "race@example.com" }),
      ),
    );
    expect(results.flat()).toHaveLength(1);
    const owner = (await getTeam(db, s.seasonId, team.teamId))?.managerUserId;
    expect(["u-r1", "u-r2", "u-r3"]).toContain(owner);
  });

  it("does not claim a team removed before the claim", async () => {
    const s = await setup();
    const { team } = await add(s, "Example", "gone@example.com");
    await removePendingManager(db, {
      seasonId: s.seasonId,
      teamId: team.teamId,
      actorUserId: s.commish.userId,
    });
    expect(await claimPendingAssignments(db, { userId: "u-g", email: "gone@example.com" })).toEqual(
      [],
    );
    expect(await getUser(db, "u-g")).toBeUndefined();
  });

  it("skips (without error) when the user already owns another team in the season", async () => {
    const s = await setup();
    await add(s, "One", "own@example.com");
    await claimPendingAssignments(db, { userId: "u-own", email: "own@example.com" });
    // A second pending assignment for a different address that the same user signs in with.
    const second = await add(s, "Two", "other@example.com");
    const r = await claimPendingAssignments(db, { userId: "u-own", email: "other@example.com" });
    expect(r).toEqual([]);
    expect((await getTeam(db, s.seasonId, second.team.teamId))?.managerUserId).toBeNull();
    expect(await listPendingAssignments(db, "other@example.com")).toHaveLength(1);
  });
});

describe("updatePendingManager", () => {
  it("edits names and renames the default team; keeps a custom team name", async () => {
    const s = await setup();
    const { team } = await add(s, "Old", "ed@example.com");
    const r = await updatePendingManager(db, {
      seasonId: s.seasonId,
      teamId: team.teamId,
      lastName: "Newer",
      actorUserId: s.commish.userId,
    });
    expect(r.team.name).toBe("Team Newer");
    expect(r.emailChanged).toBe(false);

    await renameTeam(db, {
      seasonId: s.seasonId,
      teamId: team.teamId,
      name: "Gridiron Gang",
      actorUserId: s.commish.userId,
    });
    const r2 = await updatePendingManager(db, {
      seasonId: s.seasonId,
      teamId: team.teamId,
      lastName: "Third",
      actorUserId: s.commish.userId,
    });
    expect(r2.team.name).toBe("Gridiron Gang");
  });

  it("re-keys the pending email, clears the cognito username, and rejects duplicates", async () => {
    const s = await setup();
    const a = await add(s, "A", "a@example.com");
    await add(s, "B", "b@example.com");
    await recordManagerInvite(db, {
      seasonId: s.seasonId,
      teamId: a.team.teamId,
      cognitoUsername: "uuid-a",
      lastSentAt: new Date(),
    });
    expect(
      await code(
        updatePendingManager(db, {
          seasonId: s.seasonId,
          teamId: a.team.teamId,
          email: "B@example.com",
          actorUserId: "x",
        }),
      ),
    ).toBe("email_already_added");
    const r = await updatePendingManager(db, {
      seasonId: s.seasonId,
      teamId: a.team.teamId,
      email: "new@example.com",
      actorUserId: "x",
    });
    expect(r).toMatchObject({
      emailChanged: true,
      previous: { email: "a@example.com", cognitoUsername: "uuid-a" },
    });
    expect(await listPendingAssignments(db, "a@example.com")).toEqual([]);
    expect(await listPendingAssignments(db, "new@example.com")).toHaveLength(1);
    const row = await getManagerRow(db, s.seasonId, a.team.teamId);
    expect(row?.manager.cognitoUsername).toBeUndefined();
    expect(row?.manager.lastSentAt).toBeUndefined();
  });

  it("is refused once joined (manager_joined) and for unknown teams (not_found)", async () => {
    const s = await setup();
    const { team } = await add(s, "J", "j@example.com");
    await claimPendingAssignments(db, { userId: "u-j", email: "j@example.com" });
    const base = { seasonId: s.seasonId, actorUserId: "x" };
    expect(
      await code(updatePendingManager(db, { ...base, teamId: team.teamId, firstName: "Z" })),
    ).toBe("manager_joined");
    expect(await code(removePendingManager(db, { ...base, teamId: team.teamId }))).toBe(
      "manager_joined",
    );
    expect(await code(updatePendingManager(db, { ...base, teamId: "nope", firstName: "Z" }))).toBe(
      "not_found",
    );
  });
});

describe("removePendingManager", () => {
  it("deletes team, private item and A13 entry; returns the record; audits ids only", async () => {
    const s = await setup();
    const { team } = await add(s, "R", "r@example.com");
    await recordManagerInvite(db, {
      seasonId: s.seasonId,
      teamId: team.teamId,
      cognitoUsername: "u1",
    });
    const removed = await removePendingManager(db, {
      seasonId: s.seasonId,
      teamId: team.teamId,
      actorUserId: s.commish.userId,
    });
    expect(removed.cognitoUsername).toBe("u1");
    expect(await listTeams(db, s.seasonId)).toEqual([]);
    expect(
      await queryPrefix(db, seasonPk(s.seasonId), managerPrivateKey(s.seasonId, team.teamId).sk),
    ).toEqual([]);
    expect(await listPendingAssignments(db, "r@example.com")).toEqual([]);
    const snap = await loadSeason(db, s.seasonId, { consistentRead: true });
    expect(snap.audit.find((a) => a.action === "manager_removed")?.details).toEqual({
      teamId: team.teamId,
    });
  });
});

describe("team abbreviations", () => {
  it("addManager sets a unique default; listTeams backfills legacy rows idempotently", async () => {
    const s = await setup();
    const a = await add(s, "Smith", "a@example.com");
    const b = await add(s, "Smithers", "b@example.com");
    expect([a.team.abbr, b.team.abbr]).toEqual(["SMIT", "SMI2"]);
    for (const t of [a.team, b.team])
      await db.doc.send(
        new UpdateCommand({
          TableName: db.tableName,
          Key: teamKey(s.seasonId, t.teamId),
          UpdateExpression: "REMOVE abbr",
        }),
      );
    // Concurrent readers backfill the same deterministic values.
    const [x, y] = await Promise.all([listTeams(db, s.seasonId), listTeams(db, s.seasonId)]);
    const byName = (ts: typeof x) => Object.fromEntries(ts.map((t) => [t.name, t.abbr]));
    expect(byName(x)).toEqual({ "Team Smith": "SMIT", "Team Smithers": "SMI2" });
    expect(byName(y)).toEqual(byName(x));
    expect(byName(await listTeams(db, s.seasonId))).toEqual(byName(x));
  });

  it("a conditional backfill never overwrites an abbreviation written in the meantime", async () => {
    const s = await setup();
    const a = await add(s, "Smith", "a@example.com");
    await db.doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: teamKey(s.seasonId, a.team.teamId),
        UpdateExpression: "REMOVE abbr",
      }),
    );
    const racing = listTeams(db, s.seasonId);
    await renameTeam(db, {
      seasonId: s.seasonId,
      teamId: a.team.teamId,
      name: "Team Smith",
      abbr: "CUST",
      actorUserId: "x",
    });
    await racing;
    const [t] = await listTeams(db, s.seasonId);
    expect(["CUST", "SMIT"]).toContain(t?.abbr);
  });

  it("rename: custom abbreviation kept, default recomputed, taken -> team_abbr_taken", async () => {
    const s = await setup();
    const a = await add(s, "Alpha", "a@example.com");
    const b = await add(s, "Beta", "b@example.com");
    const rename = (teamId: string, name: string, abbr?: string) =>
      renameTeam(db, { seasonId: s.seasonId, teamId, name, abbr, actorUserId: "x" });
    expect((await rename(a.team.teamId, "Red Zone")).abbr).toBe("REDZ");
    expect(await code(rename(b.team.teamId, "Team Beta", "REDZ"))).toBe("team_abbr_taken");
    expect((await rename(b.team.teamId, "Team Beta", "BB")).abbr).toBe("BB");
    expect((await rename(b.team.teamId, "Other Name")).abbr).toBe("BB");
    // Renaming into a name whose default clashes gets a digit.
    expect((await rename(a.team.teamId, "Redzone Rebels")).abbr).toBe("REDZ");
  });
});

describe("renameTeam", () => {
  it("rejects a case-insensitive duplicate and audits ids only when asked", async () => {
    const s = await setup();
    const a = await add(s, "A", "a@example.com");
    await add(s, "B", "b@example.com");
    expect(
      await code(
        renameTeam(db, {
          seasonId: s.seasonId,
          teamId: a.team.teamId,
          name: "TEAM b",
          actorUserId: "x",
        }),
      ),
    ).toBe("team_name_taken");
    await renameTeam(db, {
      seasonId: s.seasonId,
      teamId: a.team.teamId,
      name: "Fresh",
      actorUserId: "x",
      audit: true,
    });
    const snap = await loadSeason(db, s.seasonId, { consistentRead: true });
    expect(snap.audit.find((e) => e.action === "team_renamed")?.details).toEqual({
      teamId: a.team.teamId,
    });
  });
});
