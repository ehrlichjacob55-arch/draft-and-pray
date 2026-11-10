import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { beforeAll, describe, expect, it } from "vitest";
import {
  apiError,
  draftSnapshot,
  listPlayersResponse,
  realtimeTicketResponse,
  type DraftChangedEvent,
  type DraftSnapshot,
} from "@dnp/contract";
import {
  bootstrapLeague,
  importPool,
  listTeams,
  localSub,
  queryPrefix,
  seasonMetaKey,
  seasonPk,
  seasonPointerKey,
  syntheticPool,
  type Dynamo,
} from "@dnp/db";
import { createTestDynamo } from "@dnp/db/testing";
import { loadConfig } from "./config";
import { createApp } from "./http/app";
import type { Publisher } from "./realtime/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let db: Dynamo;
let nowMs = Date.parse("2026-03-01T00:00:00Z");
let n = 0;

beforeAll(async () => {
  db = await createTestDynamo("api-draft");
});

interface Ctx {
  app: ReturnType<typeof createApp>;
  events: DraftChangedEvent[];
  publisher: { failing: boolean };
  commish: string;
  members: string[]; // members[0] = commissioner (team 1)
  seasonId: string;
  leagueId: string;
  teamIds: string[]; // by member index
  call: (
    as: string,
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<{ status: number; json: Json }>;
  snap: (as: string) => Promise<DraftSnapshot>;
}

async function setupLeague(opts: { pool?: boolean; order?: boolean } = {}): Promise<Ctx> {
  n++;
  const commish = `boss${n}@local.test`;
  const r = await bootstrapLeague(db, {
    userId: localSub(commish),
    email: commish,
    leagueName: `Draft League ${n}`,
    year: 2026,
  });
  const events: DraftChangedEvent[] = [];
  const publisher = { failing: false };
  const pub: Publisher = {
    async publish(_c, e) {
      if (publisher.failing) throw new Error("socket down");
      events.push(e);
    },
  };
  const app = createApp({
    config: loadConfig({}),
    db,
    publisher: pub,
    now: () => new Date(nowMs),
  });
  const call: Ctx["call"] = async (as, method, path, body) => {
    const res = await app.request(`/api${path}`, {
      method,
      headers: { "x-dev-user-email": as, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const members = [commish, ...Array.from({ length: 8 }, (_, i) => `mgr${n}-${i + 1}@local.test`)];
  for (const [i, email] of members.entries()) {
    const add = await call(commish, "POST", `/seasons/${r.seasonId}/managers`, {
      firstName: "Sekrit",
      lastName: `Person${i + 1}`,
      email,
    });
    expect(add.status).toBe(201);
  }
  for (const email of members) await call(email, "GET", "/me");
  const teams = await listTeams(db, r.seasonId);
  const teamIds = members.map((e) => teams.find((t) => t.managerUserId === localSub(e))!.teamId);
  if (opts.pool !== false) {
    const pool = syntheticPool();
    await importPool(db, {
      seasonId: r.seasonId,
      seasonYear: 2025,
      source: "synthetic",
      teams: pool.teams,
      players: pool.players,
      actorUserId: null,
      now: new Date(nowMs).toISOString(),
    });
  }
  const ctx: Ctx = {
    app,
    events,
    publisher,
    commish,
    members,
    seasonId: r.seasonId,
    leagueId: r.leagueId,
    teamIds,
    call,
    snap: async (as) => {
      const res = await call(as, "GET", `/seasons/${r.seasonId}/draft`);
      expect(res.status).toBe(200);
      return draftSnapshot.parse(res.json);
    },
  };
  if (opts.order !== false) {
    const res = await call(commish, "PUT", `/seasons/${r.seasonId}/draft/order`, {
      order: teamIds,
    });
    expect(res.status).toBe(200);
  }
  return ctx;
}

const base = (c: Ctx) => `/seasons/${c.seasonId}/draft`;
const first = (s: DraftSnapshot, position: string, skip = 0) =>
  s.available.filter((p) => p.position === position)[skip]!;
const errCode = (r: { json: Json }) => apiError.parse(r.json).error.code;

describe("order and start preconditions", () => {
  it("blocks start with reason codes, then sets the order and starts", async () => {
    const c = await setupLeague({ pool: false, order: false });
    const early = await c.call(c.commish, "POST", `${base(c)}/start`);
    expect(early.status).toBe(409);
    expect(early.json.error.code).toBe("draft_not_ready");
    expect(early.json.error.reasons).toEqual(["order_incomplete", "pool_empty"]);

    const bad = await c.call(c.commish, "PUT", `${base(c)}/order`, {
      order: [...c.teamIds.slice(0, 8), c.teamIds[0]],
    });
    expect(bad.status).toBe(400);
    const short = await c.call(c.commish, "PUT", `${base(c)}/order`, { order: c.teamIds.slice(1) });
    expect(short.status).toBe(400);
    const unknown = await c.call(c.commish, "PUT", `${base(c)}/order`, {
      order: [...c.teamIds.slice(0, 8), "nope"],
    });
    expect(unknown.status).toBe(400);

    const reversed = [...c.teamIds].reverse();
    expect((await c.call(c.commish, "PUT", `${base(c)}/order`, { order: reversed })).status).toBe(
      200,
    );
    const teams = await listTeams(db, c.seasonId);
    expect(teams.find((t) => t.teamId === reversed[0])?.draftPosition).toBe(1);
    expect((await c.snap(c.commish)).startBlockers).toEqual(["pool_empty"]);

    const pool = syntheticPool();
    await importPool(db, {
      seasonId: c.seasonId,
      seasonYear: 2025,
      source: "synthetic",
      ...pool,
      actorUserId: null,
      now: new Date(nowMs).toISOString(),
    });
    const started = await c.call(c.commish, "POST", `${base(c)}/start`);
    expect(started.status).toBe(200);
    expect(started.json.status).toBe("in_progress");
    expect(await c.call(c.commish, "POST", `${base(c)}/start`).then(errCode)).toBe(
      "draft_wrong_status",
    );
    expect(
      await c.call(c.commish, "PUT", `${base(c)}/order`, { order: c.teamIds }).then(errCode),
    ).toBe("draft_wrong_status");
    // META and the league's season pointer both moved to drafting.
    const meta = (
      await db.doc.send(new GetCommand({ TableName: db.tableName, Key: seasonMetaKey(c.seasonId) }))
    ).Item;
    const pointer = (
      await db.doc.send(
        new GetCommand({ TableName: db.tableName, Key: seasonPointerKey(c.leagueId, 2026) }),
      )
    ).Item;
    expect(meta?.status).toBe("drafting");
    expect(pointer?.status).toBe("drafting");
  });

  it("only the commissioner can run lifecycle routes; non-members are refused", async () => {
    const c = await setupLeague();
    const mgr = c.members[1]!;
    for (const [m, p] of [
      ["POST", "start"],
      ["POST", "pause"],
      ["POST", "resume"],
      ["POST", "clock"],
      ["DELETE", "clock"],
      ["POST", "undo"],
    ] as const)
      expect((await c.call(mgr, m, `${base(c)}/${p}`)).status, p).toBe(403);
    expect((await c.call(mgr, "PUT", `${base(c)}/order`, { order: c.teamIds })).status).toBe(403);
    expect((await c.call(mgr, "POST", `${base(c)}/autopick`, { expectedPick: 1 })).status).toBe(
      403,
    );
    expect((await c.call("stranger@local.test", "GET", base(c))).status).toBe(403);
    expect(
      (await c.call("stranger@local.test", "GET", `/seasons/${c.seasonId}/players`)).status,
    ).toBe(403);
  });
});

describe("picks", () => {
  it("returns the documented error codes and records commissioner picks", async () => {
    const c = await setupLeague();
    await c.call(c.commish, "POST", `${base(c)}/start`);
    const [m1, m2] = [c.members[0]!, c.members[1]!];
    let s = await c.snap(m1);
    expect(s.onClockTeamId).toBe(c.teamIds[0]);
    expect(s.round).toBe(1);

    const qb = first(s, "QB");
    const pick = (as: string, body: Record<string, unknown>) =>
      c.call(as, "POST", `${base(c)}/picks`, body);

    expect(await pick(m2, { playerId: qb.playerId, expectedPick: 1 }).then(errCode)).toBe(
      "not_your_turn",
    );
    expect(await pick(m1, { playerId: qb.playerId, expectedPick: 5 }).then(errCode)).toBe(
      "stale_pick",
    );
    expect(
      await pick(m1, { playerId: qb.playerId, expectedPick: 1, teamId: c.teamIds[1] }).then(
        errCode,
      ),
    ).toBe("not_your_turn");
    expect(
      await pick(m2, { playerId: qb.playerId, expectedPick: 1, teamId: c.teamIds[0] }).then(
        errCode,
      ),
    ).toBe("not_your_turn");
    expect(await pick(m1, { playerId: "missing", expectedPick: 1 }).then(errCode)).toBe(
      "not_found",
    );

    const ok = await pick(m1, { playerId: qb.playerId, expectedPick: 1 });
    expect(ok.status).toBe(200);
    expect(ok.json.pick).toMatchObject({ overallPick: 1, slot: "QB", madeBy: "manager" });
    expect(ok.json.currentPick).toBe(2);

    // Pick 2 (team 2): player_taken, second-QB-style ineligibility for a filled position.
    expect(await pick(m2, { playerId: qb.playerId, expectedPick: 2 }).then(errCode)).toBe(
      "player_taken",
    );
    const qb2 = first(await c.snap(m2), "QB");
    expect((await pick(m2, { playerId: qb2.playerId, expectedPick: 2 })).status).toBe(200);

    // Commissioner picks for team 3 (madeBy = commissioner) but not without teamId.
    s = await c.snap(c.commish);
    const rb = first(s, "RB");
    expect(await pick(c.commish, { playerId: rb.playerId, expectedPick: 3 }).then(errCode)).toBe(
      "not_your_turn",
    );
    const cp = await pick(c.commish, {
      playerId: rb.playerId,
      expectedPick: 3,
      teamId: c.teamIds[2],
    });
    expect(cp.status).toBe(200);
    expect(cp.json.pick.madeBy).toBe("commissioner");

    // Team 1 cannot take a second QB on its next turn: not_eligible; excluded players too.
    for (let p = 4; p <= 9; p++) {
      const sn = await c.snap(c.commish);
      await pick(c.commish, {
        playerId: first(sn, "WR").playerId,
        expectedPick: p,
        teamId: sn.onClockTeamId!,
      });
    }
    // Pick 10 is team 9, 11 team 8 ... pick 18 is team 1 again. Fast-forward with commissioner picks.
    for (let p = 10; p <= 17; p++) {
      const sn = await c.snap(c.commish);
      await pick(c.commish, {
        playerId: first(sn, "WR").playerId,
        expectedPick: p,
        teamId: sn.onClockTeamId!,
      });
    }
    const sn = await c.snap(m1);
    expect(sn.currentPick).toBe(18);
    expect(sn.onClockTeamId).toBe(c.teamIds[0]);
    expect(
      await pick(m1, { playerId: first(sn, "QB").playerId, expectedPick: 18 }).then(errCode),
    ).toBe("not_eligible");

    // Version rose with every write and the events carry no PII.
    const versions = c.events.map((e) => e.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(c.events.filter((e) => e.kind === "pick").length).toBeGreaterThan(10);
    expect(JSON.stringify(c.events)).not.toMatch(/@|local-/);
  });

  it("rejects picks when paused or not started, and clears nothing it should not", async () => {
    const c = await setupLeague();
    const m1 = c.members[0]!;
    const qb = first(await c.snap(m1), "QB");
    expect(
      await c
        .call(m1, "POST", `${base(c)}/picks`, { playerId: qb.playerId, expectedPick: 1 })
        .then(errCode),
    ).toBe("draft_not_active");
    await c.call(c.commish, "POST", `${base(c)}/start`);
    expect((await c.call(c.commish, "POST", `${base(c)}/pause`)).json.status).toBe("paused");
    expect(
      await c
        .call(m1, "POST", `${base(c)}/picks`, { playerId: qb.playerId, expectedPick: 1 })
        .then(errCode),
    ).toBe("draft_not_active");
    expect((await c.call(c.commish, "POST", `${base(c)}/resume`)).json.status).toBe("in_progress");
    expect(await c.call(c.commish, "POST", `${base(c)}/resume`).then(errCode)).toBe(
      "draft_wrong_status",
    );
  });

  it("serializes a concurrent pick race: exactly one wins", async () => {
    const c = await setupLeague();
    await c.call(c.commish, "POST", `${base(c)}/start`);
    const s = await c.snap(c.commish);
    const [a, b] = [first(s, "QB", 0), first(s, "QB", 1)];
    const body = (id: string) => ({ playerId: id, expectedPick: 1 });
    const [r1, r2] = await Promise.all([
      c.call(c.members[0]!, "POST", `${base(c)}/picks`, body(a.playerId)),
      c.call(c.commish, "POST", `${base(c)}/picks`, { ...body(b.playerId), teamId: c.teamIds[0] }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(["stale_pick", "draft_not_active"]).toContain(errCode(loser));
    expect((await c.snap(c.commish)).picks).toHaveLength(1);
  });

  it("a broadcast failure never fails the request", async () => {
    const c = await setupLeague();
    c.publisher.failing = true;
    expect((await c.call(c.commish, "POST", `${base(c)}/start`)).status).toBe(200);
  });
});

describe("clock", () => {
  it("is alert-only: start sets expiry 90 s out, expiry only flags, pause/pick clear it", async () => {
    const c = await setupLeague();
    await c.call(c.commish, "POST", `${base(c)}/start`);
    expect((await c.snap(c.commish)).clock).toBeNull();
    const t0 = nowMs;
    const r = await c.call(c.commish, "POST", `${base(c)}/clock`);
    expect(r.status).toBe(200);
    let s = await c.snap(c.members[3]!);
    expect(s.clock).toMatchObject({ seconds: 90, expired: false });
    expect(Date.parse(s.clock!.expiresAt) - Date.parse(s.clock!.startedAt)).toBe(90_000);
    expect(Date.parse(s.clock!.startedAt)).toBe(t0);
    expect(c.events.at(-1)?.kind).toBe("clock");

    nowMs = t0 + 91_000; // fake time: expired, but nothing auto-picks
    s = await c.snap(c.commish);
    expect(s.clock?.expired).toBe(true);
    expect(s.picks).toHaveLength(0);
    expect(s.status).toBe("in_progress");
    nowMs = t0;

    await c.call(c.commish, "POST", `${base(c)}/pause`);
    expect((await c.snap(c.commish)).clock).toBeNull();
    await c.call(c.commish, "POST", `${base(c)}/resume`);
    await c.call(c.commish, "POST", `${base(c)}/clock`, { expectedPick: 1 });
    expect(
      await c.call(c.commish, "POST", `${base(c)}/clock`, { expectedPick: 7 }).then(errCode),
    ).toBe("stale_pick");
    expect((await c.call(c.commish, "DELETE", `${base(c)}/clock`)).status).toBe(200);
    expect((await c.snap(c.commish)).clock).toBeNull();
    // Clearing again is a no-op; a pick clears a running clock.
    expect((await c.call(c.commish, "DELETE", `${base(c)}/clock`)).status).toBe(200);
    await c.call(c.commish, "POST", `${base(c)}/clock`);
    const qb = first(await c.snap(c.commish), "QB");
    await c.call(c.members[0]!, "POST", `${base(c)}/picks`, {
      playerId: qb.playerId,
      expectedPick: 1,
    });
    expect((await c.snap(c.commish)).clock).toBeNull();
  });

  it("only runs while the draft is in progress", async () => {
    const c = await setupLeague();
    expect(await c.call(c.commish, "POST", `${base(c)}/clock`).then(errCode)).toBe(
      "draft_not_active",
    );
  });
});

describe("auto-draft", () => {
  it("chains through consecutive auto teams, stops at a manual team, honours the queue", async () => {
    const c = await setupLeague();
    for (const i of [1, 2, 3]) {
      const r = await c.call(c.members[i]!, "PUT", `${base(c)}/auto-draft`, { enabled: true });
      expect(r.status).toBe(200);
      expect(r.json.autoPicked).toBe(0);
    }
    // Team 3's queue: a specific RB must be chosen first.
    const pre = await c.snap(c.members[3]!);
    const wanted = first(pre, "WR", 5);
    await c
      .call(c.members[3]!, "PUT", `${base(c)}/queue`, { playerIds: ["nope-zzz"] })
      .then((r) => expect(r.status).toBe(400));
    await c.call(c.members[3]!, "PUT", `${base(c)}/queue`, { playerIds: [wanted.playerId] });
    await c.call(c.commish, "POST", `${base(c)}/start`);
    const r = await c.call(c.members[0]!, "POST", `${base(c)}/picks`, {
      playerId: first(await c.snap(c.members[0]!), "QB").playerId,
      expectedPick: 1,
    });
    expect(r.json.autoPicked).toBe(3);
    const s = await c.snap(c.members[0]!);
    expect(s.currentPick).toBe(5);
    expect(s.picks.map((p) => p.madeBy)).toEqual(["manager", "autopick", "autopick", "autopick"]);
    expect(s.picks[3]?.playerId).toBe(wanted.playerId);
    // Position order: team 2 (no queue) takes the best QB (seed 1, A-Z).
    expect(s.picks[1]?.slot).toBe("QB");
    expect(s.autoDraftTeamIds.sort()).toEqual([c.teamIds[1], c.teamIds[2], c.teamIds[3]].sort());
    // Every autopick was broadcast.
    expect(c.events.filter((e) => e.kind === "pick")).toHaveLength(4);
  });

  it("enabling on the clock autopicks at once; auto for every team completes 90 picks; undo reopens", async () => {
    const c = await setupLeague();
    await c.call(c.commish, "POST", `${base(c)}/start`);
    for (const e of c.members.slice(1))
      await c.call(e, "PUT", `${base(c)}/auto-draft`, { enabled: true });
    expect((await c.snap(c.commish)).currentPick).toBe(1);
    const r = await c.call(c.members[0]!, "PUT", `${base(c)}/auto-draft`, { enabled: true });
    expect(r.json.autoPicked).toBe(90);
    expect(r.json.status).toBe("complete");

    const s = await c.snap(c.commish);
    expect(s.status).toBe("complete");
    expect(s.picks).toHaveLength(90);
    expect(s.currentPick).toBe(91);
    expect(s.onClockTeamId).toBeNull();
    for (const slots of Object.values(s.rosters))
      expect(Object.values(slots).every(Boolean)).toBe(true);
    expect(new Set(s.picks.map((p) => p.playerId)).size).toBe(90);
    const metaAt = async () => [
      (
        await db.doc.send(
          new GetCommand({ TableName: db.tableName, Key: seasonMetaKey(c.seasonId) }),
        )
      ).Item?.status,
      (
        await db.doc.send(
          new GetCommand({ TableName: db.tableName, Key: seasonPointerKey(c.leagueId, 2026) }),
        )
      ).Item?.status,
    ];
    expect(await metaAt()).toEqual(["in_progress", "in_progress"]);

    const undo = await c.call(c.commish, "POST", `${base(c)}/undo`);
    expect(undo.status).toBe(200);
    expect(undo.json.status).toBe("in_progress");
    expect(undo.json.currentPick).toBe(90);
    expect(await metaAt()).toEqual(["drafting", "drafting"]);
    const after = await c.snap(c.commish);
    expect(after.picks).toHaveLength(89);
    expect(after.available.some((p) => p.playerId === s.picks[89]!.playerId)).toBe(true);
    // Undo does not re-run the chain, so the undone pick stays open.
    expect(after.currentPick).toBe(90);
  });

  it("disabling stops the chain; commissioner autopick works and is audited", async () => {
    const c = await setupLeague();
    await c.call(c.commish, "POST", `${base(c)}/start`);
    expect(
      (await c.call(c.members[0]!, "PUT", `${base(c)}/auto-draft`, { enabled: true })).json
        .autoPicked,
    ).toBeGreaterThan(0);
    await c.call(c.members[0]!, "PUT", `${base(c)}/auto-draft`, { enabled: false });
    const s = await c.snap(c.commish);
    expect(s.autoDraftTeamIds).toEqual([]);
    expect(s.currentPick).toBe(2);
    const ap = await c.call(c.commish, "POST", `${base(c)}/autopick`, { expectedPick: 2 });
    expect(ap.status).toBe(200);
    expect(ap.json.pick.madeBy).toBe("autopick");
    expect(
      await c.call(c.commish, "POST", `${base(c)}/autopick`, { expectedPick: 2 }).then(errCode),
    ).toBe("stale_pick");
    expect(
      (await c.call(c.members[3]!, "PUT", `${base(c)}/auto-draft`, { enabled: true })).status,
    ).toBe(200);
  });
});

describe("undo", () => {
  it("undoes only the last pick; nothing to undo at the start", async () => {
    const c = await setupLeague();
    expect(await c.call(c.commish, "POST", `${base(c)}/undo`).then(errCode)).toBe(
      "nothing_to_undo",
    );
    await c.call(c.commish, "POST", `${base(c)}/start`);
    expect(await c.call(c.commish, "POST", `${base(c)}/undo`).then(errCode)).toBe(
      "nothing_to_undo",
    );
    const qb = first(await c.snap(c.commish), "QB");
    await c.call(c.members[0]!, "POST", `${base(c)}/picks`, {
      playerId: qb.playerId,
      expectedPick: 1,
    });
    const u = await c.call(c.commish, "POST", `${base(c)}/undo`);
    expect(u.json.currentPick).toBe(1);
    const s = await c.snap(c.commish);
    expect(s.picks).toHaveLength(0);
    expect(s.rosters[c.teamIds[0]!]!.QB).toBeNull();
    expect(c.events.at(-1)?.kind).toBe("undo");
  });
});

describe("queue privacy and snapshot PII", () => {
  it("never exposes another team's queue and no PII keys or values", async () => {
    const c = await setupLeague();
    const [a, b] = [c.members[1]!, c.members[2]!];
    const s0 = await c.snap(a);
    const marks = [first(s0, "WR", 1), first(s0, "RB", 1)].map((p) => p.playerId);
    const put = await c.call(a, "PUT", `${base(c)}/queue`, { playerIds: marks });
    expect(put.json.playerIds).toEqual(marks);
    expect((await c.snap(a)).myQueue).toEqual(marks);
    for (const other of [b, c.commish]) {
      expect((await c.snap(other)).myQueue).toEqual([]);
      expect((await c.call(other, "GET", `${base(c)}/queue`)).json.playerIds).toEqual([]);
    }
    // The queue ids appear nowhere in another member's snapshot except as available players.
    const raw = JSON.stringify((await c.call(b, "GET", base(c))).json);
    expect(raw).not.toContain('"queue"');
    expect(JSON.parse(raw).myQueue).toEqual([]);
    // Over the cap -> 400; a non-team member has no queue.
    expect(
      (
        await c.call(a, "PUT", `${base(c)}/queue`, {
          playerIds: Array.from({ length: 101 }, (_, i) => `p${i}`),
        })
      ).status,
    ).toBe(400);

    // Drafted players leave the queue.
    await c.call(c.commish, "POST", `${base(c)}/start`);
    const taken = marks[0]!;
    await c.call(c.commish, "POST", `${base(c)}/picks`, {
      playerId: taken,
      expectedPick: 1,
      teamId: c.teamIds[0],
    });
    expect((await c.snap(a)).myQueue).toEqual([marks[1]]);
    expect((await c.call(a, "GET", `${base(c)}/queue`)).json.playerIds).toEqual([marks[1]]);

    // PII: no key names and no value looks like an email or a user id.
    const full = await c.call(a, "GET", base(c));
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) {
          keys.add(k);
          walk(x);
        }
    };
    walk(full.json);
    for (const bad of [
      "email",
      "firstName",
      "lastName",
      "managerUserId",
      "userId",
      "madeByUserId",
      "cognitoUsername",
    ])
      expect(keys.has(bad), bad).toBe(false);
    const text = JSON.stringify(full.json);
    expect(text).not.toMatch(/@|local-[0-9a-f]{16}|Sekrit/);
    // And the data stayed out of the partition query used for the snapshot.
    const items = await queryPrefix(db, seasonPk(c.seasonId), "PRIVATE#");
    expect(items.length).toBeGreaterThan(0);
  });

  it("users without a team cannot use the queue or auto-draft", async () => {
    const c = await setupLeague();
    // A league member who has no team (e.g. a co-commissioner) gets 403.
    const { putIfAbsent, leagueMemberKey } = await import("@dnp/db");
    const email = `spectator${n}@local.test`;
    await putIfAbsent(db, {
      ...leagueMemberKey(c.leagueId, localSub(email)),
      type: "LeagueMember",
      leagueId: c.leagueId,
      userId: localSub(email),
      role: "manager",
    });
    expect((await c.call(email, "GET", `${base(c)}/queue`)).status).toBe(403);
    expect((await c.call(email, "PUT", `${base(c)}/auto-draft`, { enabled: true })).status).toBe(
      403,
    );
    expect((await c.snap(email)).myTeamId).toBeNull();
  });
});

describe("player pool", () => {
  it("re-import refreshes rank (provider data) and generated D/STs stay unranked", async () => {
    const c = await setupLeague({ pool: false });
    const pool = syntheticPool();
    const ranked = (rank: (i: number) => number | null) => ({
      source: "test",
      load: async () => ({
        teams: pool.teams,
        players: pool.players.map((p, i) => ({ ...p, rank: rank(i) })),
      }),
    });
    const imp = async (src: ReturnType<typeof ranked>) => {
      const res = await createApp({
        config: loadConfig({}),
        db,
        poolSource: src,
        now: () => new Date(nowMs),
      }).request(`/api/seasons/${c.seasonId}/pool/import`, {
        method: "POST",
        headers: { "x-dev-user-email": c.commish, "content-type": "application/json" },
        body: JSON.stringify({ seasonYear: 2025 }),
      });
      expect(res.status).toBe(200);
    };
    const ranks = async () => {
      const list = listPlayersResponse.parse(
        (await c.call(c.commish, "GET", `/seasons/${c.seasonId}/players`)).json,
      );
      return new Map(list.players.map((p) => [p.name, p]));
    };
    await imp(ranked((i) => i + 1));
    const before = await ranks();
    const name0 = pool.players[0]!.name;
    expect(before.get(name0)?.rank).toBe(1);
    expect(before.get(pool.players[5]!.name)?.rank).toBe(6);
    await imp(ranked((i) => (i === 0 ? null : 1000 + i)));
    const after = await ranks();
    expect(after.get(name0)?.rank).toBeNull();
    expect(after.get(pool.players[5]!.name)?.rank).toBe(1005);
    const dsts = [...after.values()].filter((p) => p.position === "DST");
    expect(dsts).toHaveLength(14);
    expect(dsts.every((p) => p.rank === null)).toBe(true);
  });

  it("imports idempotently, preserves overrides, marks missing players out, and locks during the draft", async () => {
    const c = await setupLeague({ pool: false });
    const pool = syntheticPool();
    const source = (players = pool.players) => ({
      source: "test",
      load: async () => ({ teams: pool.teams, players }),
    });
    const app = (src: ReturnType<typeof source>) =>
      createApp({ config: loadConfig({}), db, poolSource: src, now: () => new Date(nowMs) });
    const imp = async (src: ReturnType<typeof source>) => {
      const res = await app(src).request(`/api/seasons/${c.seasonId}/pool/import`, {
        method: "POST",
        headers: { "x-dev-user-email": c.commish, "content-type": "application/json" },
        body: JSON.stringify({ seasonYear: 2025 }),
      });
      return { status: res.status, json: (await res.json()) as Json };
    };
    const first1 = await imp(source());
    expect(first1.status).toBe(200);
    expect(first1.json.counts).toMatchObject({
      teams: 14,
      players: 280,
      added: 280,
      updated: 0,
      removed: 0,
    });
    const again = await imp(source());
    expect(again.json.counts).toMatchObject({ added: 0, updated: 280, removed: 0 });

    // Commissioner exclusion survives a re-import; a missing player becomes inPool=false.
    const list = (await c.call(c.members[2]!, "GET", `/seasons/${c.seasonId}/players`)).json;
    expect(listPlayersResponse.parse(list).lastImport?.source).toBe("test");
    const [p1, p2] = [list.players[0], list.players[1]];
    const patched = await c.call(
      c.commish,
      "PATCH",
      `/seasons/${c.seasonId}/players/${p1.playerId}`,
      { inPool: false },
    );
    expect(patched.status).toBe(200);
    expect(patched.json).toMatchObject({ inPool: false, manualOverride: true });
    const missingId = pool.players.find((p) => p.name === p2.name)!.providerPlayerId;
    const res3 = await imp(source(pool.players.filter((p) => p.providerPlayerId !== missingId)));
    expect(res3.json.counts.removed).toBe(1);
    const list3 = (await c.call(c.commish, "GET", `/seasons/${c.seasonId}/players`)).json;
    expect(list3.players.find((p: Json) => p.playerId === p1.playerId).inPool).toBe(false);
    expect(list3.players.find((p: Json) => p.playerId === p2.playerId).inPool).toBe(false);
    // Coming back in the feed restores it (no override).
    await imp(source());
    const list4 = (await c.call(c.commish, "GET", `/seasons/${c.seasonId}/players`)).json;
    expect(list4.players.find((p: Json) => p.playerId === p2.playerId).inPool).toBe(true);
    expect(list4.players.find((p: Json) => p.playerId === p1.playerId).inPool).toBe(false);

    // Manual add; unknown team rejected; authorization.
    const add = await c.call(c.commish, "POST", `/seasons/${c.seasonId}/players`, {
      name: "Late Callup",
      position: "WR",
      nflTeam: "AAA",
    });
    expect(add.status).toBe(201);
    expect(add.json).toMatchObject({ inPool: true, manualOverride: true, nflTeam: "AAA" });
    expect(
      (
        await c.call(c.commish, "POST", `/seasons/${c.seasonId}/players`, {
          name: "X",
          position: "WR",
          nflTeam: "ZZZ",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await c.call(c.members[1]!, "POST", `/seasons/${c.seasonId}/players`, {
          name: "X",
          position: "WR",
          nflTeam: "AAA",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await c.call(c.members[1]!, "PATCH", `/seasons/${c.seasonId}/players/${p1.playerId}`, {
          inPool: true,
        })
      ).status,
    ).toBe(403);
    expect(
      (await c.call(c.commish, "PATCH", `/seasons/${c.seasonId}/players/nope`, { inPool: true }))
        .status,
    ).toBe(404);

    // Locked once the draft runs; a drafted player cannot be excluded.
    await c.call(c.commish, "PUT", `${base(c)}/order`, { order: c.teamIds });
    await c.call(c.commish, "POST", `${base(c)}/start`);
    expect((await imp(source())).status).toBe(409);
    expect((await imp(source())).json.error.code).toBe("pool_locked");
    expect(
      await c
        .call(c.commish, "PATCH", `/seasons/${c.seasonId}/players/${p2.playerId}`, {
          inPool: false,
        })
        .then(errCode),
    ).toBe("pool_locked");
    await c.call(c.commish, "POST", `${base(c)}/pause`);
    const s = await c.snap(c.commish);
    const qb = first(s, "QB");
    await c.call(c.commish, "POST", `${base(c)}/resume`);
    await c.call(c.members[0]!, "POST", `${base(c)}/picks`, {
      playerId: qb.playerId,
      expectedPick: 1,
    });
    await c.call(c.commish, "POST", `${base(c)}/pause`);
    expect(
      await c
        .call(c.commish, "PATCH", `/seasons/${c.seasonId}/players/${qb.playerId}`, {
          inPool: false,
        })
        .then(errCode),
    ).toBe("player_taken");
    // Excluding someone while paused works and the snapshot reflects it.
    const other = first(await c.snap(c.commish), "RB");
    expect(
      (
        await c.call(c.commish, "PATCH", `/seasons/${c.seasonId}/players/${other.playerId}`, {
          inPool: false,
        })
      ).status,
    ).toBe(200);
    expect((await c.snap(c.commish)).available.some((p) => p.playerId === other.playerId)).toBe(
      false,
    );
  });

  it("re-import drops a previously imported no-depth player but keeps drafted and overridden ones", async () => {
    const c = await setupLeague({ pool: false });
    const pool = syntheticPool();
    const stale = pool.players.filter((p) => p.position === "QB").slice(0, 3);
    const [gone, drafted, overridden] = stale as [
      (typeof stale)[0],
      (typeof stale)[0],
      (typeof stale)[0],
    ];
    let players = pool.players;
    const app = createApp({
      config: loadConfig({}),
      db,
      poolSource: { source: "test", load: async () => ({ teams: pool.teams, players }) },
      now: () => new Date(nowMs),
    });
    const imp = () =>
      app.request(`/api/seasons/${c.seasonId}/pool/import`, {
        method: "POST",
        headers: { "x-dev-user-email": c.commish, "content-type": "application/json" },
        body: JSON.stringify({ seasonYear: 2025 }),
      });
    expect((await imp()).status).toBe(200);
    const listed = (await c.call(c.commish, "GET", `/seasons/${c.seasonId}/players`)).json
      .players as Json[];
    const idOf = (providerId: string | null) =>
      listed.find((p) => p.name === stale.find((s) => s.providerPlayerId === providerId)!.name)
        .playerId as string;
    // Override and draft two of them through the real routes.
    await c.call(
      c.commish,
      "PATCH",
      `/seasons/${c.seasonId}/players/${idOf(overridden.providerPlayerId)}`,
      {
        inPool: true,
      },
    );
    await c.call(c.commish, "PUT", `${base(c)}/order`, { order: c.teamIds });
    await c.call(c.commish, "POST", `${base(c)}/start`);
    const pick = await c.call(c.members[0]!, "POST", `${base(c)}/picks`, {
      playerId: idOf(drafted.providerPlayerId),
      expectedPick: 1,
    });
    expect(pick.status).toBe(200);
    await c.call(c.commish, "POST", `${base(c)}/pause`);
    // Pause (imports are allowed while paused), then re-import without all three, as happens
    // when the depth-chart filter starts dropping them.
    await c.call(c.commish, "POST", `${base(c)}/pause`);
    players = pool.players.filter(
      (p) => !stale.some((x) => x.providerPlayerId === p.providerPlayerId),
    );
    const res = await imp();
    expect(res.status).toBe(200);
    const after = (await c.call(c.commish, "GET", `/seasons/${c.seasonId}/players`)).json
      .players as Json[];
    const byId = (id: string) => after.find((p) => p.playerId === id);
    expect(byId(idOf(gone.providerPlayerId)).inPool).toBe(false);
    expect(byId(idOf(drafted.providerPlayerId))).toMatchObject({ inPool: true });
    expect(byId(idOf(drafted.providerPlayerId)).draftedByTeamId).toBeTruthy();
    expect(byId(idOf(overridden.providerPlayerId))).toMatchObject({
      inPool: true,
      manualOverride: true,
    });
  });

  it("maps a failing source to pool_import_failed", async () => {
    const c = await setupLeague({ pool: false });
    const { PoolSourceError } = await import("./providers");
    const app = createApp({
      config: loadConfig({}),
      db,
      poolSource: {
        source: "x",
        load: async () => {
          throw new PoolSourceError("ESPN standings could not be reached");
        },
      },
    });
    const res = await app.request(`/api/seasons/${c.seasonId}/pool/import`, {
      method: "POST",
      headers: { "x-dev-user-email": c.commish, "content-type": "application/json" },
      body: JSON.stringify({ seasonYear: 2025 }),
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as Json).error.code).toBe("pool_import_failed");
  });
});

describe("audit", () => {
  it("writes an id-only audit event for commissioner actions", async () => {
    const c = await setupLeague();
    await c.call(c.commish, "POST", `${base(c)}/start`);
    await c.call(c.commish, "POST", `${base(c)}/clock`);
    await c.call(c.commish, "POST", `${base(c)}/pause`);
    await c.call(c.commish, "POST", `${base(c)}/resume`);
    const items = await queryPrefix(db, seasonPk(c.seasonId), "AUDIT#");
    const actions = items.map((i) => i.action);
    for (const a of [
      "draft.set_order",
      "draft.start",
      "draft.clock_start",
      "draft.pause",
      "draft.resume",
      "pool.import",
    ])
      expect(actions, a).toContain(a);
    expect(JSON.stringify(items)).not.toMatch(/@|Sekrit/);
  });
});

describe("realtime ticket", () => {
  it("issues a ticket and wsUrl for any signed-in user", async () => {
    const c = await setupLeague();
    const r = await c.call("anyone@local.test", "POST", "/realtime/ticket");
    expect(r.status).toBe(200);
    const body = realtimeTicketResponse.parse(r.json);
    expect(body.wsUrl).toBe("ws://localhost:3002");
    expect(body.ticket.length).toBeGreaterThan(30);
    const cfgd = createApp({ config: loadConfig({ WS_PUBLIC_URL: "wss://x.example/live" }), db });
    const res = await cfgd.request("/api/realtime/ticket", { method: "POST" });
    expect(((await res.json()) as Json).wsUrl).toBe("wss://x.example/live");
    const aws = createApp({
      config: loadConfig({ APP_ENV: "dev", APP_TABLE: "t" }),
      db,
      verifyToken: async () => ({ sub: "u" }),
    });
    const noUrl = await aws.request("/api/realtime/ticket", {
      method: "POST",
      headers: { authorization: "Bearer x" },
    });
    expect(noUrl.status).toBe(503);
  });
});
