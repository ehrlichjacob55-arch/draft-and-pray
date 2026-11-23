/**
 * Task 9 acceptance (docs/design/04 §8): replay the recorded 2025 postseason through `runIngest`
 * against DynamoDB Local, staged like a real playoff: scheduled -> live -> final -> next rounds.
 */
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  importPool,
  loadSeason,
  overrideKey,
  queryPrefix,
  roundKey,
  seasonPk,
  statsKey,
  type Dynamo,
  type PoolPlayerInput,
} from "@dnp/db";
import { createTestDynamo } from "@dnp/db/testing";
import { GOLDEN_PLAYERS, type Slot } from "@dnp/domain";
import { beforeAll, describe, expect, it } from "vitest";
import {
  EVENTS,
  allScoreboards,
  parseEspnStandings,
  standingsJson,
  summary,
} from "./providers/espn-fixtures";
import type { LiveSource, RoundGames } from "./providers";
import { runIngest } from "./scoring/ingest";
import { recomputeSeason } from "./scoring/recompute";
import { createTestSeason, putRosterEntry, type TestSeason } from "./testing/league";

let db: Dynamo;
let s: TestSeason;
const published: string[] = [];
const T = (iso: string) => new Date(iso);

// ---- The fake ESPN: recorded data, served in stages ----
type Phase = "scheduled" | "live" | "final";
const real = allScoreboards();
const stage = {
  /** Per round: which phase its games are in; a missing round has no games listed yet. */
  rounds: {} as Record<number, Phase | undefined>,
  /** Event ids shown as in progress when their round is `live`; the rest of the round is scheduled. */
  liveEvents: new Set<string>(),
  yearsAsked: [] as number[],
  summaryCalls: [] as string[],
  failSummary: new Set<string>(),
};
const source: LiveSource = {
  async fetchRoundGames(year): Promise<RoundGames[]> {
    stage.yearsAsked.push(year);
    return real.map(({ round, games }) => {
      const phase = stage.rounds[round];
      if (!phase) return { round, games: [] };
      return {
        round,
        games: games.map((g) => {
          if (phase === "final") return g;
          const live = phase === "live" && stage.liveEvents.has(g.gameId);
          return {
            ...g,
            status: live ? ("in_progress" as const) : ("scheduled" as const),
            homeScore: live ? g.homeScore : 0,
            awayScore: live ? g.awayScore : 0,
            winner: undefined,
          };
        }),
      };
    });
  },
  async fetchSummary(id) {
    stage.summaryCalls.push(id);
    if (stage.failSummary.has(id)) throw new Error("connection reset by peer, secret@example.com");
    return summary(id);
  },
};

const ingest = (iso: string) =>
  runIngest({
    db,
    seasonId: s.seasonId,
    now: T(iso),
    source,
    publish: async () => {
      published.push(iso);
    },
  });

/** Every item of the season partition, to compare "nothing was written". */
const partition = async () =>
  JSON.stringify(await queryPrefix(db, seasonPk(s.seasonId), undefined, { consistentRead: true }));

const snapshot = () => loadSeason(db, s.seasonId, { consistentRead: true });
const playerId = async (name: string, team?: string) => {
  const p = (await snapshot()).players.find(
    (x) => x.name === name && (!team || x.nflTeam === team),
  );
  if (!p) throw new Error(`pool has no ${name}`);
  return p.playerId;
};
/** `Name (TEAM POS)` of GOLDEN_PLAYERS -> pool lookups. */
const golden = (name: string) => {
  const g = GOLDEN_PLAYERS.find((x) => x.name.startsWith(name));
  if (!g) throw new Error(`no golden ${name}`);
  const m = /^(.*) \((\w+) \w+\)$/.exec(g.name);
  return { g, name: m ? m[1]! : g.name, team: m ? m[2]! : g.name.split(" ")[0]! };
};

