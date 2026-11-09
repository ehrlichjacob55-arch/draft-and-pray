import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it } from "vitest";
import type { Dynamo } from "./client";
import { TransactionConflictError } from "./errors";
import { parseItem } from "./items";
import {
  auditKey,
  draftKey,
  pickKey,
  playerKey,
  rosterEntryKey,
  seasonMetaKey,
  skPrefix,
  seasonPk,
} from "./keys";
import {
  putDraftState,
  putPlayer,
  putSeasonMeta,
  putTeam,
  recordPick,
  undoLastPick,
  type RecordPickInput,
} from "./repos/draft";
import { loadSeason, queryPrefix } from "./repos/season";
import { createTestDynamo } from "./testing";

const S = "S1";
const NOW = "2026-01-10T00:00:00.000Z";
let db: Dynamo;
let n = 0;

async function get(key: { pk: string; sk: string }) {
  const r = await db.doc.send(
    new GetCommand({ TableName: db.tableName, Key: key, ConsistentRead: true }),
  );
  return r.Item;
}

async function seed(opts: { currentPick?: number; status?: "in_progress" | "paused" } = {}) {
  n++;
  const seasonId = `${S}-${n}`;
  await putSeasonMeta(db, {
    seasonId,
    leagueId: "L1",
    year: 2026,
    status: "drafting",
    activeRulesetVersion: 1,
  });
  await putDraftState(db, {
    seasonId,
    status: opts.status ?? "in_progress",
    pickSeconds: 90,
    currentPick: opts.currentPick ?? 1,
    currentPickDeadline: NOW,
    startedAt: NOW,
    updatedAt: NOW,
  });
  await putTeam(db, { seasonId, teamId: "T1", name: "One", managerUserId: "u1", draftPosition: 1 });
  for (const id of ["P1", "P2"]) {
    await putPlayer(db, {
      seasonId,
      playerId: id,
      name: id,
      position: "QB",
      nflTeam: "KC",
      providerPlayerId: null,
      injuryStatus: null,
      inPool: true,
    });
  }
  return seasonId;
}

const pickInput = (seasonId: string, over: Partial<RecordPickInput> = {}): RecordPickInput => ({
  seasonId,
  expectedPick: 1,
  teamId: "T1",
  playerId: "P1",
  slot: "QB",
  round: 1,
  madeBy: "manager",
  madeByUserId: "u1",
  nextDeadline: "2026-01-10T00:01:30.000Z",
  isFinalPick: false,
  now: NOW,
  ...over,
});

async function conflictOf(p: Promise<unknown>): Promise<TransactionConflictError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(TransactionConflictError);
    return e as TransactionConflictError;
  }
  throw new Error("expected a TransactionConflictError");
}

beforeEach(async () => {
  db ??= await createTestDynamo("draft");
});

