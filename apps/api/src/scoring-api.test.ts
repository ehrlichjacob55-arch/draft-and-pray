import { beforeAll, describe, expect, it, vi } from "vitest";
import { apiError, scoringResponse, type ScoringResponse } from "@dnp/contract";
import { bootstrapLeague, localSub, queryPrefix, seasonPk, type Dynamo } from "@dnp/db";
import { createTestDynamo } from "@dnp/db/testing";
import { BUILTIN_RULESETS } from "@dnp/domain";
import { loadConfig } from "./config";
import { createApp } from "./http/app";
import type { RulesetChange } from "./scoring/hooks";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let db: Dynamo;
let n = 0;

beforeAll(async () => {
  db = await createTestDynamo("api-scoring");
});

async function setup() {
  n++;
  const commish = `boss${n}@local.test`;
  const member = `mgr${n}@local.test`;
  const r = await bootstrapLeague(db, {
    userId: localSub(commish),
    email: commish,
    leagueName: `Scoring League ${n}`,
    year: 2026,
  });
  const changes: RulesetChange[] = [];
  const app = createApp({
    config: loadConfig({}),
    db,
    now: () => new Date("2026-03-01T00:00:00Z"),
    onRulesetChange: async (c) => {
      changes.push(c);
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
  expect(
    (
      await call(commish, "POST", `/seasons/${r.seasonId}/managers`, {
        firstName: "Sekrit",
        lastName: "Person",
        email: member,
      })
    ).status,
  ).toBe(201);
  await call(member, "GET", "/me");
  const base = `/seasons/${r.seasonId}/scoring`;
  const audit = async () =>
    (await queryPrefix(db, seasonPk(r.seasonId), "AUDIT#")).filter((a) =>
      String(a.action).startsWith("ruleset."),
    );
  return { call, commish, member, base, seasonId: r.seasonId, changes, audit };
}

const rules = (points = 6) => [
  { stat: "rush_td", points },
  { stat: "rush_yds", points: 1, per: 10, fractional: true },
];

describe("GET scoring", () => {
  it("is null before any ruleset exists, and readable by members", async () => {
    const s = await setup();
    for (const as of [s.commish, s.member]) {
      const res = await s.call(as, "GET", s.base);
      expect(res.status).toBe(200);
      expect(scoringResponse.parse(res.json)).toEqual({
        seasonId: s.seasonId,
        active: null,
        versions: [],
      });
    }
  });

  it("members see the active ruleset without ids or emails; the commissioner sees `by`", async () => {
    const s = await setup();
    await s.call(s.commish, "POST", `${s.base}/seed`, { ruleset: "league" });
    const asMember = await s.call(s.member, "GET", s.base);
    expect(asMember.status).toBe(200);
    const body = scoringResponse.parse(asMember.json);
    expect(body.active).toMatchObject({ version: 1, locked: false, rounding: 2 });
    expect(body.active!.rules).toHaveLength(BUILTIN_RULESETS.league.rules.length);
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0]).toMatchObject({ version: 1, active: true, locked: false });
    expect(body.versions[0]).not.toHaveProperty("by");
    expect(JSON.stringify(asMember.json)).not.toMatch(/@|Sekrit|local-/);
    const asCommish = await s.call(s.commish, "GET", s.base);
    expect(asCommish.json.versions[0].by).toBe("commissioner");
  });

  it("is 403 for non-members and 404 for an unknown season", async () => {
    const s = await setup();
    expect((await s.call("stranger@local.test", "GET", s.base)).status).toBe(403);
    expect((await s.call(s.commish, "GET", "/seasons/nope/scoring")).status).toBe(404);
  });
});

describe("commissioner-only writes", () => {
  it("members get 403 on every write", async () => {
    const s = await setup();
    await s.call(s.commish, "POST", `${s.base}/seed`, { ruleset: "league" });
    const attempts: [string, string, unknown?][] = [
      ["POST", `${s.base}/seed`, { ruleset: "league" }],
      ["PUT", `${s.base}/versions/1`, { rules: rules(), rounding: 2 }],
      ["POST", `${s.base}/versions`, { rules: rules(), rounding: 2, activate: true }],
      ["POST", `${s.base}/versions/1/lock`, {}],
      ["POST", `${s.base}/versions/1/activate`, {}],
    ];
    for (const [method, path, body] of attempts) {
      const res = await s.call(s.member, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(apiError.parse(res.json).error.code).toBe("forbidden");
    }
    expect((await s.audit()).map((a) => a.action)).toEqual(["ruleset.create"]);
  });
});

describe("seed", () => {
  it("loads the league rules as the active v1 and audits it; a second seed is 409", async () => {
    const s = await setup();
    const res = await s.call(s.commish, "POST", `${s.base}/seed`, { ruleset: "league" });
    expect(res.status).toBe(201);
    expect(res.json.active.version).toBe(1);
    expect(s.changes).toEqual([{ seasonId: s.seasonId, version: 1, reason: "seed" }]);
    const actions = (await s.audit()).map((a) => a.action);
    expect(actions).toContain("ruleset.create");
    const again = await s.call(s.commish, "POST", `${s.base}/seed`, { ruleset: "placeholder" });
    expect(again.status).toBe(409);
    expect(apiError.parse(again.json).error.code).toBe("ruleset_exists");
    expect(s.changes).toHaveLength(1);
  });

  it("can load the placeholder rules, and rejects an unknown name", async () => {
    const s = await setup();
    expect(
      (await s.call(s.commish, "POST", `${s.base}/seed`, { ruleset: "placeholder" })).status,
    ).toBe(201);
    const s2 = await setup();
    expect((await s2.call(s2.commish, "POST", `${s2.base}/seed`, { ruleset: "x" })).status).toBe(
      400,
    );
  });
});

describe("update, lock, versions", () => {
  it("updates an unlocked active version, keeps its name, notifies the hook and audits", async () => {
    const s = await setup();
    await s.call(s.commish, "POST", `${s.base}/seed`, { ruleset: "league" });
    s.changes.length = 0;
    const res = await s.call(s.commish, "PUT", `${s.base}/versions/1`, {
      rules: rules(),
      rounding: 1,
      note: "simplified",
    });
    expect(res.status).toBe(200);
    const body: ScoringResponse = scoringResponse.parse(res.json);
    expect(body.active).toMatchObject({ version: 1, rounding: 1, note: "simplified" });
    expect(body.active!.rules).toEqual(rules());
    expect(body.active!.name).toBe(BUILTIN_RULESETS.league.name);
    expect(s.changes).toEqual([{ seasonId: s.seasonId, version: 1, reason: "update" }]);
    expect((await s.audit()).map((a) => a.action)).toContain("ruleset.update");
  });

  it("locks, then 409 ruleset_locked on update; lock twice is a 409 conflict", async () => {
    const s = await setup();
    await s.call(s.commish, "POST", `${s.base}/seed`, { ruleset: "league" });
    const locked = await s.call(s.commish, "POST", `${s.base}/versions/1/lock`, {});
    expect(locked.status).toBe(200);
    expect(locked.json.active.locked).toBe(true);
    expect(locked.json.versions[0].lockedAt).toBeTruthy();
    expect(s.changes).toHaveLength(1); // lock does not change points
    const upd = await s.call(s.commish, "PUT", `${s.base}/versions/1`, {
      rules: rules(),
      rounding: 2,
    });
    expect(upd.status).toBe(409);
    expect(apiError.parse(upd.json).error.code).toBe("ruleset_locked");
    const again = await s.call(s.commish, "POST", `${s.base}/versions/1/lock`, {});
    expect(again.status).toBe(409);
    expect((await s.audit()).map((a) => a.action)).toContain("ruleset.lock");
  });

  it("creates v2 from a locked v1 and activates it; v1 stays untouched", async () => {
    const s = await setup();
    await s.call(s.commish, "POST", `${s.base}/seed`, { ruleset: "league" });
    await s.call(s.commish, "POST", `${s.base}/versions/1/lock`, {});
    const res = await s.call(s.commish, "POST", `${s.base}/versions`, {
      rules: rules(4),
      rounding: 2,
      note: "TD = 4",
      activate: true,
    });
    expect(res.status).toBe(201);
    expect(res.json.active).toMatchObject({ version: 2, locked: false, note: "TD = 4" });
    expect(res.json.versions.map((v: Json) => [v.version, v.active, v.locked])).toEqual([
      [1, false, true],
      [2, true, false],
    ]);
    expect(s.changes.at(-1)).toEqual({ seasonId: s.seasonId, version: 2, reason: "create" });
    const actions = (await s.audit()).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(["ruleset.create", "ruleset.lock", "ruleset.activate"]),
    );
  });

  it("creates without activating (a fork), then activates it later", async () => {
    const s = await setup();
    await s.call(s.commish, "POST", `${s.base}/seed`, { ruleset: "placeholder" });
    s.changes.length = 0;
    const fork = await s.call(s.commish, "POST", `${s.base}/versions`, {
      rules: rules(),
      rounding: 2,
      activate: false,
    });
    expect(fork.status).toBe(201);
    expect(fork.json.active.version).toBe(1);
    expect(s.changes).toEqual([]);
    const act = await s.call(s.commish, "POST", `${s.base}/versions/2/activate`, {});
    expect(act.status).toBe(200);
    expect(act.json.active.version).toBe(2);
    expect(s.changes).toEqual([{ seasonId: s.seasonId, version: 2, reason: "activate" }]);
    // Re-activating the active version changes nothing.
    await s.call(s.commish, "POST", `${s.base}/versions/2/activate`, {});
    expect(s.changes).toHaveLength(1);
  });

  it("updating a non-active version does not trigger the hook", async () => {
    const s = await setup();
    await s.call(s.commish, "POST", `${s.base}/seed`, { ruleset: "placeholder" });
    await s.call(s.commish, "POST", `${s.base}/versions`, {
      rules: rules(),
      rounding: 2,
      activate: false,
    });
    s.changes.length = 0;
    expect(
      (await s.call(s.commish, "PUT", `${s.base}/versions/2`, { rules: rules(5), rounding: 2 }))
        .status,
    ).toBe(200);
    expect(s.changes).toEqual([]);
  });

  it("404 for unknown versions", async () => {
    const s = await setup();
    await s.call(s.commish, "POST", `${s.base}/seed`, { ruleset: "league" });
    for (const [method, path, body] of [
      ["PUT", `${s.base}/versions/9`, { rules: rules(), rounding: 2 }],
      ["PUT", `${s.base}/versions/abc`, { rules: rules(), rounding: 2 }],
      ["POST", `${s.base}/versions/9/lock`, {}],
      ["POST", `${s.base}/versions/9/activate`, {}],
    ] as const) {
      expect((await s.call(s.commish, method, path, body)).status, path).toBe(404);
    }
  });
});

describe("validation", () => {
  it("returns 400 with structured per-rule errors", async () => {
    const s = await setup();
    await s.call(s.commish, "POST", `${s.base}/seed`, { ruleset: "league" });
    const res = await s.call(s.commish, "PUT", `${s.base}/versions/1`, {
      rules: [
        { stat: "rush_td", points: 6 },
        {
          stat: "fg_made",
          tiers: [
            { min: 0, max: 39, points: 3 },
            { min: 45, points: 5 },
          ],
        },
        { stat: "nope", points: 1 },
        { stat: "rush_yds", points: 1, per: 10, gte: 5 },
      ],
      rounding: 2,
    });
    expect(res.status).toBe(400);
    const err = apiError.parse(res.json).error;
    expect(err.code).toBe("validation_error");
    expect(err.ruleErrors).toEqual([
      { ruleIndex: 1, stat: "fg_made", message: expect.stringMatching(/gap in tiers/) },
      { ruleIndex: 2, stat: "nope", message: expect.stringMatching(/stat: unknown stat key/) },
      { ruleIndex: 3, stat: "rush_yds", message: expect.stringMatching(/bonus rule/) },
    ]);
    // nothing was written
    expect((await s.call(s.commish, "GET", s.base)).json.active.rules).toHaveLength(
      BUILTIN_RULESETS.league.rules.length,
    );
  });

  it("reports non-rule problems with a null ruleIndex", async () => {
    const s = await setup();
    await s.call(s.commish, "POST", `${s.base}/seed`, { ruleset: "league" });
    const empty = await s.call(s.commish, "PUT", `${s.base}/versions/1`, {
      rules: [],
      rounding: 2,
    });
    expect(empty.json.error.ruleErrors).toEqual([
      { ruleIndex: null, stat: null, message: "rules: a ruleset needs at least one rule" },
    ]);
    const bad = await s.call(s.commish, "POST", `${s.base}/versions`, {
      rules: rules(),
      rounding: 9,
      activate: true,
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error.ruleErrors).toHaveLength(1);
    expect(bad.json.error.message).toMatch(/1 problem/);
    const notObj = await s.call(s.commish, "PUT", `${s.base}/versions/1`, {
      rules: ["x"],
      rounding: 2,
    });
    expect(notObj.json.error.ruleErrors[0]).toMatchObject({ ruleIndex: 0, stat: null });
  });

  it("rejects a malformed body", async () => {
    const s = await setup();
    await s.call(s.commish, "POST", `${s.base}/seed`, { ruleset: "league" });
    expect((await s.call(s.commish, "PUT", `${s.base}/versions/1`, { rounding: 2 })).status).toBe(
      400,
    );
  });
});

describe("recompute hook default", () => {
  it("the default hook is a no-op that resolves", async () => {
    const { recomputeAfterRulesetChange } = await import("./scoring/hooks");
    const spy = vi.fn();
    await expect(
      recomputeAfterRulesetChange({ seasonId: "s", version: 1, reason: "seed" }),
    ).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });
});
