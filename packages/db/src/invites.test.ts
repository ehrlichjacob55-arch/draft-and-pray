import { beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "./errors";
import type { Dynamo } from "./client";
import {
  acceptInvite,
  bindPendingEmail,
  createInvites,
  getInvite,
  inviteStatus,
  listSeasonInvites,
  revokeInvite,
} from "./repos/invites";
import { bootstrapLeague, getMember, getUser } from "./repos/leagues";
import { loadSeason } from "./repos/season";
import { listTeams, renameTeam } from "./repos/teams";
import { createTestDynamo } from "./testing";
import { beforeAll } from "vitest";
import { seasonMetaKey } from "./keys";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";

let db: Dynamo;
beforeAll(async () => {
  db = await createTestDynamo("invites");
});

let n = 0;
async function setup() {
  n++;
  const commish = { userId: `c${n}`, email: `c${n}@local.test` };
  const r = await bootstrapLeague(db, {
    ...commish,
    leagueName: `L${n}`,
    year: 2026,
  });
  return { ...r, commish };
}
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
  return "no error";
};

/** Create one invite, bind the email, return the token. */
async function boundInvite(s: Awaited<ReturnType<typeof setup>>, email: string) {
  const [inv] = await createInvites(db, {
    seasonId: s.seasonId,
    leagueId: s.leagueId,
    count: 1,
    createdBy: s.commish.userId,
  });
  await bindPendingEmail(db, inv!.token, email);
  return inv!.token;
}

