import { ingestResponse, apiError, type ScoresUpdatedEvent } from "@dnp/contract";
import {
  acquireIngestLease,
  importPool,
  queryPrefix,
  seasonPk,
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
import { PoolSourceError, type LiveSource } from "./providers";
import type { ChannelEvent } from "./realtime/types";
import { runDueIngests } from "./scoring/job";
import { createTestSeason } from "./testing/league";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let db: Dynamo;
beforeAll(async () => {
  db = await createTestDynamo("api-ingest");
});

const NOW = "2026-01-12T12:00:00.000Z";
const goldenOnly = (): LiveSource & { failWith?: Error; calls: number } => ({
  calls: 0,
  failWith: undefined,
  async fetchRoundGames() {
    if (this.failWith) throw this.failWith;
    return allScoreboards().map(({ round, games }) => ({
      round,
      games: games.filter((g) => g.gameId === EVENTS.golden),
    }));
  },
  async fetchSummary(id) {
    this.calls++;
    return summary(id);
  },
});

async function setup(opts: { member?: boolean } = {}) {
  const t = await createTestSeason(db, { managers: 0 });
  const events: ScoresUpdatedEvent[] = [];
  const source = goldenOnly();
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
  if (opts.member !== false) {
    await call(t.commissionerEmail, "POST", `/seasons/${t.seasonId}/managers`, {
      firstName: "Sekrit",
      lastName: "Person",
      email: member,
    });
    await call(member, "GET", "/me");
  }
  // The golden game's pool: its real athletes, matched by ESPN id.
  const s = summary(EVENTS.golden);
  const players: PoolPlayerInput[] = s.athletes.map((a) => ({
    providerPlayerId: `espn:${a.id}`,
    espnId: a.id,
    name: a.name,
    position: a.stats.kicking ? "K" : a.stats.passing ? "QB" : a.stats.receiving ? "WR" : "RB",
    nflTeam: a.teamId === s.home.id ? s.home.abbr : s.away.abbr,
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
  const audits = async () =>
    (await queryPrefix(db, seasonPk(t.seasonId), "AUDIT#"))
      .map((a) => String(a.action))
      .filter((a) => a.startsWith("ingest."))
      .sort();
  return { ...t, member, call, events, source, audits, base: `/seasons/${t.seasonId}/ingest` };
}

describe("GET /seasons/:id/ingest", () => {
  it("is commissioner-only and reports an untouched season as off", async () => {
    const s = await setup();
    expect((await s.call(s.member, "GET", s.base)).status).toBe(403);
    expect((await s.call("stranger@local.test", "GET", s.base)).status).toBe(403);
    const res = await s.call(s.commissionerEmail, "GET", s.base);
    expect(res.status).toBe(200);
    expect(ingestResponse.parse(res.json)).toEqual({
      enabled: false,
      nextPollAt: null,
      lastRunAt: null,
      lastSuccessAt: null,
      lastError: null,
      lastSummary: null,
      warnings: [],
      rounds: [],
    });
    expect((await s.call(s.commissionerEmail, "GET", "/seasons/nope/ingest")).status).toBe(404);
  });
});

describe("PUT /seasons/:id/ingest", () => {
  it("turns live stats on and off, audited, for the commissioner only", async () => {
    const s = await setup();
    expect((await s.call(s.member, "PUT", s.base, { enabled: true })).status).toBe(403);
    expect((await s.call(s.commissionerEmail, "PUT", s.base, { enabled: "yes" })).status).toBe(400);
    const on = await s.call(s.commissionerEmail, "PUT", s.base, { enabled: true });
    expect(on.status).toBe(200);
    expect(ingestResponse.parse(on.json)).toMatchObject({ enabled: true, nextPollAt: NOW });
    const off = await s.call(s.commissionerEmail, "PUT", s.base, { enabled: false });
    expect(ingestResponse.parse(off.json)).toMatchObject({ enabled: false, nextPollAt: null });
    expect(await s.audits()).toEqual(["ingest.disable", "ingest.enable"]);
  });
});

describe("POST /seasons/:id/ingest/run", () => {
  it("runs one ingest inline, returns the same body as GET, audits, and broadcasts scores_updated", async () => {
    const s = await setup();
    expect((await s.call(s.member, "POST", `${s.base}/run`)).status).toBe(403);
    const res = await s.call(s.commissionerEmail, "POST", `${s.base}/run`);
    expect(res.status).toBe(200);
    const body = ingestResponse.parse(res.json);
    expect(body).toMatchObject({ lastRunAt: NOW, lastSuccessAt: NOW, lastError: null });
    expect(body.lastSummary).toMatchObject({ games: 1, changedStatLines: expect.any(Number) });
    expect(body.rounds.map((r) => [r.code, r.status, r.games.length])).toEqual([
      ["WC", "live", 1],
      ["DIV", "upcoming", 0],
      ["CONF", "upcoming", 0],
      ["SB", "upcoming", 0],
    ]);
    // 1 of 6 Wild Card games listed (and final): the round waits for the rest, so it is live
    expect(body.rounds[0]!.games[0]).toEqual({
      gameId: EVENTS.golden,
      home: "CAR",
      away: "LAR",
      homeScore: 31,
      awayScore: 34,
      status: "final",
      kickoff: "2026-01-10T21:30:00.000Z",
    });
    expect(await s.audits()).toEqual(["ingest.run"]);
    expect(s.events).toHaveLength(1);
    expect(s.events[0]).toMatchObject({ type: "scores_updated", seasonId: s.seasonId, at: NOW });
    expect(JSON.stringify(res.json)).not.toMatch(/Sekrit|@local\.test/);
    // GET returns the same thing
    expect((await s.call(s.commissionerEmail, "GET", s.base)).json).toEqual(res.json);
    // a second run changes nothing and broadcasts nothing
    const again = await s.call(s.commissionerEmail, "POST", `${s.base}/run`);
    expect(again.status).toBe(200);
    expect(ingestResponse.parse(again.json).lastSummary).toMatchObject({
      changedStatLines: 0,
      pointsWritten: 0,
      teamScoresWritten: 0,
    });
    expect(s.events).toHaveLength(1);
  });

  it("is 409 ingest_busy while another run holds the lease", async () => {
    const s = await setup();
    await acquireIngestLease(db, {
      seasonId: s.seasonId,
      leagueId: s.leagueId,
      year: 2026,
      now: NOW,
      ttlMs: 60_000,
    });
    const res = await s.call(s.commissionerEmail, "POST", `${s.base}/run`);
    expect(res.status).toBe(409);
    expect(apiError.parse(res.json).error.code).toBe("ingest_busy");
    expect(await s.audits()).toEqual([]);
  });

  it("a provider failure is a 200 that carries a short, safe lastError", async () => {
    const s = await setup();
    s.source.failWith = new PoolSourceError("ESPN scoreboard (week 1) could not be reached");
    const res = await s.call(s.commissionerEmail, "POST", `${s.base}/run`);
    expect(res.status).toBe(200);
    expect(ingestResponse.parse(res.json)).toMatchObject({
      lastError: "ESPN scoreboard (week 1) could not be reached",
      lastSuccessAt: null,
      nextPollAt: "2026-01-12T12:15:00.000Z",
    });
    s.source.failWith = new Error("socket hang up to 10.0.0.5 for jane@example.com");
    const other = await s.call(s.commissionerEmail, "POST", `${s.base}/run`);
    expect(ingestResponse.parse(other.json).lastError).toBe(
      "Unexpected error while updating stats",
    );
    expect(await s.audits()).toEqual(["ingest.run", "ingest.run"]);
  });
});

describe("recompute hooks", () => {
  it("changing the active ruleset recomputes the points and broadcasts", async () => {
    const s = await setup();
    await s.call(s.commissionerEmail, "POST", `${s.base}/run`);
    const rows = async () =>
      (await queryPrefix(db, seasonPk(s.seasonId), "POINTS#")) as {
        playerId: string;
        points: number;
      }[];
    const before = await rows();
    expect(before.length).toBeGreaterThan(0);
    const events = s.events.length;
    // v1 (the league rules) is unlocked: double the rushing touchdown value.
    const scoring = await s.call(s.commissionerEmail, "GET", `/seasons/${s.seasonId}/scoring`);
    const rules = (scoring.json.active.rules as Json[]).map((r) =>
      r.stat === "rush_td" ? { ...r, points: 12 } : r,
    );
    const put = await s.call(
      s.commissionerEmail,
      "PUT",
      `/seasons/${s.seasonId}/scoring/versions/1`,
      {
        rules,
        rounding: scoring.json.active.rounding,
      },
    );
    expect(put.status).toBe(200);
    const after = await rows();
    expect(JSON.stringify(after)).not.toBe(JSON.stringify(before));
    expect(s.events.length).toBe(events + 1);
  });
});

describe("runDueIngests (the scheduled job)", () => {
  const lines: string[] = [];
  const clock = (iso: string) => () => new Date(iso);

  it("runs only enabled seasons whose next check is due (30 s slack), one summary line each", async () => {
    const due = await setup();
    const early = await setup();
    const off = await setup();
    await due.call(due.commissionerEmail, "PUT", due.base, { enabled: true }); // due now
    await early.call(early.commissionerEmail, "PUT", early.base, { enabled: true });
    await off.call(off.commissionerEmail, "PUT", off.base, { enabled: true });
    await off.call(off.commissionerEmail, "PUT", off.base, { enabled: false });
    const source = goldenOnly();
    // `early` is due only after a later check: run it once now, which schedules the next one.
    const first = await runDueIngests({
      db,
      now: clock(NOW),
      source,
      publisher: { publish: async () => undefined },
      log: (l) => lines.push(l),
    });
    expect(first.ran).toBeGreaterThanOrEqual(2);
    const state = (id: string) => queryPrefix(db, "INGEST", `SEASON#${id}`).then((r) => r[0]!);
    const next = Date.parse((await state(due.seasonId)).nextPollAt as string);
    expect(next).toBeGreaterThan(Date.parse(NOW));
    // right before the next check (within the slack) it runs again; earlier it does not
    lines.length = 0;
    const tooEarly = await runDueIngests({
      db,
      now: clock(new Date(next - 31_000).toISOString()),
      source,
      publisher: { publish: async () => undefined },
      log: (l) => lines.push(l),
    });
    expect(lines.filter((l) => l.includes(due.seasonId))).toEqual([]);
    expect(tooEarly.ran).toBeLessThan(first.ran + 1);
    const slack = await runDueIngests({
      db,
      now: clock(new Date(next - 29_000).toISOString()),
      source,
      publisher: { publish: async () => undefined },
      log: (l) => lines.push(l),
    });
    expect(slack.ran).toBeGreaterThanOrEqual(1);
    const mine = lines.filter((l) => l.includes(due.seasonId));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatch(
      /^ingest \S+: games=1 statLines=\d+ changed=0 points=0 teamScores=0 warnings=\d+ next=/,
    );
    expect(lines.join("\n")).not.toMatch(/@|Sekrit/);
    // a disabled season is never run
    expect(lines.some((l) => l.includes(off.seasonId))).toBe(false);
  });

  it("counts a busy season and a failing season, and keeps going", async () => {
    const busy = await setup();
    const failing = await setup();
    for (const x of [busy, failing])
      await x.call(x.commissionerEmail, "PUT", x.base, { enabled: true });
    await acquireIngestLease(db, {
      seasonId: busy.seasonId,
      leagueId: busy.leagueId,
      year: 2026,
      now: NOW,
      ttlMs: 60_000,
    });
    const source = goldenOnly();
    source.failWith = new PoolSourceError("down");
    const out: string[] = [];
    const r = await runDueIngests({
      db,
      now: clock(NOW),
      source,
      publisher: { publish: async () => undefined },
      log: (l) => out.push(l),
    });
    expect(r.busy).toBeGreaterThanOrEqual(1);
    expect(r.failed).toBeGreaterThanOrEqual(1);
    expect(out.some((l) => l.includes(busy.seasonId) && /lease/.test(l))).toBe(true);
  });
});