describe("recordPick", () => {
  it("writes pick, roster entry, player ownership, draft advance and audit", async () => {
    const s = await seed();
    const pick = await recordPick(db, pickInput(s));
    expect(pick.overallPick).toBe(1);
    expect(await get(pickKey(s, 1))).toMatchObject({
      type: "Pick",
      playerId: "P1",
      slot: "QB",
      teamId: "T1",
    });
    expect(await get(rosterEntryKey(s, "T1", "QB", 1))).toMatchObject({
      playerId: "P1",
      acquiredVia: "draft",
      fromRound: 1,
    });
    expect(await get(playerKey(s, "P1"))).toMatchObject({
      draftedByTeamId: "T1",
      draftedAtPick: 1,
    });
    expect(await get(draftKey(s))).toMatchObject({
      currentPick: 2,
      status: "in_progress",
      currentPickDeadline: "2026-01-10T00:01:30.000Z",
    });
    const audits = await queryPrefix(db, seasonPk(s), skPrefix.audit, { consistentRead: true });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ type: "Audit", action: "draft.pick" });
    expect(String(audits[0]!.sk).startsWith(auditKey(s, "").sk)).toBe(true);
  });

  it("rejects a stale expectedPick with draft_state", async () => {
    const s = await seed({ currentPick: 5 });
    const err = await conflictOf(recordPick(db, pickInput(s, { expectedPick: 4 })));
    expect(err.has("draft_state")).toBe(true);
    expect(await get(pickKey(s, 4))).toBeUndefined();
  });

  it("rejects a paused draft with draft_state", async () => {
    const s = await seed({ status: "paused" });
    expect((await conflictOf(recordPick(db, pickInput(s)))).has("draft_state")).toBe(true);
  });

  it("rejects an already drafted player with player", async () => {
    const s = await seed();
    await recordPick(db, pickInput(s));
    const err = await conflictOf(recordPick(db, pickInput(s, { expectedPick: 2, slot: "RB1" })));
    expect(err.has("player")).toBe(true);
    expect(err.has("roster_slot")).toBe(false);
  });

  it("rejects an already filled slot with roster_slot", async () => {
    const s = await seed();
    await recordPick(db, pickInput(s));
    const err = await conflictOf(recordPick(db, pickInput(s, { expectedPick: 2, playerId: "P2" })));
    expect(err.has("roster_slot")).toBe(true);
    expect(err.has("player")).toBe(false);
  });

  it("lets exactly one of two concurrent picks for the same expectedPick win", async () => {
    const s = await seed();
    const results = await Promise.allSettled([
      recordPick(db, pickInput(s, { playerId: "P1" })),
      recordPick(db, pickInput(s, { playerId: "P2", slot: "RB1" })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(TransactionConflictError);
    expect(await get(draftKey(s))).toMatchObject({ currentPick: 2 });
  });

  it("completes the draft and the season on pick 90", async () => {
    const s = await seed({ currentPick: 90 });
    await recordPick(
      db,
      pickInput(s, { expectedPick: 90, round: 10, nextDeadline: null, isFinalPick: true }),
    );
    expect(await get(draftKey(s))).toMatchObject({
      status: "complete",
      currentPick: 91,
      currentPickDeadline: null,
    });
    expect(await get(seasonMetaKey(s))).toMatchObject({ status: "in_progress" });
  });
});

describe("undoLastPick", () => {
  it("reverses a pick", async () => {
    const s = await seed();
    await recordPick(db, pickInput(s));
    await undoLastPick(db, {
      seasonId: s,
      currentPick: 2,
      actorUserId: "c1",
      newDeadline: "2026-01-10T00:05:00.000Z",
      now: NOW,
    });
    expect(await get(pickKey(s, 1))).toBeUndefined();
    expect(await get(rosterEntryKey(s, "T1", "QB", 1))).toBeUndefined();
    const player = await get(playerKey(s, "P1"));
    expect(player).toBeDefined();
    expect(player).not.toHaveProperty("draftedByTeamId");
    expect(player).not.toHaveProperty("draftedAtPick");
    expect(await get(draftKey(s))).toMatchObject({
      currentPick: 1,
      status: "in_progress",
      currentPickDeadline: "2026-01-10T00:05:00.000Z",
    });
    const audits = await queryPrefix(db, seasonPk(s), skPrefix.audit, { scanIndexForward: false });
    expect(audits.map((a) => a.action)).toEqual(["draft.undo_pick", "draft.pick"]);
  });

  it("restores in_progress / drafting when undoing the final pick", async () => {
    const s = await seed({ currentPick: 90 });
    await recordPick(
      db,
      pickInput(s, { expectedPick: 90, round: 10, nextDeadline: null, isFinalPick: true }),
    );
    await undoLastPick(db, {
      seasonId: s,
      currentPick: 91,
      actorUserId: "c1",
      newDeadline: NOW,
      now: NOW,
    });
    expect(await get(draftKey(s))).toMatchObject({ status: "in_progress", currentPick: 90 });
    expect(await get(seasonMetaKey(s))).toMatchObject({ status: "drafting" });
  });

  it("fails with pick / draft_state on stale input", async () => {
    const s = await seed();
    await recordPick(db, pickInput(s));
    const err = await conflictOf(
      undoLastPick(db, {
        seasonId: s,
        currentPick: 3,
        actorUserId: "c",
        newDeadline: null,
        now: NOW,
      }),
    );
    expect(err).toBeInstanceOf(TransactionConflictError);
  });
});

describe("loadSeason", () => {
  it("returns typed groups", async () => {
    const s = await seed();
    await recordPick(db, pickInput(s));
    const snap = await loadSeason(db, s, { consistentRead: true });
    expect(snap.meta?.status).toBe("drafting");
    expect(snap.draft?.currentPick).toBe(2);
    expect(snap.teams.map((t) => t.teamId)).toEqual(["T1"]);
    expect(snap.players.map((p) => p.playerId)).toEqual(["P1", "P2"]);
    expect(snap.picks).toHaveLength(1);
    expect(snap.rosterEntries).toHaveLength(1);
    expect(snap.audit).toHaveLength(1);
    expect(snap.games).toEqual([]);
    for (const p of snap.players) expect(parseItem(p).type).toBe("Player");
  });

  it("paginates across multiple pages", async () => {
    const s = await seed();
    for (let i = 3; i <= 30; i++) {
      await putPlayer(db, {
        seasonId: s,
        playerId: `P${i}`,
        name: `P${i}`,
        position: "WR",
        nflTeam: "KC",
        providerPlayerId: null,
        injuryStatus: null,
        inPool: true,
      });
    }
    const snap = await loadSeason(db, s, { pageSize: 5, consistentRead: true });
    expect(snap.players).toHaveLength(30);
    expect(snap.teams).toHaveLength(1);
    const limited = await queryPrefix(db, seasonPk(s), skPrefix.players, {
      pageSize: 4,
      limit: 10,
    });
    expect(limited).toHaveLength(10);
  });
});
