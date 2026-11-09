import { beforeAll, describe, expect, it } from "vitest";
import type { Dynamo } from "./client";
import { gsiSeasonInvitesPk, inviteKeys, teamOwnerKey } from "./keys";
import {
  bootstrapLeague,
  getLeague,
  getMember,
  getSeasonMeta,
  getUser,
  getUsers,
  listMemberships,
  listSeasonPointers,
} from "./repos/leagues";
import { loadSeason, queryPrefix } from "./repos/season";
import { seasonPk, leaguePk } from "./keys";
import { createTestDynamo } from "./testing";

let db: Dynamo;
beforeAll(async () => {
  db = await createTestDynamo("leagues");
});

describe("keys", () => {
  it("builds invite gsi1 and team owner keys", () => {
    expect(inviteKeys("tok", "S1", "2026-01-01T00:00:00.000Z")).toEqual({
      pk: "INVITE#tok",
      sk: "META",
      gsi1pk: "SEASONINV#S1",
      gsi1sk: "2026-01-01T00:00:00.000Z",
    });
    expect(gsiSeasonInvitesPk("S1")).toBe("SEASONINV#S1");
    expect(teamOwnerKey("S1", "u1")).toEqual({ pk: "SEASON#S1", sk: "TEAMOWNER#u1" });
  });
});

describe("bootstrapLeague", () => {
  const input = {
    userId: "u-boot",
    email: "boss@local.test",
    leagueName: "Boot League",
    year: 2026,
  };

  it("creates user, league, member, season pointer, meta, draft and audit", async () => {
    const r = await bootstrapLeague(db, input);
    expect(r.created).toBe(true);
    expect(await getUser(db, "u-boot")).toMatchObject({
      email: "boss@local.test",
      displayName: "boss",
    });
    expect(await getLeague(db, r.leagueId)).toMatchObject({ name: "Boot League" });
    expect(await getMember(db, r.leagueId, "u-boot")).toMatchObject({ role: "commissioner" });
    expect((await listMemberships(db, "u-boot")).map((m) => m.leagueId)).toEqual([r.leagueId]);
    expect(await listSeasonPointers(db, r.leagueId)).toMatchObject([
      { year: 2026, seasonId: r.seasonId, status: "setup" },
    ]);
    expect(await getSeasonMeta(db, r.seasonId)).toMatchObject({ status: "setup", year: 2026 });
    const snap = await loadSeason(db, r.seasonId, { consistentRead: true });
    expect(snap.draft).toMatchObject({ status: "scheduled", currentPick: 1 });
    expect(snap.audit).toHaveLength(1);
  });

  it("is idempotent: re-running changes nothing", async () => {
    const a = await bootstrapLeague(db, { ...input, userId: "u-idem", email: "idem@local.test" });
    const before = await queryPrefix(db, leaguePk(a.leagueId));
    const b = await bootstrapLeague(db, { ...input, userId: "u-idem", email: "idem@local.test" });
    expect(b).toMatchObject({ leagueId: a.leagueId, seasonId: a.seasonId, created: false });
    expect(await queryPrefix(db, leaguePk(a.leagueId))).toEqual(before);
    expect((await queryPrefix(db, seasonPk(a.seasonId))).length).toBe(3);
  });

  it("adds a new season year to the existing league", async () => {
    const a = await bootstrapLeague(db, { ...input, userId: "u-yr", email: "yr@local.test" });
    const b = await bootstrapLeague(db, {
      ...input,
      userId: "u-yr",
      email: "yr@local.test",
      year: 2027,
    });
    expect(b.leagueId).toBe(a.leagueId);
    expect(b.seasonId).not.toBe(a.seasonId);
    expect((await listSeasonPointers(db, a.leagueId)).map((p) => p.year)).toEqual([2026, 2027]);
  });

  it("getUsers batch-gets and skips missing users", async () => {
    const m = await getUsers(db, ["u-boot", "u-idem", "nobody", "u-boot"]);
    expect([...m.keys()].sort()).toEqual(["u-boot", "u-idem"]);
  });
});
