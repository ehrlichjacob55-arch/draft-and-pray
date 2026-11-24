/**
 * Task 10 acceptance (docs/design/07 §4): an override survives re-ingest; a finalized round is
 * frozen. The recorded Wild Card weekend is ingested into DynamoDB Local, the commissioner works
 * through the HTTP API, and the provider's data is changed behind her back.
 */
import {
  importPool,
  loadSeason,
  queryPrefix,
  seasonPk,
  type Dynamo,
  type PoolPlayerInput,
} from "@dnp/db";
import { createTestDynamo } from "@dnp/db/testing";
import type { Slot } from "@dnp/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import { createApp } from "./http/app";
import {
  allScoreboards,
  parseEspnStandings,
  standingsJson,
  summary,
} from "./providers/espn-fixtures";
import type { LiveSource } from "./providers";
import type { ParsedSummary } from "./providers/espn-boxscore";
import { runIngest } from "./scoring/ingest";
import { createTestSeason, putRosterEntry, type TestSeason } from "./testing/league";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const WC_EVENTS = ["401772976", "401772977", "401772978", "401772979", "401772980", "401772981"];
const GOLDEN = "401772979"; // LAR @ CAR

let db: Dynamo;
let s: TestSeason;
let now = new Date("2026-01-12T12:00:00Z");
const published: string[] = [];

/** Edits applied to the provider's box score, by athlete name -> category -> field. */
let tweaks: Record<string, Record<string, Record<string, string>>> = {};
const source: LiveSource = {
  async fetchRoundGames() {
    return allScoreboards().map(({ round, games }) => ({ round, games: round === 1 ? games : [] }));
  },
  async fetchSummary(id) {
    const sum: ParsedSummary = structuredClone(summary(id));
    for (const a of sum.athletes)
      for (const [cat, fields] of Object.entries(tweaks[a.name] ?? {}))
        Object.assign((a.stats as Record<string, Record<string, string>>)[cat] ?? {}, fields);
    return sum;
  },
};

const app = () =>
  createApp({
    config: loadConfig({}),
    db,
    now: () => now,
    liveSource: source,
    publisher: {
      async publish(_c, e) {
        if (e.type === "scores_updated") published.push(e.at);
      },
    },
  });