beforeAll(async () => {
  db = await createTestDynamo("ingest-replay");
  s = await createTestSeason(db);
  // The playoff field with the real 2025 seeds, and every box-score athlete of the postseason.
  const field = parseEspnStandings(standingsJson());
  const byId = new Map<string, PoolPlayerInput>();
  for (const ev of [
    "401772976",
    "401772977",
    "401772978",
    "401772979",
    "401772980",
    "401772981",
    "401772982",
    "401772983",
    "401772984",
    "401772985",
    "401772986",
    "401772987",
    "401772988",
  ]) {
    const sum = summary(ev);
    for (const a of sum.athletes) {
      const abbr = a.teamId === sum.home.id ? sum.home.abbr : sum.away.abbr;
      byId.set(a.id, {
        providerPlayerId: `espn:${a.id}`,
        espnId: a.id,
        name: a.name,
        position: a.stats.kicking ? "K" : a.stats.passing ? "QB" : a.stats.receiving ? "WR" : "RB",
        nflTeam: abbr,
        injuryStatus: null,
      });
    }
  }
  await importPool(db, {
    seasonId: s.seasonId,
    seasonYear: 2025,
    source: "test",
    teams: field,
    players: [...byId.values()],
    actorUserId: null,
    now: "2026-01-01T00:00:00.000Z",
  });
  // Two fantasy teams hold the golden game's players (rosters are written directly).
  const roster = async (teamId: string, picks: [Slot, string, string?][]) => {
    for (const [slot, name, team] of picks)
      await putRosterEntry(db, s.seasonId, { teamId, slot, playerId: await playerId(name, team) });
  };
  await roster(s.teamIds[0]!, [
    ["QB", "Matthew Stafford"],
    ["WR1", "Puka Nacua"],
    ["TE", "Colby Parkinson"],
    ["K", "Harrison Mevis"],
    ["DST", "Los Angeles Rams D/ST"],
  ]);
  await roster(s.teamIds[1]!, [
    ["QB", "Bryce Young"],
    ["RB1", "Chuba Hubbard"],
    ["RB2", "Trevor Etienne"],
    ["DST", "Carolina Panthers D/ST"],
  ]);
  await roster(s.teamIds[2]!, [
    ["K", "Jason Myers"],
    ["DST", "Seattle Seahawks D/ST"],
    ["WR1", "Rashid Shaheed"],
  ]);
});

const rounds = async () => (await snapshot()).rounds.sort((a, b) => a.round - b.round);
const teamStatus = async () =>
  Object.fromEntries(
    (await snapshot()).nflTeams.map((t) => [t.abbr, [t.status, t.eliminatedInRound]]),
  );
const teamScore = async (teamIdx: number, round: number) =>
  (await snapshot()).teamScores.find((t) => t.teamId === s.teamIds[teamIdx] && t.round === round);

