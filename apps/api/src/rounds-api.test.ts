import { PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  apiError,
  gameLinesResponse,
  ingestResponse,
  standingsResponse,
  type ScoresUpdatedEvent,
} from "@dnp/contract";
import {
  importPool,
  queryPrefix,
  roundKey,
  seasonPk,
  teamScoreKey,
  type Dynamo,
  type PoolPlayerInput,
} from "@dnp/db";
import { createTestDynamo } from "@dnp/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import { createApp } from "./http/app";
import {
  EVENTS,
  allScoreboards,
  parseEspnStandings,
  standingsJson,
  summary,
} from "./providers/espn-fixtures";
import type { LiveSource } from "./providers";
import type { ChannelEvent } from "./realtime/types";
import { runIngest } from "./scoring/ingest";
import { createTestSeason, putRosterEntry } from "./testing/league";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let db: Dynamo;
beforeAll(async () => {
  db = await createTestDynamo("api-rounds");
});

const NOW = "2026-01-12T12:00:00.000Z";
const source: LiveSource = {
  async fetchRoundGames() {
    return allScoreboards().map(({ round, games }) => ({
      round,
      games: games.filter((g) => g.gameId === EVENTS.golden),
    }));
  },
  async fetchSummary(id) {
    return summary(id);
  },
};

