import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { beforeAll, describe, expect, it } from "vitest";
import type { Dynamo } from "./client";
import { INGEST_WARNINGS_MAX } from "./items";
import { pointsKey, teamScoreKey } from "./keys";
import { batchWrite, deleteRequest, putRequest } from "./repos/batch";
import {
  acquireIngestLease,
  auditIngestRun,
  finishIngestRun,
  getIngestState,
  listIngestRegistry,
  requestIngestRun,
  setIngestEnabled,
} from "./repos/ingest";
import {
  ensureRounds,
  listGames,
  listRounds,
  markGameStatsFetched,
  updateNflTeamStatuses,
  updateRoundStatuses,
  upsertGameStats,
  upsertGames,
  writeComputedScores,
} from "./repos/live";
import { bootstrapLeague } from "./repos/leagues";
import { loadSeason } from "./repos/season";
import { createTestDynamo } from "./testing";

let db: Dynamo;
beforeAll(async () => {
  db = await createTestDynamo("live");
});

let n = 0;
async function season() {
  n++;
  const r = await bootstrapLeague(db, {
    userId: `c${n}`,
    email: `boss${n}@local.test`,
    leagueName: `L${n}`,
    year: 2026,
  });
  return { seasonId: r.seasonId, leagueId: r.leagueId, actorUserId: `c${n}`, year: 2026 };
}
const T0 = "2027-01-10T12:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

describe("ingest registry (A15)", () => {
  it("enable creates the item, audits, and makes the next poll due now; disable clears it", async () => {
    const s = await season();
    expect(await getIngestState(db, s.seasonId)).toBeUndefined();
    await setIngestEnabled(db, { ...s, enabled: true, now: T0 });
    const on = await getIngestState(db, s.seasonId);
    expect(on).toMatchObject({
      type: "IngestState",
      enabled: true,
      nextPollAt: T0,
      warnings: [],
      leagueId: s.leagueId,
      year: 2026,
    });
    await setIngestEnabled(db, { ...s, enabled: false, now: at(1000) });
    expect(await getIngestState(db, s.seasonId)).toMatchObject({
      enabled: false,
      nextPollAt: null,
    });
    const audits = (await loadSeason(db, s.seasonId)).audit.map((a) => a.action).sort();
    expect(audits.filter((a) => a.startsWith("ingest."))).toEqual([
      "ingest.disable",
      "ingest.enable",
    ]);
    await auditIngestRun(db, { seasonId: s.seasonId, actorUserId: s.actorUserId, now: T0 });
    expect((await loadSeason(db, s.seasonId)).audit.map((a) => a.action)).toContain("ingest.run");
  });

  it("lists the registry with one Query on pk = INGEST", async () => {
    const a = await season();
    const b = await season();
    await setIngestEnabled(db, { ...a, enabled: true, now: T0 });
    await setIngestEnabled(db, { ...b, enabled: false, now: T0 });
    const ids = (await listIngestRegistry(db)).map((r) => r.seasonId);
    expect(ids).toContain(a.seasonId);
    expect(ids).toContain(b.seasonId);
  });

  it("the lease is exclusive until it expires, and creates a disabled item when missing", async () => {
    const s = await season();
    const lease = (now: string) => acquireIngestLease(db, { ...s, now, ttlMs: 60_000 });
    expect(await lease(T0)).toBe(true);
    expect(await getIngestState(db, s.seasonId)).toMatchObject({
      enabled: false,
      nextPollAt: null,
      leaseUntil: at(60_000),
    });
    expect(await lease(at(30_000))).toBe(false);
    expect(await lease(at(61_000))).toBe(true);
  });

  it("finishing a run releases the lease and records the outcome; warnings are deduped and capped", async () => {
    const s = await season();
    await setIngestEnabled(db, { ...s, enabled: true, now: T0 });
    await acquireIngestLease(db, { ...s, now: T0, ttlMs: 60_000 });
    const summary = {
      games: 6,
      statLines: 90,
      changedStatLines: 4,
      pointsWritten: 3,
      teamScoresWritten: 2,
    };
    const many = Array.from({ length: 150 }, (_, i) => `w${i % 120}`);
    await finishIngestRun(db, {
      seasonId: s.seasonId,
      now: at(5000),
      summary,
      warnings: many,
      nextPollAt: at(120_000),
    });
    const ok = await getIngestState(db, s.seasonId);
    expect(ok).toMatchObject({
      lastRunAt: at(5000),
      lastSuccessAt: at(5000),
      lastSummary: summary,
      nextPollAt: at(120_000),
      enabled: true,
    });
    expect(ok?.leaseUntil).toBeUndefined();
    expect(ok?.warnings).toHaveLength(INGEST_WARNINGS_MAX);

    await acquireIngestLease(db, { ...s, now: at(6000), ttlMs: 60_000 });
    await finishIngestRun(db, {
      seasonId: s.seasonId,
      now: at(7000),
      error: "ESPN scoreboard could not be reached",
      warnings: [],
      nextPollAt: at(900_000),
    });
    const failed = await getIngestState(db, s.seasonId);
    expect(failed).toMatchObject({
      lastRunAt: at(7000),
      lastSuccessAt: at(5000),
      lastError: "ESPN scoreboard could not be reached",
    });
    expect(failed?.leaseUntil).toBeUndefined();

    await acquireIngestLease(db, { ...s, now: at(8000), ttlMs: 60_000 });
    await finishIngestRun(db, {
      seasonId: s.seasonId,
      now: at(9000),
      summary,
      warnings: [],
      nextPollAt: null,
    });
    expect((await getIngestState(db, s.seasonId))?.lastError).toBeUndefined();
  });

  it("requestIngestRun makes the poll due now", async () => {
    const s = await season();
    await setIngestEnabled(db, { ...s, enabled: true, now: T0 });
    await finishIngestRun(db, {
      seasonId: s.seasonId,
      now: T0,
      summary: {
        games: 0,
        statLines: 0,
        changedStatLines: 0,
        pointsWritten: 0,
        teamScoresWritten: 0,
      },
      warnings: [],
      nextPollAt: at(6 * 3600_000),
    });
    await requestIngestRun(db, { seasonId: s.seasonId, now: at(1000) });
    expect((await getIngestState(db, s.seasonId))?.nextPollAt).toBe(at(1000));
  });
});