describe("replay of the 2025 postseason", () => {
  it("1. Wild Card all scheduled: rounds upcoming, #1 seeds on a bye, no points", async () => {
    stage.rounds = { 1: "scheduled" };
    const r = await ingest("2026-01-10T10:00:00Z");
    expect(r.busy).toBe(false);
    expect(r.summary).toMatchObject({ games: 6, statLines: 0, pointsWritten: 0 });
    // the pool was imported from the 2025 season, so that is the year asked of ESPN (not 2026)
    expect(stage.yearsAsked).toEqual([2025]);
    expect(stage.summaryCalls).toEqual([]);
    expect((await rounds()).map((x) => [x.code, x.status])).toEqual([
      ["WC", "upcoming"],
      ["DIV", "upcoming"],
      ["CONF", "upcoming"],
      ["SB", "upcoming"],
    ]);
    const status = await teamStatus();
    expect(status.SEA?.[0]).toBe("bye");
    expect(status.DEN?.[0]).toBe("bye");
    expect(Object.values(status).filter(([st]) => st === "alive")).toHaveLength(12);
    const snap = await snapshot();
    expect(snap.games).toHaveLength(6);
    expect(snap.points).toEqual([]);
    expect(snap.stats).toEqual([]);
    // zero rows exist for every team and round, all provisional
    expect(snap.teamScores).toHaveLength(9 * 4);
    expect(snap.teamScores.every((t) => t.points === 0 && t.provisional)).toBe(true);
    // the first kickoff is later today: next check in 15 minutes
    expect(r.nextPollAt).toBe("2026-01-10T10:15:00.000Z");
    const state = (await queryPrefix(db, "INGEST", "SEASON#")).find(
      (i) => i.seasonId === s.seasonId,
    );
    expect(state).toMatchObject({ lastSuccessAt: "2026-01-10T10:00:00.000Z" });
  });

  it("2. LAR@CAR in progress: its players get points, round 1 is live, team scores are provisional", async () => {
    stage.rounds = { 1: "live" };
    stage.liveEvents = new Set([EVENTS.golden]);
    const before = published.length;
    const r = await ingest("2026-01-10T21:50:00Z");
    expect(stage.summaryCalls).toEqual([EVENTS.golden]);
    expect(r.nextPollAt).toBe("2026-01-10T21:52:00.000Z"); // a game is live: 2 minutes
    expect((await rounds())[0]?.status).toBe("live");
    const snap = await snapshot();
    expect(snap.games.find((g) => g.gameId === EVENTS.golden)).toMatchObject({
      status: "in_progress",
      homeScore: 31,
      awayScore: 34,
    });
    // every golden player scores exactly the hand-calculated league points
    for (const key of [
      "Matthew Stafford",
      "Puka Nacua",
      "Colby Parkinson",
      "Harrison Mevis",
      "Bryce Young",
      "Chuba Hubbard",
      "Trevor Etienne",
      "LAR DST",
      "CAR DST",
    ]) {
      const { g, name, team } = golden(key);
      const pid = await playerId(
        g.position === "DST"
          ? team === "LAR"
            ? "Los Angeles Rams D/ST"
            : "Carolina Panthers D/ST"
          : name,
        g.position === "DST" ? undefined : team,
      );
      const row = snap.points.find((p) => p.playerId === pid && p.gameId === EVENTS.golden);
      expect(row?.points, key).toBe(g.league);
    }
    expect((await teamScore(0, 1))?.points).toBe(27.13 + 34.5 + 11.4 + 12 + 4);
    expect((await teamScore(1, 1))?.points).toBe(44.5);
    expect(await teamScore(0, 1)).toMatchObject({ provisional: true });
    expect(published.length).toBeGreaterThan(before);
    // warnings never carry user data
    const warnings = (await queryPrefix(db, "INGEST", "SEASON#")).find(
      (i) => i.seasonId === s.seasonId,
    )?.warnings as string[];
    expect(warnings.join("\n")).not.toMatch(/Sekrit|@local\.test|boss\d/);
  });

  it("3. All Wild Card games final: round 1 final, the six losers eliminated, #1 seeds alive", async () => {
    stage.rounds = { 1: "final" };
    stage.summaryCalls = [];
    const r = await ingest("2026-01-12T12:00:00Z");
    expect(stage.summaryCalls.sort()).toEqual(
      ["401772976", "401772977", "401772978", "401772979", "401772980", "401772981"].sort(),
    );
    expect((await rounds())[0]?.status).toBe("final");
    const status = await teamStatus();
    for (const t of ["CAR", "GB", "JAX", "PHI", "LAC", "PIT"])
      expect(status[t], t).toEqual(["eliminated", "WC"]);
    for (const t of ["SEA", "DEN", "LAR", "CHI", "BUF", "SF", "NE", "HOU"])
      expect(status[t]?.[0], t).toBe("alive");
    expect(r.nextPollAt).toBe("2026-01-12T18:00:00.000Z"); // between rounds: 6 hours
    const snap = await snapshot();
    expect(snap.games.every((g) => g.statsFetchedAt === "2026-01-12T12:00:00.000Z")).toBe(true);
    // the game that was live is final now; its points are the final ones
    expect((await teamScore(0, 1))?.points).toBe(89.03);
    // CHI: C.Williams threw a 2-pt conversion, McManus missed twice (no warning for matched players)
    const mcmanus = snap.points.find(
      (p) =>
        p.gameId === EVENTS.gbChi &&
        p.playerId === snap.players.find((x) => x.name === "Brandon McManus")?.playerId,
    );
    // 3 XP made, 2 missed field goals, 1 missed XP
    expect(mcmanus?.points).toBe(0);
    const w = (await queryPrefix(db, "INGEST", "SEASON#")).find((i) => i.seasonId === s.seasonId)
      ?.warnings as string[];
    expect(w.filter((x) => /Unclassified|distances/.test(x))).toEqual([]);
  });

  it("4. Running again with identical data writes nothing and fetches nothing", async () => {
    const before = await partition();
    stage.summaryCalls = [];
    const r = await ingest("2026-01-12T12:01:00Z");
    expect(stage.summaryCalls).toEqual([]);
    expect(await partition()).toBe(before);
    expect(r.summary).toMatchObject({
      changedStatLines: 0,
      pointsWritten: 0,
      teamScoresWritten: 0,
    });
  });

  it("4b. After 6 hours the final games are re-fetched; unchanged stats still write nothing", async () => {
    stage.summaryCalls = [];
    const statsBefore = JSON.stringify((await snapshot()).stats);
    const pointsBefore = JSON.stringify((await snapshot()).points);
    const r = await ingest("2026-01-12T18:30:00Z");
    expect(stage.summaryCalls).toHaveLength(6);
    expect(r.summary).toMatchObject({
      changedStatLines: 0,
      pointsWritten: 0,
      teamScoresWritten: 0,
    });
    expect(JSON.stringify((await snapshot()).stats)).toBe(statsBefore);
    expect(JSON.stringify((await snapshot()).points)).toBe(pointsBefore);
  });

  it("4c. One failing summary becomes a warning and the others still update", async () => {
    stage.failSummary = new Set([EVENTS.gbChi]);
    stage.summaryCalls = [];
    const r = await ingest("2026-01-13T01:00:00Z");
    expect(stage.summaryCalls.sort()).toContain(EVENTS.gbChi);
    expect(r.warnings).toContain("GB @ CHI: Unexpected error while updating stats");
    expect(r.warnings.join("\n")).not.toMatch(/secret@example\.com/);
    stage.failSummary = new Set();
  });

  it("5. The rest of the postseason: SEA is champion, NE lost the Super Bowl, round 4 is final", async () => {
    stage.rounds = { 1: "final", 2: "final", 3: "final", 4: "final" };
    stage.summaryCalls = [];
    const r = await ingest("2026-02-10T12:00:00Z");
    // the 7 new games, and the six Wild Card games again (more than 6 hours since their last fetch)
    expect(stage.summaryCalls).toHaveLength(13);
    const status = await teamStatus();
    expect(status.SEA).toEqual(["champion", undefined]);
    expect(status.NE).toEqual(["eliminated", "SB"]);
    expect(status.LAR).toEqual(["eliminated", "CONF"]);
    expect(status.DEN).toEqual(["eliminated", "CONF"]);
    expect(status.BUF).toEqual(["eliminated", "DIV"]);
    expect((await rounds()).map((x) => x.status)).toEqual(["final", "final", "final", "final"]);
    expect(Object.values(status).filter(([st]) => st === "alive")).toEqual([]);
    expect(r.nextPollAt).toBe("2026-02-10T18:00:00.000Z"); // final but not finalized: stat corrections
    // SEA's DST scored its Super Bowl pick-six: points in round 4
    const snap = await snapshot();
    const seaDst = snap.players.find((p) => p.playerId === "DST-SEA")!;
    const sb = snap.points.find(
      (p) => p.gameId === EVENTS.superBowl && p.playerId === seaDst.playerId,
    );
    expect(sb?.round).toBe(4);
    expect(sb?.breakdown.some((b) => b.stat === "def_td")).toBe(true);
    expect((await teamScore(2, 4))?.points).toBeGreaterThan(0);
  });

  it("6. A finalized round is frozen; an override changes the recomputed points", async () => {
    // Finalize round 1, then change its stored stats behind the ingest's back.
    await db.doc.send(
      new PutCommand({
        TableName: db.tableName,
        Item: {
          ...roundKey(s.seasonId, 1),
          type: "Round",
          round: 1,
          code: "WC",
          status: "finalized",
          finalizedAt: "2026-01-20T00:00:00Z",
          finalizedBy: "x",
        },
      }),
    );
    const snap = await snapshot();
    const stafford = await playerId("Matthew Stafford");
    const line = snap.stats.find((x) => x.gameId === EVENTS.golden && x.playerId === stafford)!;
    await db.doc.send(
      new PutCommand({
        TableName: db.tableName,
        Item: {
          ...statsKey(s.seasonId, EVENTS.golden, stafford),
          ...line,
          canonical: { ...line.canonical, pass_yds: 999 },
        },
      }),
    );
    const round1Before = JSON.stringify([
      snap.points.filter((p) => p.round === 1),
      snap.teamScores.filter((t) => t.round === 1),
    ]);
    const res = await recomputeSeason(db, s.seasonId, async () => {}, T("2026-02-11T00:00:00Z"));
    expect(res.changed).toBe(false);
    const after = await snapshot();
    expect(
      JSON.stringify([
        after.points.filter((p) => p.round === 1),
        after.teamScores.filter((t) => t.round === 1),
      ]),
    ).toBe(round1Before);

    // An override on a non-finalized round (SEA's Super Bowl line): a commissioner correction.
    const dst = "DST-SEA";
    const key = overrideKey(s.seasonId, EVENTS.superBowl, dst, "def_pts_allowed");
    const before = after.points.find((p) => p.gameId === EVENTS.superBowl && p.playerId === dst)!;
    await db.doc.send(
      new PutCommand({
        TableName: db.tableName,
        Item: {
          ...key,
          type: "Override",
          gameId: EVENTS.superBowl,
          playerId: dst,
          statKey: "def_pts_allowed",
          value: 0,
          reason: "test",
          byUserId: "u",
          at: "2026-02-11T00:00:00Z",
        },
      }),
    );
    let seen = 0;
    const res2 = await recomputeSeason(
      db,
      s.seasonId,
      async () => {
        seen++;
      },
      T("2026-02-11T00:01:00Z"),
    );
    expect(res2.changed).toBe(true);
    expect(seen).toBe(1);
    const row = (await snapshot()).points.find(
      (p) => p.gameId === EVENTS.superBowl && p.playerId === dst,
    )!;
    expect(row.overridden).toEqual(["def_pts_allowed"]);
    // SEA allowed 13 (the 7-13 band pays 8); 0 allowed pays 15
    expect(row.points).toBe(before.points + 15 - 8);
    const fresh = await snapshot();
    const mine = ["Jason Myers", "Rashid Shaheed"].map(
      (n) => fresh.players.find((p) => p.name === n)!.playerId,
    );
    const roundFour = fresh.points
      .filter((p) => p.round === 4 && [dst, ...mine].includes(p.playerId))
      .reduce((sum, p) => sum + p.points, 0);
    expect((await teamScore(2, 4))?.points).toBeCloseTo(roundFour, 6);
    // an override for a player-game without provider stats scores too
    await db.doc.send(
      new PutCommand({
        TableName: db.tableName,
        Item: {
          ...overrideKey(s.seasonId, EVENTS.superBowl, "DST-NE", "def_safety"),
          type: "Override",
          gameId: EVENTS.superBowl,
          playerId: "DST-NE",
          statKey: "def_safety",
          value: 1,
          reason: "test",
          byUserId: "u",
          at: "2026-02-11T00:00:00Z",
        },
      }),
    );
    await recomputeSeason(db, s.seasonId, async () => {}, T("2026-02-11T00:02:00Z"));
    expect(
      (await snapshot()).points
        .find((p) => p.gameId === EVENTS.superBowl && p.playerId === "DST-NE")
        ?.breakdown.some((b) => b.stat === "def_safety"),
    ).toBe(true);
  });

  it("7. Once every round is finalized and the Super Bowl is final, polling turns off", async () => {
    for (const n of [2, 3, 4])
      await db.doc.send(
        new PutCommand({
          TableName: db.tableName,
          Item: {
            ...roundKey(s.seasonId, n),
            type: "Round",
            round: n,
            code: ["", "WC", "DIV", "CONF", "SB"][n],
            status: "finalized",
          },
        }),
      );
    const before = (await snapshot()).points.length;
    const r = await ingest("2026-02-20T00:00:00Z");
    expect(r.nextPollAt).toBeNull();
    expect((await snapshot()).points.length).toBe(before);
    const state = (await queryPrefix(db, "INGEST", "SEASON#")).find(
      (i) => i.seasonId === s.seasonId,
    );
    expect(state?.nextPollAt).toBeNull();
  });
});