async function setup() {
  const t = await createTestSeason(db, { managers: 3 });
  const events: ScoresUpdatedEvent[] = [];
  const app = createApp({
    config: loadConfig({}),
    db,
    now: () => new Date(NOW),
    liveSource: source,
    publisher: {
      async publish(_c: string, e: ChannelEvent) {
        if (e.type === "scores_updated") events.push(e);
      },
    },
  });
  const call = async (as: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api${path}`, {
      method,
      headers: { "x-dev-user-email": as, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : null) as Json };
  };
  const member = `mgr-${t.seasonId.toLowerCase()}@local.test`;
  await call(t.commissionerEmail, "POST", `/seasons/${t.seasonId}/managers`, {
    firstName: "Sekrit",
    lastName: "Person",
    email: member,
  });
  await call(member, "GET", "/me");
  const g = summary(EVENTS.golden);
  const players: PoolPlayerInput[] = g.athletes.map((a) => ({
    providerPlayerId: `espn:${a.id}`,
    espnId: a.id,
    name: a.name,
    position: a.stats.kicking ? "K" : a.stats.passing ? "QB" : a.stats.receiving ? "WR" : "RB",
    nflTeam: a.teamId === g.home.id ? g.home.abbr : g.away.abbr,
    injuryStatus: null,
  }));
  await importPool(db, {
    seasonId: t.seasonId,
    seasonYear: 2025,
    source: "test",
    teams: parseEspnStandings(standingsJson()),
    players,
    actorUserId: null,
    now: NOW,
  });
  await runIngest({
    db,
    seasonId: t.seasonId,
    now: new Date(NOW),
    source,
    publish: async () => {},
  });
  const sid = t.seasonId;
  const as = (who: string) => ({
    get: (p: string) => call(who, "GET", `/seasons/${sid}${p}`),
    post: (p: string, b?: unknown) => call(who, "POST", `/seasons/${sid}${p}`, b),
    put: (p: string, b?: unknown) => call(who, "PUT", `/seasons/${sid}${p}`, b),
    del: (p: string) => call(who, "DELETE", `/seasons/${sid}${p}`),
  });
  const audits = async () =>
    (await queryPrefix(db, seasonPk(sid), "AUDIT#")).filter((a) =>
      /^(override|round)\./.test(String(a.action)),
    );
  const pid = async (name: string) =>
    String(
      (await queryPrefix(db, seasonPk(sid), "PLAYER#")).find((p) => p.name === name)?.playerId,
    );
  return {
    ...t,
    member,
    call,
    events,
    audits,
    pid,
    boss: as(t.commissionerEmail),
    mgr: as(member),
    stranger: as("stranger@local.test"),
  };
}
const GOLDEN = EVENTS.golden;

describe("authorization", () => {
  it("every commissioner route is 403 for a manager and a stranger; unknown seasons are 404", async () => {
    const s = await setup();
    const stafford = await s.pid("Matthew Stafford");
    for (const who of [s.mgr, s.stranger]) {
      const results = await Promise.all([
        who.get(`/games/${GOLDEN}/lines`),
        who.put("/overrides", {
          gameId: GOLDEN,
          playerId: stafford,
          statKey: "pass_yds",
          value: 1,
          reason: "r",
        }),
        who.del(`/overrides/${GOLDEN}/${stafford}/pass_yds`),
        who.post("/rounds/1/finalize"),
        who.post("/rounds/1/unfreeze", { reason: "r" }),
      ]);
      expect(results.map((r) => r.status)).toEqual([403, 403, 403, 403, 403]);
    }
    expect((await s.stranger.get("/standings")).status).toBe(403);
    expect((await s.mgr.get("/standings")).status).toBe(200);
    expect((await s.boss.get("/standings")).status).toBe(200);
    expect((await s.boss.get("/games/nope/lines")).status).toBe(404);
    expect((await s.call(s.commissionerEmail, "GET", "/seasons/nope/standings")).status).toBe(404);
    expect(await s.audits()).toEqual([]);
  });
});

describe("GET /games/:gameId/lines", () => {
  it("lists players with stats (or overrides) and both DSTs, DSTs last, points descending, no PII", async () => {
    const s = await setup();
    const res = await s.boss.get(`/games/${GOLDEN}/lines`);
    expect(res.status).toBe(200);
    const body = gameLinesResponse.parse(res.json);
    expect(body.game).toEqual({
      gameId: GOLDEN,
      round: 1,
      roundStatus: "live",
      home: "CAR",
      away: "LAR",
      homeScore: 31,
      awayScore: 34,
      status: "final",
    });
    const names = body.lines.map((l) => l.name);
    expect(names).toContain("Matthew Stafford");
    const dst = body.lines.filter((l) => l.position === "DST").map((l) => l.nflTeam);
    expect(dst.sort()).toEqual(["CAR", "LAR"]);
    const firstDst = body.lines.findIndex((l) => l.position === "DST");
    expect(body.lines.slice(firstDst).every((l) => l.position === "DST")).toBe(true);
    const skill = body.lines.slice(0, firstDst);
    expect(skill.map((l) => l.points)).toEqual(
      [...skill.map((l) => l.points)].sort((a, b) => (b ?? 0) - (a ?? 0)),
    );
    const stafford = body.lines.find((l) => l.name === "Matthew Stafford")!;
    expect(stafford).toMatchObject({ nflTeam: "LAR", position: "QB", overrides: [] });
    expect(stafford.provider?.counts.pass_yds).toBe(304);
    expect(stafford.effective).toEqual(stafford.provider);
    expect(stafford.points).toBeGreaterThan(0);
    expect(stafford.breakdown.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.json)).not.toMatch(/Sekrit|@local\.test|byUserId/);
    expect(JSON.stringify(res.json)).not.toContain(s.commissionerId);
  });
});

describe("PUT /overrides and DELETE /overrides/…", () => {
  it("sets, replaces and clears an override; each is audited and broadcasts scores_updated", async () => {
    const s = await setup();
    const stafford = await s.pid("Matthew Stafford");
    const put = (value: number, reason = "Scorer's correction") =>
      s.boss.put("/overrides", {
        gameId: GOLDEN,
        playerId: stafford,
        statKey: "pass_yds",
        value,
        reason,
      });
    const before = gameLinesResponse
      .parse((await s.boss.get(`/games/${GOLDEN}/lines`)).json)
      .lines.find((l) => l.playerId === stafford)!;
    const sent = s.events.length;
    const res = await put(334);
    expect(res.status).toBe(200);
    const after = gameLinesResponse.parse(res.json).lines.find((l) => l.playerId === stafford)!;
    expect(after.overrides).toMatchObject([{ statKey: "pass_yds", value: 334 }]);
    expect(after.effective.counts.pass_yds).toBe(334);
    expect(after.provider?.counts.pass_yds).toBe(304);
    expect(after.points).toBeCloseTo((before.points ?? 0) + 1, 5); // 30 yds = 1 point
    expect(s.events.length).toBeGreaterThan(sent);
    // replace it: the audit "from" is the previous effective value
    expect((await put(364, "Second correction")).status).toBe(200);
    expect((await put(364, "Second correction")).status).toBe(200);
    const del = await s.boss.del(`/overrides/${GOLDEN}/${stafford}/pass_yds`);
    expect(del.status).toBe(200);
    const cleared = gameLinesResponse.parse(del.json).lines.find((l) => l.playerId === stafford)!;
    expect(cleared.overrides).toEqual([]);
    expect(cleared.points).toBe(before.points);
    const audits = (await s.audits()).map((a) => [a.action, a.actorUserId, a.details]);
    expect(audits.filter((a) => a[0] === "override.set")).toHaveLength(3);
    const sets = (await s.audits()).filter((a) => a.action === "override.set");
    const froms = sets.map((a) => (a.details as Json).from).sort();
    expect(froms).toEqual([304, 334, 364]);
    expect(audits.find((a) => a[0] === "override.clear")).toEqual([
      "override.clear",
      s.commissionerId,
      { gameId: GOLDEN, playerId: stafford, statKey: "pass_yds", from: 364 },
    ]);
    expect((await s.boss.del(`/overrides/${GOLDEN}/${stafford}/pass_yds`)).status).toBe(404);
    expect((await s.boss.del(`/overrides/nope/${stafford}/pass_yds`)).status).toBe(404);
  });

  it("scores an override for a DST without provider stats", async () => {
    const s = await setup();
    const res = await s.boss.put("/overrides", {
      gameId: GOLDEN,
      playerId: "DST-LAR",
      statKey: "def_pts_allowed",
      value: 0,
      reason: "Pick-six removed",
    });
    expect(res.status).toBe(200);
    const line = gameLinesResponse.parse(res.json).lines.find((l) => l.playerId === "DST-LAR")!;
    expect(line.effective.counts.def_pts_allowed).toBe(0);
    expect(line.overrides).toHaveLength(1);
  });

  it("validates the request", async () => {
    const s = await setup();
    const stafford = await s.pid("Matthew Stafford");
    const ok = { gameId: GOLDEN, playerId: stafford, statKey: "pass_yds", value: 10, reason: "r" };
    const bad = async (patch: Json, status: number, code: string, msg?: RegExp) => {
      const res = await s.boss.put("/overrides", { ...ok, ...patch });
      expect(res.status, JSON.stringify(patch)).toBe(status);
      const err = apiError.parse(res.json).error;
      expect(err.code).toBe(code);
      if (msg) expect(err.message).toMatch(msg);
    };
    await bad({ statKey: "two_pt" }, 400, "validation_error", /not a stat key/);
    await bad({ value: -1 }, 400, "validation_error");
    await bad({ value: 1.5 }, 400, "validation_error");
    await bad({ value: "7" }, 400, "validation_error");
    await bad({ reason: "   " }, 400, "validation_error", /reason is required/);
    await bad({ reason: "x".repeat(201) }, 400, "validation_error");
    await bad({ playerId: "nobody" }, 400, "validation_error", /not in the pool/);
    await bad({ playerId: "DST-SEA" }, 400, "validation_error", /not in the pool|teams/);
    await bad({ gameId: "nope" }, 404, "not_found");
    expect((await s.boss.put("/overrides", "nonsense")).status).toBe(400);
    expect(await s.audits()).toEqual([]);
    // a reason is trimmed; a def_pts_allowed of any non-negative whole number is fine
    const trimmed = await s.boss.put("/overrides", { ...ok, reason: "  fixed  " });
    expect(trimmed.status).toBe(200);
    expect(gameLinesResponse.parse(trimmed.json).lines[0]).toBeDefined();
    expect(((await s.audits())[0]!.details as Json).reason).toBe("fixed");
  });

  it("applies the field-goal distance rule: lowering keeps the first N, raising is rejected", async () => {
    const s = await setup();
    const kicker = await s.pid("Harrison Mevis");
    const lines = gameLinesResponse.parse((await s.boss.get(`/games/${GOLDEN}/lines`)).json);
    const line = lines.lines.find((l) => l.playerId === kicker)!;
    const n = line.provider?.counts.fg_made ?? 0;
    expect(n).toBeGreaterThan(0);
    expect(line.provider?.events?.fg_made).toHaveLength(n);
    const put = (value: number) =>
      s.boss.put("/overrides", {
        gameId: GOLDEN,
        playerId: kicker,
        statKey: "fg_made",
        value,
        reason: "fix",
      });
    const high = await put(n + 1);
    expect(high.status).toBe(400);
    expect(apiError.parse(high.json).error.message).toContain(
      `exceeds the ${n} recorded distances`,
    );
    expect(await s.audits()).toEqual([]);
    const low = await put(n - 1);
    expect(low.status).toBe(200);
    const after = gameLinesResponse.parse(low.json).lines.find((l) => l.playerId === kicker)!;
    expect(after.effective.counts.fg_made).toBe(n - 1);
    expect(after.effective.events?.fg_made).toEqual(
      line.provider?.events?.fg_made?.slice(0, n - 1),
    );
    expect(after.issue).toBeUndefined();
  });

  it("is 409 round_finalized on a finalized round (set and clear), and nothing is written", async () => {
    const s = await setup();
    const stafford = await s.pid("Matthew Stafford");
    expect(
      (
        await s.boss.put("/overrides", {
          gameId: GOLDEN,
          playerId: stafford,
          statKey: "pass_yds",
          value: 5,
          reason: "before",
        })
      ).status,
    ).toBe(200);
    await db.doc.send(
      new PutCommand({
        TableName: db.tableName,
        Item: {
          ...roundKey(s.seasonId, 1),
          type: "Round",
          round: 1,
          code: "WC",
          status: "finalized",
          finalizedAt: NOW,
          finalizedBy: "x",
        },
      }),
    );
    const put = await s.boss.put("/overrides", {
      gameId: GOLDEN,
      playerId: stafford,
      statKey: "pass_yds",
      value: 6,
      reason: "after",
    });
    expect(put.status).toBe(409);
    expect(apiError.parse(put.json).error).toMatchObject({
      code: "round_finalized",
      message: expect.stringContaining("Unfreeze the round first"),
    });
    const del = await s.boss.del(`/overrides/${GOLDEN}/${stafford}/pass_yds`);
    expect(del.status).toBe(409);
    expect(await s.audits()).toHaveLength(1);
  });
});

describe("finalize and unfreeze guards", () => {
  it("finalize needs a final round; unfreeze needs a finalized one and a reason", async () => {
    const s = await setup();
    // one of six Wild Card games listed: the round is live, not final
    const early = await s.boss.post("/rounds/1/finalize");
    expect(early.status).toBe(409);
    expect(apiError.parse(early.json).error.code).toBe("round_not_final");
    expect((await s.boss.post("/rounds/9/finalize")).status).toBe(404);
    expect((await s.boss.post("/rounds/x/unfreeze", { reason: "r" })).status).toBe(404);
    const notFrozen = await s.boss.post("/rounds/1/unfreeze", { reason: "r" });
    expect(notFrozen.status).toBe(409);
    expect(apiError.parse(notFrozen.json).error.code).toBe("round_not_finalized");
    expect((await s.boss.post("/rounds/1/unfreeze", {})).status).toBe(400);
    expect((await s.boss.post("/rounds/1/unfreeze", { reason: "x".repeat(201) })).status).toBe(400);
    expect(await s.audits()).toEqual([]);
    const view = ingestResponse.parse((await s.boss.get("/ingest")).json);
    expect(view.rounds[0]).toMatchObject({
      overrideCount: 0,
      finalizedAt: null,
      providerChangedAt: null,
    });
  });
});

describe("GET /standings", () => {
  const putScore = (seasonId: string, round: number, teamId: string, points: number) =>
    db.doc.send(
      new PutCommand({
        TableName: db.tableName,
        Item: {
          ...teamScoreKey(seasonId, round, teamId),
          type: "TeamScore",
          round,
          teamId,
          points,
          provisional: round > 1,
          computedAt: NOW,
        },
      }),
    );
  const putRound = (seasonId: string, round: number, status: string) =>
    db.doc.send(
      new PutCommand({
        TableName: db.tableName,
        Item: {
          ...roundKey(seasonId, round),
          type: "Round",
          round,
          code: ["WC", "DIV", "CONF", "SB"][round - 1],
          status,
        },
      }),
    );

  it("lists every team with zero totals before anything is scored", async () => {
    const s = await setup();
    const res = await s.mgr.get("/standings");
    const body = standingsResponse.parse(res.json);
    expect(body.rounds.map((r) => [r.code, r.status])).toEqual([
      ["WC", "live"],
      ["DIV", "upcoming"],
      ["CONF", "upcoming"],
      ["SB", "upcoming"],
    ]);
    expect(body.rows).toHaveLength(4);
    expect(body.asOf).toBe(1);
    expect(body.placings).toBeNull();
    expect(body.rows.every((r) => r.rank === 1 && r.tied)).toBe(true);
    // sorted by name when ranks tie
    expect(body.rows.map((r) => r.teamName)).toEqual(
      [...body.rows.map((r) => r.teamName)].sort((a, b) => a.localeCompare(b)),
    );
    // rounds that have not started show no score
    expect(body.rows[0]!.rounds.map((r) => r.points)).toEqual([0, null, null, null]);
  });

  it("ranks by total, shares ranks on ties, marks provisional rounds and shows placings only once the Super Bowl is finalized", async () => {
    const s = await setup();
    const t = [...s.teamIds];
    const mine = (await s.mgr.get("")).json.myTeamId as string;
    const [a, b, c] = t as [string, string, string];
    const stafford = await s.pid("Matthew Stafford");
    await putRosterEntry(db, s.seasonId, { teamId: a, slot: "QB", playerId: stafford });
    await putRosterEntry(db, s.seasonId, { teamId: a, slot: "WR1", playerId: "DST-SEA" });
    for (const [team, round, pts] of [
      [a, 1, 50],
      [a, 2, 5],
      [b, 1, 60],
      [c, 1, 60],
      [mine, 1, 40],
    ] as const)
      await putScore(s.seasonId, round, team, pts);
    await putRound(s.seasonId, 1, "finalized");
    await putRound(s.seasonId, 2, "live");
    const res = await s.mgr.get("/standings");
    const body = standingsResponse.parse(res.json);
    expect(body.asOf).toBe(2);
    expect(body.rows.map((r) => [r.rank, r.tied, r.total])).toEqual([
      [1, true, 60],
      [1, true, 60],
      [3, false, 55],
      [4, false, 40],
    ]);
    expect(new Set(body.rows.slice(0, 2).map((r) => r.teamId))).toEqual(new Set([b, c]));
    expect(body.rows[2]!.teamId).toBe(a);
    expect(body.rows[3]!.teamId).toBe(mine);
    const rowA = body.rows.find((r) => r.teamId === a)!;
    expect(rowA.rounds).toEqual([
      { round: 1, points: 50, provisional: false },
      { round: 2, points: 5, provisional: true },
      { round: 3, points: null, provisional: false },
      { round: 4, points: null, provisional: false },
    ]);
    expect(rowA).toMatchObject({ playersTotal: 2, playersAlive: expect.any(Number) });
    expect(rowA.maxGamesRemaining).toBeGreaterThanOrEqual(0);
    expect(body.placings).toBeNull();
    // the Super Bowl is final but not finalized: still no placings
    await putRound(s.seasonId, 4, "final");
    expect(standingsResponse.parse((await s.mgr.get("/standings")).json).placings).toBeNull();
    await putRound(s.seasonId, 4, "finalized");
    const done = standingsResponse.parse((await s.mgr.get("/standings")).json);
    expect(done.placings).toEqual([
      { place: 1, teamId: expect.any(String) },
      { place: 1, teamId: expect.any(String) },
      { place: 3, teamId: a },
    ]);
    expect(new Set(done.placings!.slice(0, 2).map((p) => p.teamId))).toEqual(new Set([b, c]));
    // no user ids, names or emails
    const text = JSON.stringify(res.json);
    expect(text).not.toMatch(/Sekrit|@local\.test|managerUserId|byUserId/);
    expect(text).not.toContain(s.commissionerId);
  });
});