describe("batchWrite", () => {
  it("writes more than 25 items and deletes them again", async () => {
    const s = await season();
    const items = Array.from({ length: 60 }, (_, i) => ({
      ...pointsKey(s.seasonId, "g", `p${i}`),
      type: "x",
    }));
    await batchWrite(db, items.map(putRequest));
    await batchWrite(
      db,
      items.map((i) => deleteRequest({ pk: i.pk, sk: i.sk })),
    );
    await batchWrite(db, []);
  });

  it("retries unprocessed items and gives up after the attempt limit", async () => {
    const send = async (cmd: unknown) => {
      void cmd;
      calls++;
      const req =
        (cmd as { input: { RequestItems: Record<string, unknown[]> } }).input.RequestItems.t ?? [];
      return calls < 3 ? { UnprocessedItems: { t: req } } : {};
    };
    let calls = 0;
    const fake = { tableName: "t", doc: { send } } as unknown as Dynamo;
    await batchWrite(fake, [putRequest({ pk: "a", sk: "b" })]);
    expect(calls).toBe(3);

    calls = -100;
    await expect(batchWrite(fake, [putRequest({ pk: "a", sk: "b" })])).rejects.toThrow(
      /unprocessed/,
    );
  }, 60_000);
});

describe("live writes", () => {
  it("creates only the missing rounds, and never changes a finalized one", async () => {
    const s = await season();
    expect(await ensureRounds(db, s.seasonId, [])).toBe(4);
    let rounds = await listRounds(db, s.seasonId);
    expect(rounds.map((r) => [r.round, r.code, r.status])).toEqual([
      [1, "WC", "upcoming"],
      [2, "DIV", "upcoming"],
      [3, "CONF", "upcoming"],
      [4, "SB", "upcoming"],
    ]);
    // a concurrent creator: the conditional put is swallowed
    expect(await ensureRounds(db, s.seasonId, [])).toBe(0);
    expect(await ensureRounds(db, s.seasonId, rounds)).toBe(0);

    expect(
      await updateRoundStatuses(
        db,
        s.seasonId,
        [
          { round: 1, status: "live" },
          { round: 2, status: "upcoming" },
        ],
        rounds,
      ),
    ).toBe(1);
    rounds = await listRounds(db, s.seasonId);
    expect(rounds[0]?.status).toBe("live");
    // finalize round 1 behind the caller's back: the stale `existing` still says live
    await db.doc.send(
      new PutCommand({ TableName: db.tableName, Item: { ...rounds[0], status: "finalized" } }),
    );
    expect(await updateRoundStatuses(db, s.seasonId, [{ round: 1, status: "final" }], rounds)).toBe(
      0,
    );
    const after = await listRounds(db, s.seasonId);
    expect(after[0]?.status).toBe("finalized");
    // already finalized in `existing`, or unknown round: skipped before any write
    expect(await updateRoundStatuses(db, s.seasonId, [{ round: 1, status: "live" }], after)).toBe(
      0,
    );
    expect(await updateRoundStatuses(db, s.seasonId, [{ round: 9, status: "live" }], after)).toBe(
      0,
    );
  });

  it("upserts games only when a field changed, keeping statsFetchedAt", async () => {
    const s = await season();
    const g = {
      gameId: "g1",
      round: 1,
      home: "CAR",
      away: "LAR",
      kickoff: T0,
      status: "scheduled",
      homeScore: 0,
      awayScore: 0,
    };
    expect(await upsertGames(db, s.seasonId, [g], [])).toBe(1);
    let games = await listGames(db, s.seasonId);
    expect(games[0]).toMatchObject({ ...g, providerGameId: "g1", type: "Game" });
    expect(await upsertGames(db, s.seasonId, [g], games)).toBe(0);
    await markGameStatsFetched(db, s.seasonId, "g1", at(5));
    const final = { ...g, status: "final", homeScore: 31, awayScore: 34, winner: "LAR" };
    expect(await upsertGames(db, s.seasonId, [final], games)).toBe(1);
    games = await listGames(db, s.seasonId);
    expect(games[0]).toMatchObject({ ...final, statsFetchedAt: at(5) });
    // a correction removes the winner
    expect(await upsertGames(db, s.seasonId, [{ ...final, winner: undefined }], games)).toBe(1);
    expect((await listGames(db, s.seasonId))[0]?.winner).toBeUndefined();
  });

  it("updates NFL team status only where it differs", async () => {
    const s = await season();
    const base = { pk: `SEASON#${s.seasonId}`, type: "NflTeam", conference: "NFC", seed: 1 };
    const put = (abbr: string, extra: object) =>
      db.doc.send(
        new PutCommand({
          TableName: db.tableName,
          Item: { ...base, sk: `NFLTEAM#${abbr}`, abbr, ...extra },
        }),
      );
    await put("SEA", { status: "bye" });
    await put("NE", { status: "alive" });
    let teams = (await loadSeason(db, s.seasonId)).nflTeams;
    const updates = [
      { abbr: "SEA", status: "champion" as const },
      { abbr: "NE", status: "eliminated" as const, eliminatedInRound: "SB" as const },
      { abbr: "XX", status: "alive" as const },
    ];
    expect(await updateNflTeamStatuses(db, s.seasonId, updates, teams)).toBe(2);
    teams = (await loadSeason(db, s.seasonId)).nflTeams;
    expect(teams.find((t) => t.abbr === "NE")).toMatchObject({
      status: "eliminated",
      eliminatedInRound: "SB",
    });
    expect(await updateNflTeamStatuses(db, s.seasonId, updates, teams)).toBe(0);
    // back to alive removes the round
    expect(
      await updateNflTeamStatuses(db, s.seasonId, [{ abbr: "NE", status: "alive" }], teams),
    ).toBe(1);
    expect(
      (await loadSeason(db, s.seasonId)).nflTeams.find((t) => t.abbr === "NE")?.eliminatedInRound,
    ).toBeUndefined();
  });

  it("upserts a game's stat lines by hash and deletes players that left the output (A16)", async () => {
    const s = await season();
    const line = (playerId: string, yds: number, hash: string) => ({
      playerId,
      raw: { yds },
      canonical: { rush_yds: yds },
      providerHash: hash,
    });
    const other = line("p9", 1, "h9");
    await upsertGameStats(db, s.seasonId, "g2", [other], T0);
    expect(
      await upsertGameStats(db, s.seasonId, "g1", [line("p1", 10, "h1"), line("p2", 20, "h2")], T0),
    ).toEqual({ changed: 2, unchanged: 0, deleted: 0 });
    expect(
      await upsertGameStats(
        db,
        s.seasonId,
        "g1",
        [line("p1", 10, "h1"), { ...line("p2", 25, "h2b"), events: { fg_made: [40] } }],
        at(1000),
      ),
    ).toEqual({ changed: 1, unchanged: 1, deleted: 0 });
    let stats = (await loadSeason(db, s.seasonId)).stats;
    const p2 = stats.find((x) => x.gameId === "g1" && x.playerId === "p2");
    expect(p2).toMatchObject({
      canonical: { rush_yds: 25 },
      events: { fg_made: [40] },
      fetchedAt: at(1000),
    });
    expect(stats.find((x) => x.playerId === "p1")?.fetchedAt).toBe(T0);
    expect(await upsertGameStats(db, s.seasonId, "g1", [line("p1", 10, "h1")], at(2000))).toEqual({
      changed: 0,
      unchanged: 1,
      deleted: 1,
    });
    stats = (await loadSeason(db, s.seasonId)).stats;
    expect(stats.map((x) => `${x.gameId}/${x.playerId}`).sort()).toEqual(["g1/p1", "g2/p9"]);
  });
});