describe("createInvites / listSeasonInvites", () => {
  it("creates tokens of 43 chars with a 14-day TTL, listed via A12 and audited", async () => {
    const s = await setup();
    const now = new Date("2026-01-01T00:00:00Z");
    const created = await createInvites(db, {
      seasonId: s.seasonId,
      leagueId: s.leagueId,
      count: 3,
      createdBy: s.commish.userId,
      now,
    });
    expect(created).toHaveLength(3);
    for (const i of created) {
      expect(i.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(i.expiresAt).toBe(Math.floor(now.getTime() / 1000) + 14 * 86400);
      expect(i.gsi1pk).toBe(`SEASONINV#${s.seasonId}`);
    }
    const listed = await listSeasonInvites(db, s.seasonId);
    expect(listed.map((i) => i.token).sort()).toEqual(created.map((i) => i.token).sort());
    const snap = await loadSeason(db, s.seasonId, { consistentRead: true });
    expect(snap.audit.map((a) => a.action)).toContain("invite.create");
  });

  it("enforces the 9-team limit across teams + open/pending invites", async () => {
    const s = await setup();
    const base = { seasonId: s.seasonId, leagueId: s.leagueId, createdBy: s.commish.userId };
    await createInvites(db, { ...base, count: 5 });
    expect(await code(createInvites(db, { ...base, count: 5 }))).toBe("season_full");
    await createInvites(db, { ...base, count: 4 });
    expect(await code(createInvites(db, { ...base, count: 1 }))).toBe("season_full");
  });

  it("revoked and expired invites do not count toward the limit", async () => {
    const s = await setup();
    const base = { seasonId: s.seasonId, leagueId: s.leagueId, createdBy: s.commish.userId };
    const old = await createInvites(db, { ...base, count: 4, now: new Date("2020-01-01") });
    expect(inviteStatus(old[0]!, new Date())).toBe("expired");
    const fresh = await createInvites(db, { ...base, count: 5 });
    await revokeInvite(db, { seasonId: s.seasonId, token: fresh[0]!.token, actorUserId: "x" });
    await createInvites(db, { ...base, count: 1 });
  });

  it("rejects when the season is not in setup", async () => {
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
    expect(
      await code(
        createInvites(db, {
          seasonId: s.seasonId,
          leagueId: s.leagueId,
          count: 1,
          createdBy: s.commish.userId,
        }),
      ),
    ).toBe("season_not_setup");
  });
});

describe("bindPendingEmail", () => {
  it("binds once, allows the same email again, rejects another", async () => {
    const s = await setup();
    const [inv] = await createInvites(db, {
      seasonId: s.seasonId,
      leagueId: s.leagueId,
      count: 1,
      createdBy: s.commish.userId,
    });
    const t = inv!.token;
    expect((await bindPendingEmail(db, t, "a@x.com")).pendingEmail).toBe("a@x.com");
    expect((await bindPendingEmail(db, t, "a@x.com")).pendingEmail).toBe("a@x.com");
    expect(await code(bindPendingEmail(db, t, "b@x.com"))).toBe("invite_bound");
    expect(inviteStatus((await getInvite(db, t))!)).toBe("pending");
  });

  it("concurrent binds with different emails: exactly one wins", async () => {
    const s = await setup();
    const [inv] = await createInvites(db, {
      seasonId: s.seasonId,
      leagueId: s.leagueId,
      count: 1,
      createdBy: s.commish.userId,
    });
    const results = await Promise.allSettled(
      ["a@x.com", "b@x.com", "c@x.com"].map((e) => bindPendingEmail(db, inv!.token, e)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("rejects unknown, revoked, expired and used invites", async () => {
    const s = await setup();
    expect(await code(bindPendingEmail(db, "nope", "a@x.com"))).toBe("invite_not_found");
    const [rev] = await createInvites(db, {
      seasonId: s.seasonId,
      leagueId: s.leagueId,
      count: 1,
      createdBy: s.commish.userId,
    });
    await revokeInvite(db, { seasonId: s.seasonId, token: rev!.token, actorUserId: "c" });
    expect(await code(bindPendingEmail(db, rev!.token, "a@x.com"))).toBe("invite_revoked");
    const [exp] = await createInvites(db, {
      seasonId: s.seasonId,
      leagueId: s.leagueId,
      count: 1,
      createdBy: s.commish.userId,
      now: new Date("2020-01-01"),
    });
    expect(await code(bindPendingEmail(db, exp!.token, "a@x.com"))).toBe("invite_expired");
    const t = await boundInvite(s, "u@x.com");
    await acceptInvite(db, { token: t, userId: "uu", email: "u@x.com", teamName: "T" });
    expect(await code(bindPendingEmail(db, t, "u@x.com"))).toBe("invite_used");
  });
});

describe("revokeInvite", () => {
  it("revokes an unused invite with an audit item; second revoke and used invites conflict", async () => {
    const s = await setup();
    const [a, b] = await createInvites(db, {
      seasonId: s.seasonId,
      leagueId: s.leagueId,
      count: 2,
      createdBy: s.commish.userId,
    });
    await revokeInvite(db, { seasonId: s.seasonId, token: a!.token, actorUserId: "c" });
    expect(inviteStatus((await getInvite(db, a!.token))!)).toBe("revoked");
    expect(
      await code(revokeInvite(db, { seasonId: s.seasonId, token: a!.token, actorUserId: "c" })),
    ).toBe("invite_revoked");
    await bindPendingEmail(db, b!.token, "b@x.com");
    await acceptInvite(db, { token: b!.token, userId: "ub", email: "b@x.com", teamName: "B" });
    expect(
      await code(revokeInvite(db, { seasonId: s.seasonId, token: b!.token, actorUserId: "c" })),
    ).toBe("invite_used");
    expect(
      await code(revokeInvite(db, { seasonId: "other", token: b!.token, actorUserId: "c" })),
    ).toBe("invite_not_found");
    const snap = await loadSeason(db, s.seasonId, { consistentRead: true });
    expect(snap.audit.filter((x) => x.action === "invite.revoke")).toHaveLength(1);
  });
});

describe("acceptInvite", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
  });

  it("happy path: creates user, manager member, team, owner marker and audit", async () => {
    const token = await boundInvite(s, "mgr@x.com");
    const r = await acceptInvite(db, {
      token,
      userId: "m1",
      email: "mgr@x.com",
      teamName: "Gridiron",
    });
    expect(r.seasonId).toBe(s.seasonId);
    expect(await getUser(db, "m1")).toMatchObject({ displayName: "mgr", email: "mgr@x.com" });
    expect(await getMember(db, s.leagueId, "m1")).toMatchObject({ role: "manager" });
    const snap = await loadSeason(db, s.seasonId, { consistentRead: true });
    expect(snap.teams).toMatchObject([{ teamId: r.teamId, name: "Gridiron", managerUserId: "m1" }]);
    expect(snap.teamOwners).toMatchObject([{ userId: "m1", teamId: r.teamId }]);
    expect(snap.audit.map((a) => a.action)).toContain("invite.accept");
    const inv = (await getInvite(db, token))!;
    expect(inv).toMatchObject({ usedBy: "m1", teamId: r.teamId });
    expect(inviteStatus(inv)).toBe("used");
  });

  it("the commissioner keeps their role and USER profile when joining", async () => {
    const token = await boundInvite(s, s.commish.email);
    await acceptInvite(db, {
      token,
      userId: s.commish.userId,
      email: s.commish.email,
      teamName: "Boss FC",
    });
    expect(await getMember(db, s.leagueId, s.commish.userId)).toMatchObject({
      role: "commissioner",
    });
    expect(await listTeams(db, s.seasonId)).toHaveLength(1);
  });

  it("wrong email, unbound invite and unknown token", async () => {
    const token = await boundInvite(s, "mgr@x.com");
    expect(
      await code(acceptInvite(db, { token, userId: "z", email: "other@x.com", teamName: "T" })),
    ).toBe("email_mismatch");
    const [open] = await createInvites(db, {
      seasonId: s.seasonId,
      leagueId: s.leagueId,
      count: 1,
      createdBy: s.commish.userId,
    });
    expect(
      await code(
        acceptInvite(db, { token: open!.token, userId: "z", email: "z@x.com", teamName: "T" }),
      ),
    ).toBe("email_mismatch");
    expect(
      await code(acceptInvite(db, { token: "nope", userId: "z", email: "z@x.com", teamName: "T" })),
    ).toBe("invite_not_found");
  });

  it("used, revoked and expired invites", async () => {
    const t1 = await boundInvite(s, "a@x.com");
    await acceptInvite(db, { token: t1, userId: "ua", email: "a@x.com", teamName: "A" });
    expect(
      await code(acceptInvite(db, { token: t1, userId: "ua", email: "a@x.com", teamName: "A2" })),
    ).toBe("invite_used");
    const t2 = await boundInvite(s, "b@x.com");
    await revokeInvite(db, { seasonId: s.seasonId, token: t2, actorUserId: "c" });
    expect(
      await code(acceptInvite(db, { token: t2, userId: "ub", email: "b@x.com", teamName: "B" })),
    ).toBe("invite_revoked");
    const t3 = await boundInvite(s, "c@x.com");
    expect(
      await code(
        acceptInvite(db, {
          token: t3,
          userId: "uc",
          email: "c@x.com",
          teamName: "C",
          now: new Date(Date.now() + 15 * 86400_000),
        }),
      ),
    ).toBe("invite_expired");
  });

  it("already_has_team: second invite for the same user fails and stays unused", async () => {
    const t1 = await boundInvite(s, "a@x.com");
    await acceptInvite(db, { token: t1, userId: "ua", email: "a@x.com", teamName: "A" });
    const t2 = await boundInvite(s, "a@x.com");
    expect(
      await code(acceptInvite(db, { token: t2, userId: "ua", email: "a@x.com", teamName: "A2" })),
    ).toBe("already_has_team");
    expect(inviteStatus((await getInvite(db, t2))!)).toBe("pending");
    expect(await listTeams(db, s.seasonId)).toHaveLength(1);
  });

  it("duplicate team name (case-insensitive)", async () => {
    const t1 = await boundInvite(s, "a@x.com");
    await acceptInvite(db, { token: t1, userId: "ua", email: "a@x.com", teamName: "Dupes" });
    const t2 = await boundInvite(s, "b@x.com");
    expect(
      await code(
        acceptInvite(db, { token: t2, userId: "ub", email: "b@x.com", teamName: " dUPES" }),
      ),
    ).toBe("team_name_taken");
  });

  it("race: two accepts of the same invite: exactly one wins", async () => {
    const token = await boundInvite(s, "a@x.com");
    const results = await Promise.allSettled([
      acceptInvite(db, { token, userId: "ua", email: "a@x.com", teamName: "One" }),
      acceptInvite(db, { token, userId: "ua", email: "a@x.com", teamName: "Two" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await listTeams(db, s.seasonId)).toHaveLength(1);
  });

  it("race: one user accepting two invites concurrently ends with one team", async () => {
    const t1 = await boundInvite(s, "a@x.com");
    const t2 = await boundInvite(s, "a@x.com");
    const results = await Promise.allSettled([
      acceptInvite(db, { token: t1, userId: "ua", email: "a@x.com", teamName: "One" }),
      acceptInvite(db, { token: t2, userId: "ua", email: "a@x.com", teamName: "Two" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await listTeams(db, s.seasonId)).toHaveLength(1);
  });

  it("race: a new user accepting in two leagues concurrently both succeed (USER put-if-absent)", async () => {
    const s2 = await setup();
    const a = await boundInvite(s, "multi@x.com");
    const b = await boundInvite(s2, "multi@x.com");
    const results = await Promise.all([
      acceptInvite(db, { token: a, userId: "um", email: "multi@x.com", teamName: "A" }),
      acceptInvite(db, { token: b, userId: "um", email: "multi@x.com", teamName: "B" }),
    ]);
    expect(results).toHaveLength(2);
    expect(await getMember(db, s2.leagueId, "um")).toBeDefined();
  });

  it("rejects when the season is not in setup", async () => {
    const token = await boundInvite(s, "a@x.com");
    await db.doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: seasonMetaKey(s.seasonId),
        UpdateExpression: "SET #s = :s",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": "drafting" },
      }),
    );
    expect(
      await code(acceptInvite(db, { token, userId: "ua", email: "a@x.com", teamName: "A" })),
    ).toBe("season_not_setup");
  });
});

describe("renameTeam", () => {
  it("renames, enforces unique names case-insensitively, allows a case change of own name, audits", async () => {
    const s = await setup();
    const t1 = await boundInvite(s, "a@x.com");
    const r1 = await acceptInvite(db, {
      token: t1,
      userId: "ua",
      email: "a@x.com",
      teamName: "Alpha",
    });
    const t2 = await boundInvite(s, "b@x.com");
    const r2 = await acceptInvite(db, {
      token: t2,
      userId: "ub",
      email: "b@x.com",
      teamName: "Beta",
    });
    const base = { seasonId: s.seasonId, actorUserId: "ua" };
    expect(await code(renameTeam(db, { ...base, teamId: r1.teamId, name: "BETA" }))).toBe(
      "team_name_taken",
    );
    expect((await renameTeam(db, { ...base, teamId: r1.teamId, name: "ALPHA" })).name).toBe(
      "ALPHA",
    );
    expect(await code(renameTeam(db, { ...base, teamId: "missing", name: "X" }))).toBe("not_found");
    await renameTeam(db, { ...base, teamId: r2.teamId, name: "Gamma", audit: true });
    const snap = await loadSeason(db, s.seasonId, { consistentRead: true });
    expect(snap.teams.find((t) => t.teamId === r2.teamId)?.name).toBe("Gamma");
    expect(snap.audit.filter((a) => a.action === "team.rename")).toHaveLength(1);
  });
});
