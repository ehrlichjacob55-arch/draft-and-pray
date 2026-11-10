import { BUILTIN_RULESETS } from "@dnp/domain";
import { beforeAll, describe, expect, it } from "vitest";
import type { Dynamo } from "./client";
import { DomainError } from "./errors";
import { bootstrapLeague } from "./repos/leagues";
import {
  createRulesetVersion,
  getActiveRuleset,
  getRuleset,
  listRulesets,
  lockRuleset,
  seedBuiltinRuleset,
  setActiveRuleset,
  updateRuleset,
} from "./repos/rulesets";
import { loadSeason } from "./repos/season";
import { createTestDynamo } from "./testing";

let db: Dynamo;
beforeAll(async () => {
  db = await createTestDynamo("rulesets");
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
  return { seasonId: r.seasonId, actorUserId: `c${n}` };
}
const audits = async (seasonId: string) =>
  (await loadSeason(db, seasonId)).audit
    .map((a) => a.action)
    .filter((a) => a.startsWith("ruleset."))
    .sort();
const rejects = async (p: Promise<unknown>, code: string, msg?: RegExp) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe(code);
  if (msg) expect((err as DomainError).message).toMatch(msg);
};

describe("rulesets", () => {
  it("creates sequential versions, validated, unlocked, with the assigned version and an audit event", async () => {
    const s = await season();
    const v1 = await createRulesetVersion(db, {
      ...s,
      rules: BUILTIN_RULESETS.league,
      note: "league rules",
    });
    const v2 = await createRulesetVersion(db, {
      ...s,
      rules: { ...BUILTIN_RULESETS.placeholder, version: 99 },
    });
    expect([v1.item.version, v2.item.version]).toEqual([1, 2]);
    expect(v1.item).toMatchObject({
      locked: false,
      createdBy: s.actorUserId,
      note: "league rules",
      sk: "RULESET#v001",
    });
    expect(v2.item.rules.version).toBe(2);
    expect(v2.ruleset.version).toBe(2);
    const got = await getRuleset(db, s.seasonId, 1);
    expect(got?.ruleset.rules.length).toBe(v1.ruleset.rules.length);
    expect((await listRulesets(db, s.seasonId)).map((r) => r.item.version)).toEqual([1, 2]);
    expect(await getRuleset(db, s.seasonId, 3)).toBeUndefined();
    expect(await audits(s.seasonId)).toEqual(
      expect.arrayContaining(["ruleset.create", "ruleset.create"]),
    );
  });

  it("rejects an invalid ruleset with every problem listed, writing nothing", async () => {
    const s = await season();
    await rejects(
      createRulesetVersion(db, {
        ...s,
        rules: { rounding: 2, rules: [{ stat: "nope", points: 1 }, { stat: "rush_td" }] },
      }),
      "validation_error",
      /unknown stat key "nope"[\s\S]*needs points/,
    );
    await rejects(createRulesetVersion(db, { ...s, rules: [] }), "validation_error", /JSON object/);
    await rejects(
      createRulesetVersion(db, { ...s, rules: null }),
      "validation_error",
      /JSON object/,
    );
    expect(await listRulesets(db, s.seasonId)).toEqual([]);
  });

  it("rejects an unknown season", async () => {
    await rejects(
      createRulesetVersion(db, {
        seasonId: "nope",
        actorUserId: null,
        rules: BUILTIN_RULESETS.league,
      }),
      "not_found",
    );
    await rejects(getActiveRuleset(db, "nope"), "not_found");
  });

  it("two creators racing for the same version: one wins, the other gets a conflict", async () => {
    const s = await season();
    const results = await Promise.allSettled([
      createRulesetVersion(db, { ...s, rules: BUILTIN_RULESETS.league }),
      createRulesetVersion(db, { ...s, rules: BUILTIN_RULESETS.league }),
    ]);
    // Both may read max=0 and race for v1; DynamoDB's condition lets only one put succeed.
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r) => r.status === "rejected");
    expect(ok.length + bad.length).toBe(2);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const b of bad)
      expect(((b as PromiseRejectedResult).reason as DomainError).code).toBe("conflict");
    expect((await listRulesets(db, s.seasonId)).length).toBe(ok.length);
  });

  it("updates an unlocked version; a locked version cannot be edited or locked again (I-6)", async () => {
    const s = await season();
    await createRulesetVersion(db, { ...s, rules: BUILTIN_RULESETS.placeholder });
    const upd = await updateRuleset(db, {
      ...s,
      version: 1,
      rules: BUILTIN_RULESETS.league,
      note: "swap",
    });
    expect(upd.item.note).toBe("swap");
    expect(upd.ruleset.rules[0]).toMatchObject({ stat: "pass_yds", per: 30 });
    const noNote = await updateRuleset(db, {
      ...s,
      version: 1,
      rules: BUILTIN_RULESETS.placeholder,
    });
    expect(noNote.item.note).toBe("swap");

    const locked = await lockRuleset(db, { ...s, version: 1 });
    expect(locked.item).toMatchObject({ locked: true, lockedBy: s.actorUserId });
    expect(locked.item.lockedAt).toBeTruthy();
    await rejects(
      updateRuleset(db, { ...s, version: 1, rules: BUILTIN_RULESETS.league }),
      "conflict",
      /locked/,
    );
    await rejects(lockRuleset(db, { ...s, version: 1 }), "conflict", /locked/);
    // the stored rules are untouched
    expect((await getRuleset(db, s.seasonId, 1))?.ruleset.rules[0]).toMatchObject({ per: 25 });
    // a new version is the way to change it
    expect(
      (await createRulesetVersion(db, { ...s, rules: BUILTIN_RULESETS.league })).item.version,
    ).toBe(2);
    expect(await audits(s.seasonId)).toEqual([
      "ruleset.create",
      "ruleset.create",
      "ruleset.lock",
      "ruleset.update",
      "ruleset.update",
    ]);
  });

  it("update/lock/activate a missing version -> not_found, with no audit written", async () => {
    const s = await season();
    await rejects(
      updateRuleset(db, { ...s, version: 5, rules: BUILTIN_RULESETS.league }),
      "not_found",
    );
    await rejects(lockRuleset(db, { ...s, version: 5 }), "not_found");
    await rejects(setActiveRuleset(db, { ...s, version: 5 }), "not_found");
    await rejects(
      updateRuleset(db, { ...s, version: 1, rules: { rules: [] } }),
      "validation_error",
    );
    expect(await audits(s.seasonId)).toEqual([]);
  });

  it("sets and reads the active ruleset, with an audit event", async () => {
    const s = await season();
    // bootstrap points META at v1 before any ruleset exists
    expect(await getActiveRuleset(db, s.seasonId)).toBeUndefined();
    await createRulesetVersion(db, { ...s, rules: BUILTIN_RULESETS.placeholder });
    await createRulesetVersion(db, { ...s, rules: BUILTIN_RULESETS.league });
    expect((await getActiveRuleset(db, s.seasonId))?.item.version).toBe(1);
    await setActiveRuleset(db, { ...s, version: 2 });
    expect((await getActiveRuleset(db, s.seasonId))?.item.version).toBe(2);
    expect((await loadSeason(db, s.seasonId)).meta?.activeRulesetVersion).toBe(2);
    expect(await audits(s.seasonId)).toContain("ruleset.activate");
  });

  it("seeds a built-in ruleset as v1 once; a second run (or another file) changes nothing", async () => {
    const s = await season();
    expect(await seedBuiltinRuleset(db, { seasonId: s.seasonId, name: "league" })).toEqual({
      created: true,
    });
    expect(await seedBuiltinRuleset(db, { seasonId: s.seasonId, name: "placeholder" })).toEqual({
      created: false,
    });
    const all = await listRulesets(db, s.seasonId);
    expect(all).toHaveLength(1);
    expect(all[0]?.item).toMatchObject({
      createdBy: null,
      locked: false,
      note: "Seeded from league.v1.json",
    });
    expect(all[0]?.ruleset.name).toMatch(/League rules/);
    expect((await getActiveRuleset(db, s.seasonId))?.item.version).toBe(1);
  });
});
