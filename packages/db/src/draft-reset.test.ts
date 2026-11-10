/**
 * End of draft (docs/design/14 §5) and redraft (docs/design/10 §4.8) against DynamoDB Local.
 */
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  TOTAL_PICKS,
  assignSlot,
  roundOf,
  teamOnClock,
  type Position,
  type Slot,
} from "@dnp/domain";
import { beforeEach, describe, expect, it } from "vitest";
import type { Dynamo } from "./client";
import { DomainError, TransactionConflictError } from "./errors";
import {
  draftKey,
  playerKey,
  queueKey,
  seasonMetaKey,
  seasonPointerKey,
  seasonPk,
  skPrefix,
} from "./keys";
import {
  putDraftState,
  putPlayer,
  putSeasonMeta,
  putTeam,
  recordPick,
  undoLastPick,
} from "./repos/draft";
import {
  clearDraftData,
  finalizeDraftReset,
  lockDraftForReset,
  resetDraft,
} from "./repos/draft-reset";
import {
  getDraft,
  pauseDraft,
  putQueue,
  setAutoDraft,
  setDraftOrder,
  startClock,
  startDraft,
} from "./repos/draft-lifecycle";
import { queryPrefix } from "./repos/season";
import { createTestDynamo } from "./testing";

const NOW = "2026-01-10T00:00:00.000Z";
const LATER = "2026-01-11T00:00:00.000Z";
const TEAMS = Array.from({ length: 9 }, (_, i) => `T${i + 1}`);
/** Round -> position; with assignSlot this fills QB, RB1, RB2, WR1, WR2, TE, FLEX1, FLEX2, K, DST. */
const ROUND_POSITIONS: Position[] = ["QB", "RB", "RB", "WR", "WR", "TE", "RB", "WR", "K", "DST"];
const POOL: Position[] = [
  ...Array<Position>(9).fill("QB"),
  ...Array<Position>(27).fill("RB"),
  ...Array<Position>(27).fill("WR"),
  ...Array<Position>(9).fill("TE"),
  ...Array<Position>(9).fill("K"),
  ...Array<Position>(9).fill("DST"),
];

let db: Dynamo;
let n = 0;

async function get(key: { pk: string; sk: string }) {
  const r = await db.doc.send(
    new GetCommand({ TableName: db.tableName, Key: key, ConsistentRead: true }),
  );
  return r.Item;
}

/** A started league: 9 teams, order, 90 players, META drafting, season pointer drafting. */
async function seed(status: "in_progress" | "paused" | "scheduled" | "lobby" = "in_progress") {
  n++;
  const seasonId = `RS-${n}`;
  const leagueId = `RL-${n}`;
  await putSeasonMeta(db, {
    seasonId,
    leagueId,
    year: 2026,
    status: status === "scheduled" || status === "lobby" ? "setup" : "drafting",
    activeRulesetVersion: 1,
  });
  await db.doc.send(
    new PutCommand({
      TableName: db.tableName,
      Item: {
        ...seasonPointerKey(leagueId, 2026),
        type: "SeasonPointer",
        status: status === "scheduled" || status === "lobby" ? "setup" : "drafting",
      },
    }),
  );
  await putDraftState(db, {
    seasonId,
    status,
    pickSeconds: 90,
    currentPick: 1,
    currentPickDeadline: null,
    startedAt: status === "scheduled" || status === "lobby" ? null : NOW,
    updatedAt: NOW,
    order: TEAMS,
    autoDraft: ["T2", "T5"],
  });
  for (const [i, t] of TEAMS.entries())
    await putTeam(db, {
      seasonId,
      teamId: t,
      name: `Team ${t}`,
      managerUserId: `u${i}`,
      draftPosition: i + 1,
    });
  for (const [i, position] of POOL.entries())
    await putPlayer(db, {
      seasonId,
      playerId: `P${String(i).padStart(2, "0")}`,
      name: `P${i}`,
      position,
      nflTeam: "KC",
      providerPlayerId: null,
      injuryStatus: null,
      inPool: true,
    });
  return { seasonId, leagueId, year: 2026 };
}
type Ctx = Awaited<ReturnType<typeof seed>>;