describe("runIngest guards", () => {
  it("refuses to run while another run holds the lease", async () => {
    const other = await createTestSeason(db);
    const mk = (iso: string) =>
      runIngest({ db, seasonId: other.seasonId, now: T(iso), source, publish: async () => {} });
    // no field imported yet: the run fails, records the error and retries in 15 minutes
    await expect(mk("2026-01-01T00:00:00Z")).rejects.toThrow(/playoff field/);
    const state = (await queryPrefix(db, "INGEST", "SEASON#")).find(
      (i) => i.seasonId === other.seasonId,
    );
    expect(state).toMatchObject({
      lastError: "The playoff field has not been imported yet",
      nextPollAt: "2026-01-01T00:15:00.000Z",
      enabled: false,
    });
    expect(state?.leaseUntil).toBeUndefined();
    // a held lease: a second run does nothing
    const { acquireIngestLease } = await import("@dnp/db");
    await acquireIngestLease(db, {
      seasonId: other.seasonId,
      leagueId: other.leagueId,
      year: 2026,
      now: "2026-01-02T00:00:00.000Z",
      ttlMs: 60_000,
    });
    expect(await mk("2026-01-02T00:00:30Z")).toMatchObject({ busy: true });
  });

  it("an unknown season is not found", async () => {
    await expect(
      runIngest({ db, seasonId: "nope", now: new Date(), source, publish: async () => {} }),
    ).rejects.toThrow(/Season not found/);
  });
});