let api: ReturnType<typeof app>;
const call = async (method: string, path: string, body?: unknown, as = s.commissionerEmail) => {
  const res = await api.request(`/api/seasons/${s.seasonId}${path}`, {
    method,
    headers: { "x-dev-user-email": as, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Json };
};
const ingest = (iso: string) => {
  now = new Date(iso);
  return runIngest({ db, seasonId: s.seasonId, now, source, publish: async () => {} });
};
const snapshot = () => loadSeason(db, s.seasonId, { consistentRead: true });
const playerId = async (name: string) =>
  (await snapshot()).players.find((p) => p.name === name)!.playerId;
/** The frozen part of a round: its POINTS and TEAMSCORE items, exactly as stored. */
const round1 = async () => {
  const snap = await snapshot();
  return JSON.stringify([
    snap.points.filter((p) => p.round === 1).sort((a, b) => a.sk.localeCompare(b.sk)),
    snap.teamScores.filter((t) => t.round === 1).sort((a, b) => a.sk.localeCompare(b.sk)),
  ]);
};
const hubbardPoints = async () =>
  (await snapshot()).points.find((p) => p.gameId === GOLDEN && p.playerId === hubbard)!.points;
const auditActions = async () =>
  (await queryPrefix(db, seasonPk(s.seasonId), "AUDIT#")).map((a) => String(a.action));
let hubbard: string;

beforeAll(async () => {
  db = await createTestDynamo("overrides-acceptance");
  s = await createTestSeason(db);
  api = app();
  const byId = new Map<string, PoolPlayerInput>();
  for (const ev of WC_EVENTS) {
    const sum = summary(ev);
    for (const a of sum.athletes)
      byId.set(a.id, {
        providerPlayerId: `espn:${a.id}`,
        espnId: a.id,
        name: a.name,
        position: a.stats.kicking ? "K" : a.stats.passing ? "QB" : a.stats.receiving ? "WR" : "RB",
        nflTeam: a.teamId === sum.home.id ? sum.home.abbr : sum.away.abbr,
        injuryStatus: null,
      });
  }
  await importPool(db, {
    seasonId: s.seasonId,
    seasonYear: 2025,
    source: "test",
    teams: parseEspnStandings(standingsJson()),
    players: [...byId.values()],
    actorUserId: null,
    now: "2026-01-01T00:00:00.000Z",
  });
  hubbard = await playerId("Chuba Hubbard");
  const roster = async (teamId: string, picks: [Slot, string][]) => {
    for (const [slot, name] of picks)
      await putRosterEntry(db, s.seasonId, { teamId, slot, playerId: await playerId(name) });
  };
  await roster(s.teamIds[0]!, [
    ["QB", "Matthew Stafford"],
    ["WR1", "Puka Nacua"],
  ]);
  await roster(s.teamIds[1]!, [
    ["QB", "Bryce Young"],
    ["RB1", "Chuba Hubbard"],
  ]);
});

describe("overrides survive a re-ingest and a finalized round is frozen", () => {
  let hubbardBefore = 0;
  let frozen = "";

  it("1. ingests the final Wild Card round", async () => {
    await ingest("2026-01-12T12:00:00Z");
    const snap = await snapshot();
    expect(snap.rounds.find((r) => r.round === 1)?.status).toBe("final");
    hubbardBefore = await hubbardPoints();
    expect(hubbardBefore).toBeGreaterThan(0);
  });

  it("2. an override changes the points and is audited", async () => {
    const res = await call("PUT", "/overrides", {
      gameId: GOLDEN,
      playerId: hubbard,
      statKey: "rush_td",
      value: 5,
      reason: "  Scorer's table corrected  ",
    });
    expect(res.status).toBe(200);
    const line = res.json.lines.find((l: Json) => l.playerId === hubbard);
    expect(line.provider.counts.rush_td).toBe(2);
    expect(line.effective.counts.rush_td).toBe(5);
    expect(line.overrides).toMatchObject([
      { statKey: "rush_td", value: 5, reason: "Scorer's table corrected" },
    ]);
    // 3 more rushing touchdowns at 6 points each
    expect(await hubbardPoints()).toBe(hubbardBefore + 18);
    expect(line.points).toBe(hubbardBefore + 18);
    const audits = (await queryPrefix(db, seasonPk(s.seasonId), "AUDIT#")).filter(
      (a) => a.action === "override.set",
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: s.commissionerId,
      details: {
        gameId: GOLDEN,
        playerId: hubbard,
        statKey: "rush_td",
        from: 2,
        to: 5,
        reason: "Scorer's table corrected",
      },
    });
    expect(published.length).toBeGreaterThan(0);
  });

  it("3. a re-ingest of identical data keeps the override and writes nothing", async () => {
    const before = JSON.stringify(
      await queryPrefix(db, seasonPk(s.seasonId), undefined, { consistentRead: true }),
    );
    const r = await ingest("2026-01-12T12:01:00Z");
    expect(r.summary).toMatchObject({ changedStatLines: 0, pointsWritten: 0 });
    expect(
      JSON.stringify(
        await queryPrefix(db, seasonPk(s.seasonId), undefined, { consistentRead: true }),
      ),
    ).toBe(before);
  });

  it("4. a re-ingest of changed provider data keeps the override applied", async () => {
    tweaks = {
      "Chuba Hubbard": { rushing: { rushingTouchdowns: "1", rushingYards: "56" } },
    };
    const r = await ingest("2026-01-12T19:00:00Z"); // 7 hours later: final games are re-fetched
    expect(r.summary?.changedStatLines).toBeGreaterThan(0);
    const snap = await snapshot();
    expect(snap.overrides.map((o) => [o.statKey, o.value])).toEqual([["rush_td", 5]]);
    const stored = snap.stats.find((x) => x.gameId === GOLDEN && x.playerId === hubbard)!;
    expect(stored.canonical.rush_td).toBe(1); // the provider's new value is kept as raw stats
    expect(stored.canonical.rush_yds).toBe(56);
    // ten more rushing yards (+1.0) on top of the overridden touchdowns
    expect(await hubbardPoints()).toBe(hubbardBefore + 18 + 1);
    const lines = await call("GET", `/games/${GOLDEN}/lines`);
    const line = lines.json.lines.find((l: Json) => l.playerId === hubbard);
    expect(line.provider.counts.rush_td).toBe(1);
    expect(line.effective.counts.rush_td).toBe(5);
    expect(line.overrides).toHaveLength(1);
  });

  it("5. finalizing freezes the round and its scores stop being provisional", async () => {
    expect((await call("POST", "/rounds/2/finalize")).json.error.code).toBe("round_not_final");
    const res = await call("POST", "/rounds/1/finalize");
    expect(res.status).toBe(200);
    const wc = res.json.rounds.find((r: Json) => r.round === 1);
    expect(wc).toMatchObject({ status: "finalized", overrideCount: 1, providerChangedAt: null });
    expect(wc.finalizedAt).toBe("2026-01-12T19:00:00.000Z");
    const snap = await snapshot();
    const scores = snap.teamScores.filter((t) => t.round === 1);
    expect(scores).toHaveLength(9);
    expect(scores.every((t) => !t.provisional)).toBe(true);
    const audit = (await queryPrefix(db, seasonPk(s.seasonId), "AUDIT#")).find(
      (a) => a.action === "round.finalize",
    );
    expect(audit?.details).toMatchObject({
      round: 1,
      teamScores: Object.fromEntries(scores.map((t) => [t.teamId, t.points])),
    });
    frozen = await round1();
    expect((await call("POST", "/rounds/1/finalize")).json.error.code).toBe("round_finalized");
  });

  it("6. provider changes after finalization are kept as raw stats, flagged, and move no points", async () => {
    tweaks = {
      "Chuba Hubbard": { rushing: { rushingTouchdowns: "0", rushingYards: "99" } },
      "Matthew Stafford": { passing: { passingYards: "400" } },
    };
    await ingest("2026-01-13T02:00:00Z");
    const snap = await snapshot();
    expect(
      snap.stats.find((x) => x.gameId === GOLDEN && x.playerId === hubbard)?.canonical,
    ).toMatchObject({ rush_yds: 99 });
    expect(snap.rounds.find((r) => r.round === 1)).toMatchObject({
      status: "finalized",
      providerChangedAt: "2026-01-13T02:00:00.000Z",
    });
    expect(await round1()).toBe(frozen);
    // an override cannot be set, changed or cleared on a frozen round
    const put = await call("PUT", "/overrides", {
      gameId: GOLDEN,
      playerId: hubbard,
      statKey: "rush_yds",
      value: 10,
      reason: "x",
    });
    expect(put.status).toBe(409);
    expect(put.json.error).toMatchObject({ code: "round_finalized" });
    expect(put.json.error.message).toContain("Unfreeze the round first");
    const del = await call("DELETE", `/overrides/${GOLDEN}/${hubbard}/rush_td`);
    expect(del.status).toBe(409);
    expect(await round1()).toBe(frozen);
    expect((await call("GET", "/ingest")).json.rounds[0].providerChangedAt).toBe(
      "2026-01-13T02:00:00.000Z",
    );
  });

  it("7. unfreezing lets the next recompute pick up the new stats; finalizing again freezes them", async () => {
    expect((await call("POST", "/rounds/1/unfreeze", { reason: "" })).status).toBe(400);
    const res = await call("POST", "/rounds/1/unfreeze", {
      reason: "ESPN corrected the box score",
    });
    expect(res.status).toBe(200);
    expect(res.json.rounds[0]).toMatchObject({
      status: "final",
      finalizedAt: null,
      providerChangedAt: null,
    });
    const snap = await snapshot();
    expect(snap.teamScores.filter((t) => t.round === 1).every((t) => t.provisional)).toBe(true);
    // yards 99 (+4.3 over 56... fractional 1 per 10) with the touchdown override still on top
    expect(await hubbardPoints()).toBeCloseTo(hubbardBefore + 18 + 1 + 4.3, 5);
    expect(await round1()).not.toBe(frozen);
    const again = await call("POST", "/rounds/1/finalize");
    expect(again.status).toBe(200);
    expect(
      (await snapshot()).teamScores.filter((t) => t.round === 1).every((t) => !t.provisional),
    ).toBe(true);
    expect((await call("POST", "/rounds/1/unfreeze", { reason: "nothing" })).status).toBe(200);
    expect((await call("POST", "/rounds/1/unfreeze", { reason: "again" })).json.error.code).toBe(
      "round_not_finalized",
    );
    expect(await auditActions()).toEqual(
      expect.arrayContaining(["override.set", "round.finalize", "round.unfreeze"]),
    );
    const actions = await auditActions();
    expect(actions.filter((a) => a === "round.finalize")).toHaveLength(2);
    expect(actions.filter((a) => a === "round.unfreeze")).toHaveLength(2);
  });

  it("8. clearing the override restores the provider's value", async () => {
    const res = await call("DELETE", `/overrides/${GOLDEN}/${hubbard}/rush_td`);
    expect(res.status).toBe(200);
    const line = res.json.lines.find((l: Json) => l.playerId === hubbard);
    expect(line.overrides).toEqual([]);
    expect(line.effective.counts.rush_td).toBeUndefined(); // the provider now reports none
    expect(
      (await queryPrefix(db, seasonPk(s.seasonId), "AUDIT#")).some(
        (a) => a.action === "override.clear" && (a.details as Json).from === 5,
      ),
    ).toBe(true);
    expect((await snapshot()).overrides).toEqual([]);
    expect((await call("DELETE", `/overrides/${GOLDEN}/${hubbard}/rush_td`)).status).toBe(404);
  });
});