/** Makes picks 1..upTo through recordPick (each pick takes the first free player of the needed position). */
async function draftTo(ctx: Ctx, upTo: number, opts: { clockOnLast?: boolean } = {}) {
  const taken = new Set<string>();
  const slotsByTeam = new Map<string, Slot[]>();
  const players = await queryPrefix(db, seasonPk(ctx.seasonId), skPrefix.players, {
    consistentRead: true,
  });
  const used = new Set(
    players.filter((p) => p.draftedByTeamId !== undefined).map((p) => String(p.playerId)),
  );
  const picks = await queryPrefix(db, seasonPk(ctx.seasonId), skPrefix.picks, {
    consistentRead: true,
  });
  for (const p of picks)
    slotsByTeam.set(String(p.teamId), [
      ...(slotsByTeam.get(String(p.teamId)) ?? []),
      p.slot as Slot,
    ]);
  for (let pick = picks.length + 1; pick <= upTo; pick++) {
    const team = teamOnClock(pick, TEAMS);
    const filled = slotsByTeam.get(team) ?? [];
    const position = ROUND_POSITIONS[roundOf(pick) - 1] as Position;
    const slot = assignSlot(position, filled) as Slot;
    const player = players.find(
      (p) =>
        p.position === position && !used.has(String(p.playerId)) && !taken.has(String(p.playerId)),
    );
    taken.add(String(player!.playerId));
    used.add(String(player!.playerId));
    slotsByTeam.set(team, [...filled, slot]);
    if (pick === upTo && opts.clockOnLast)
      await startClock(db, {
        seasonId: ctx.seasonId,
        actorUserId: "c1",
        now: NOW,
        expectedPick: pick,
        seconds: 90,
      });
    await recordPick(db, {
      seasonId: ctx.seasonId,
      expectedPick: pick,
      teamId: team,
      playerId: String(player!.playerId),
      slot,
      round: roundOf(pick),
      madeBy: "autopick",
      madeByUserId: null,
      nextDeadline: null,
      isFinalPick: pick === TOTAL_PICKS,
      now: NOW,
      seasonPointer: { leagueId: ctx.leagueId, year: ctx.year },
    });
  }
}

const input = (c: Ctx) => ({
  seasonId: c.seasonId,
  leagueId: c.leagueId,
  year: c.year,
  actorUserId: "commish",
  now: LATER,
});

const count = async (c: Ctx, prefix: string) =>
  (await queryPrefix(db, seasonPk(c.seasonId), prefix, { consistentRead: true })).length;

async function expectConflict(p: Promise<unknown>, label: string) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TransactionConflictError);
  expect((err as TransactionConflictError).has(label)).toBe(true);
}

beforeEach(async () => {
  db ??= await createTestDynamo("reset");
});