describe("writeComputedScores", () => {
  const pt = (round: number, gameId: string, playerId: string, points: number) => ({
    gameId,
    playerId,
    round,
    points,
    breakdown: [{ ruleIndex: 0, stat: "rush_yds" as const, value: 10, points }],
    rulesetVersion: 1,
    overridden: [],
  });
  const ts = (round: number, teamId: string, points: number) => ({
    teamId,
    round,
    points,
    provisional: true,
  });
  const rounds = (...frozen: number[]) =>
    [1, 2].map((round) => ({
      round,
      status: frozen.includes(round) ? ("finalized" as const) : ("final" as const),
    }));
  const load = async (seasonId: string) => {
    const snap = await loadSeason(db, seasonId);
    return { existingPoints: snap.points, existingTeamScores: snap.teamScores };
  };

  it("writes new items, skips unchanged ones, rewrites changed ones and deletes stale ones", async () => {
    const s = await season();
    const run = async (
      points: ReturnType<typeof pt>[],
      teamScores: ReturnType<typeof ts>[],
      now: string,
      r = rounds(),
    ) =>
      writeComputedScores(db, {
        seasonId: s.seasonId,
        rounds: r,
        points,
        teamScores,
        ...(await load(s.seasonId)),
        now,
      });
    const first = await run(
      [pt(1, "g1", "a", 5), pt(2, "g2", "b", 7)],
      [ts(1, "t1", 5), ts(2, "t1", 7)],
      T0,
    );
    expect(first).toEqual({
      pointsWritten: 2,
      pointsDeleted: 0,
      teamScoresWritten: 2,
      teamScoresDeleted: 0,
    });
    const same = await run(
      [pt(1, "g1", "a", 5), pt(2, "g2", "b", 7)],
      [ts(1, "t1", 5), ts(2, "t1", 7)],
      at(1000),
    );
    expect(same).toEqual({
      pointsWritten: 0,
      pointsDeleted: 0,
      teamScoresWritten: 0,
      teamScoresDeleted: 0,
    });
    const changed = await run([pt(1, "g1", "a", 6)], [ts(1, "t1", 6)], at(2000));
    expect(changed).toEqual({
      pointsWritten: 1,
      pointsDeleted: 1,
      teamScoresWritten: 1,
      teamScoresDeleted: 1,
    });
    const snap = await loadSeason(db, s.seasonId);
    expect(snap.points.map((p) => [p.gameId, p.points, p.computedAt])).toEqual([
      ["g1", 6, at(2000)],
    ]);
    expect(snap.teamScores.map((t) => [t.round, t.points])).toEqual([[1, 6]]);
  });

  it("never writes or deletes anything in a finalized round", async () => {
    const s = await season();
    const write = async (
      points: ReturnType<typeof pt>[],
      teamScores: ReturnType<typeof ts>[],
      r: ReturnType<typeof rounds>,
      now: string,
    ) =>
      writeComputedScores(db, {
        seasonId: s.seasonId,
        rounds: r,
        points,
        teamScores,
        ...(await load(s.seasonId)),
        now,
      });
    await write([pt(1, "g1", "a", 5)], [ts(1, "t1", 5)], rounds(), T0);
    // round 1 gets finalized; recompute now yields different numbers and omits g1 entirely
    const res = await write(
      [pt(1, "g1", "a", 99), pt(2, "g2", "b", 3)],
      [ts(1, "t1", 99), ts(2, "t1", 3)],
      rounds(1),
      at(1000),
    );
    expect(res).toEqual({
      pointsWritten: 1,
      pointsDeleted: 0,
      teamScoresWritten: 1,
      teamScoresDeleted: 0,
    });
    await write([], [], rounds(1), at(2000));
    const snap = await loadSeason(db, s.seasonId);
    expect(snap.points.map((p) => [p.gameId, p.points])).toEqual([["g1", 5]]);
    expect(snap.teamScores.map((t) => [t.round, t.points])).toEqual([[1, 5]]);
    expect(snap.teamScores[0]?.computedAt).toBe(T0);
    expect(teamScoreKey(s.seasonId, 1, "t1").sk).toBe("TEAMSCORE#1#t1");
  });

  it("detects a changed override list or ruleset version", async () => {
    const s = await season();
    const base = pt(1, "g1", "a", 5);
    const write = async (row: typeof base, now: string) =>
      writeComputedScores(db, {
        seasonId: s.seasonId,
        rounds: rounds(),
        points: [row],
        teamScores: [],
        ...(await load(s.seasonId)),
        now,
      });
    expect((await write(base, T0)).pointsWritten).toBe(1);
    expect((await write({ ...base, overridden: ["rush_yds" as never] }, at(1))).pointsWritten).toBe(
      1,
    );
    expect((await write({ ...base, overridden: ["rush_yds" as never] }, at(2))).pointsWritten).toBe(
      0,
    );
    expect(
      (await write({ ...base, rulesetVersion: 2, overridden: ["rush_yds" as never] }, at(3)))
        .pointsWritten,
    ).toBe(1);
  });
});