describe("end of draft", () => {
  it("completes atomically on pick 90, even with a running clock, and clears the clock", async () => {
    const c = await seed();
    await draftTo(c, 90, { clockOnLast: true });
    expect(await get(draftKey(c.seasonId))).toMatchObject({
      status: "complete",
      currentPick: 91,
      currentPickDeadline: null,
    });
    const d = await get(draftKey(c.seasonId));
    expect(d).not.toHaveProperty("clockStartedAt");
    expect(d).not.toHaveProperty("clockExpiresAt");
    expect(d).not.toHaveProperty("clockSeconds");
    expect((await get(seasonMetaKey(c.seasonId)))?.status).toBe("in_progress");
    expect((await get(seasonPointerKey(c.leagueId, c.year)))?.status).toBe("in_progress");
    expect(await count(c, skPrefix.picks)).toBe(90);
    expect(await count(c, skPrefix.rosters)).toBe(90);
  });

  it("accepts no further pick, clock, pause, start, order or auto-draft change once complete", async () => {
    const c = await seed();
    await draftTo(c, 90);
    await expectConflict(
      recordPick(db, {
        seasonId: c.seasonId,
        expectedPick: 91,
        teamId: "T1",
        playerId: "P00",
        slot: "QB",
        round: 10,
        madeBy: "manager",
        madeByUserId: "u0",
        nextDeadline: null,
        isFinalPick: false,
        now: NOW,
      }),
      "draft_state",
    );
    const rejects = (p: Promise<unknown>) =>
      expect(p).rejects.toMatchObject({ code: "draft_wrong_status" });
    await expect(
      startClock(db, {
        seasonId: c.seasonId,
        actorUserId: "c",
        now: NOW,
        expectedPick: 91,
        seconds: 90,
      }),
    ).rejects.toMatchObject({ code: "stale_pick" });
    await rejects(pauseDraft(db, { seasonId: c.seasonId, actorUserId: "c", now: NOW }));
    await rejects(startDraft(db, { ...input(c), actorUserId: "c", now: NOW }));
    await rejects(setDraftOrder(db, { ...input(c), order: [...TEAMS].reverse() }));
    await rejects(
      setAutoDraft(db, {
        seasonId: c.seasonId,
        teamId: "T1",
        enabled: true,
        actorUserId: "u",
        now: NOW,
      }),
    );
  });

  it("undoing the final pick returns to in_progress / drafting", async () => {
    const c = await seed();
    await draftTo(c, 90, { clockOnLast: true });
    await undoLastPick(db, {
      seasonId: c.seasonId,
      currentPick: 91,
      actorUserId: "c1",
      newDeadline: null,
      now: LATER,
      seasonPointer: { leagueId: c.leagueId, year: c.year },
    });
    const d = await get(draftKey(c.seasonId));
    expect(d).toMatchObject({ status: "in_progress", currentPick: 90 });
    expect(d).not.toHaveProperty("clockExpiresAt");
    expect((await get(seasonMetaKey(c.seasonId)))?.status).toBe("drafting");
    expect((await get(seasonPointerKey(c.leagueId, c.year)))?.status).toBe("drafting");
    expect(await count(c, skPrefix.picks)).toBe(89);
    // The draft can finish again.
    await draftTo(c, 90);
    expect((await get(draftKey(c.seasonId)))?.status).toBe("complete");
  });
});

describe("redraft", () => {
  async function expectPristine(c: Ctx, cleared: number) {
    const d = await get(draftKey(c.seasonId));
    expect(d).toMatchObject({
      status: "scheduled",
      currentPick: 1,
      currentPickDeadline: null,
      startedAt: null,
      order: TEAMS,
    });
    expect(d).not.toHaveProperty("clockExpiresAt");
    expect(d).not.toHaveProperty("resetPickCount");
    expect([...((d?.autoDraft as Set<string>) ?? [])].sort()).toEqual(["T2", "T5"]);
    expect(await count(c, skPrefix.picks)).toBe(0);
    expect(await count(c, skPrefix.rosters)).toBe(0);
    const players = await queryPrefix(db, seasonPk(c.seasonId), skPrefix.players, {
      consistentRead: true,
    });
    expect(players).toHaveLength(90);
    for (const p of players) {
      expect(p).not.toHaveProperty("draftedByTeamId");
      expect(p).not.toHaveProperty("draftedAtPick");
      expect(p.inPool).toBe(true);
    }
    expect((await queryPrefix(db, seasonPk(c.seasonId), skPrefix.teams)).length).toBe(9);
    expect((await get(seasonMetaKey(c.seasonId)))?.status).toBe("setup");
    expect((await get(seasonPointerKey(c.leagueId, c.year)))?.status).toBe("setup");
    const audits = await queryPrefix(db, seasonPk(c.seasonId), skPrefix.audit, {
      consistentRead: true,
    });
    const resets = audits.filter((a) => a.action === "draft.reset");
    expect(resets).toHaveLength(1);
    expect(resets[0]).toMatchObject({ actorUserId: "commish", details: { picksCleared: cleared } });
  }

  it("resets a complete draft and the commissioner can Start again", async () => {
    const c = await seed();
    await draftTo(c, 90);
    await putQueue(db, { seasonId: c.seasonId, teamId: "T1", playerIds: ["P01", "P02"], now: NOW });
    const before = (await getDraft(db, c.seasonId))!.version;
    expect(await resetDraft(db, input(c))).toBe(90);
    await expectPristine(c, 90);
    expect((await getDraft(db, c.seasonId))!.version).toBeGreaterThan(before + 1);
    expect(await get(queueKey(c.seasonId, "T1"))).toMatchObject({ playerIds: ["P01", "P02"] });
    await startDraft(db, { ...input(c), now: LATER });
    expect(await get(draftKey(c.seasonId))).toMatchObject({
      status: "in_progress",
      currentPick: 1,
    });
    // Picks work again from pick 1 with the freed players.
    await draftTo(c, 3);
    expect(await count(c, skPrefix.picks)).toBe(3);
  });

  it("resets an in-progress draft (mid-round, clock running)", async () => {
    const c = await seed();
    await draftTo(c, 23, { clockOnLast: true });
    expect(await resetDraft(db, input(c))).toBe(23);
    await expectPristine(c, 23);
  });

  it("resets a paused draft", async () => {
    const c = await seed();
    await draftTo(c, 12);
    await pauseDraft(db, { seasonId: c.seasonId, actorUserId: "c", now: NOW });
    expect(await resetDraft(db, input(c))).toBe(12);
    await expectPristine(c, 12);
  });

  it("is rejected before the draft has started", async () => {
    for (const status of ["scheduled", "lobby"] as const) {
      const c = await seed(status);
      await expect(resetDraft(db, input(c))).rejects.toMatchObject({
        code: "draft_wrong_status",
      });
      expect((await get(draftKey(c.seasonId)))?.status).toBe(status);
    }
  });

  it("is rejected once the season is past the draft", async () => {
    const c = await seed();
    await draftTo(c, 2);
    await db.doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: seasonMetaKey(c.seasonId),
        UpdateExpression: "SET #s = :c",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":c": "complete" },
      }),
    );
    await expect(resetDraft(db, input(c))).rejects.toMatchObject({ code: "draft_wrong_status" });
    expect((await get(draftKey(c.seasonId)))?.status).toBe("in_progress");
  });

  it("rejects a stale version with conflict", async () => {
    const c = await seed();
    await draftTo(c, 5);
    await expect(
      lockDraftForReset(db, { ...input(c), expectedVersion: 0, pickCount: 5 }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await get(draftKey(c.seasonId)))?.status).toBe("in_progress");
  });

  it("locks out picks, undo, clock, pause, start, order and auto-draft while resetting", async () => {
    const c = await seed();
    await draftTo(c, 5);
    const v = (await getDraft(db, c.seasonId))!.version;
    await lockDraftForReset(db, { ...input(c), expectedVersion: v, pickCount: 5 });
    const d = await get(draftKey(c.seasonId));
    expect(d).toMatchObject({ status: "resetting", resetPickCount: 5, version: v + 1 });
    await expectConflict(
      recordPick(db, {
        seasonId: c.seasonId,
        expectedPick: 6,
        teamId: teamOnClock(6, TEAMS),
        playerId: "P89",
        slot: "QB",
        round: 1,
        madeBy: "manager",
        madeByUserId: "u",
        nextDeadline: null,
        isFinalPick: false,
        now: NOW,
      }),
      "draft_state",
    );
    await expectConflict(
      undoLastPick(db, {
        seasonId: c.seasonId,
        currentPick: 6,
        actorUserId: "c",
        newDeadline: null,
        now: NOW,
      }),
      "draft_state",
    );
    await expect(
      startClock(db, {
        seasonId: c.seasonId,
        actorUserId: "c",
        now: NOW,
        expectedPick: 6,
        seconds: 90,
      }),
    ).rejects.toMatchObject({ code: "stale_pick" });
    const wrong = (p: Promise<unknown>) =>
      expect(p).rejects.toMatchObject({ code: "draft_wrong_status" });
    await wrong(pauseDraft(db, { seasonId: c.seasonId, actorUserId: "c", now: NOW }));
    await wrong(startDraft(db, { ...input(c), now: NOW }));
    await wrong(setDraftOrder(db, { ...input(c), order: [...TEAMS].reverse() }));
    await wrong(
      setAutoDraft(db, {
        seasonId: c.seasonId,
        teamId: "T1",
        enabled: false,
        actorUserId: "u",
        now: NOW,
      }),
    );
    // Nothing leaked through the lock.
    expect(await count(c, skPrefix.picks)).toBe(5);
  });

  it("a pick racing the lock either wins first (reset then clears it) or is rejected", async () => {
    const c = await seed();
    await draftTo(c, 4);
    const racer = draftTo(c, 5);
    const reset = resetDraft(db, input(c));
    const [r, s] = await Promise.allSettled([racer, reset]);
    // Whatever the interleaving, a completed reset leaves nothing behind.
    if (s.status === "fulfilled") {
      expect([4, 5]).toContain(s.value);
      await expectPristine(c, s.value);
    } else {
      // The racing pick bumped the version first: the reset reports a clean conflict.
      expect(s.reason).toBeInstanceOf(DomainError);
      expect((s.reason as DomainError).code).toBe("conflict");
      expect(r.status).toBe("fulfilled");
    }
  });

  it("resumes after a crash in the middle of the cleanup", async () => {
    const c = await seed();
    await draftTo(c, 90);
    const v = (await getDraft(db, c.seasonId))!.version;
    await lockDraftForReset(db, { ...input(c), expectedVersion: v, pickCount: 90 });
    // Simulated crash: the players phase ran, rosters and picks did not complete. Remove just
    // the player markers and 40 picks, as a half-finished cleanup would leave.
    const players = await queryPrefix(db, seasonPk(c.seasonId), skPrefix.players);
    for (const p of players.slice(0, 40))
      await db.doc.send(
        new UpdateCommand({
          TableName: db.tableName,
          Key: playerKey(c.seasonId, String(p.playerId)),
          UpdateExpression: "REMOVE draftedByTeamId, draftedAtPick",
        }),
      );
    expect((await get(draftKey(c.seasonId)))?.status).toBe("resetting");
    // The retry (same call as the first attempt) resumes and finishes; audit count survives.
    expect(await resetDraft(db, input(c))).toBe(90);
    await expectPristine(c, 90);
    // And clearing again is a harmless no-op.
    expect(await clearDraftData(db, c.seasonId)).toEqual({ players: 0, rosters: 0, picks: 0 });
  });

  it("resumes after a crash right before the final transaction", async () => {
    const c = await seed();
    await draftTo(c, 30);
    const v = (await getDraft(db, c.seasonId))!.version;
    await lockDraftForReset(db, { ...input(c), expectedVersion: v, pickCount: 30 });
    await clearDraftData(db, c.seasonId);
    expect((await get(draftKey(c.seasonId)))?.status).toBe("resetting");
    expect(await resetDraft(db, input(c))).toBe(30);
    await expectPristine(c, 30);
  });

  it("two concurrent resets both succeed and write a single audit event", async () => {
    const c = await seed();
    await draftTo(c, 90);
    const results = await Promise.allSettled([resetDraft(db, input(c)), resetDraft(db, input(c))]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    await expectPristine(c, 90);
  });

  it("finalize is idempotent once scheduled and refuses a started draft", async () => {
    const c = await seed();
    await draftTo(c, 3);
    await expect(finalizeDraftReset(db, { ...input(c), picksCleared: 3 })).rejects.toMatchObject({
      code: "draft_wrong_status",
    });
    await resetDraft(db, input(c));
    await finalizeDraftReset(db, { ...input(c), picksCleared: 3 }); // already scheduled: no-op
    expect(await count(c, "AUDIT#")).toBeGreaterThan(0);
  });

  it("keeps roster exceptions (only draft entries are cleared)", async () => {
    const c = await seed();
    await draftTo(c, 5);
    await db.doc.send(
      new PutCommand({
        TableName: db.tableName,
        Item: {
          pk: seasonPk(c.seasonId),
          sk: "ROSTER#T1#QB#2",
          type: "RosterEntry",
          teamId: "T1",
          slot: "QB",
          playerId: "P50",
          fromRound: 2,
          acquiredVia: "exception",
        },
      }),
    );
    await resetDraft(db, input(c));
    expect(await count(c, skPrefix.rosters)).toBe(1);
  });
});
