import { describe, expect, it } from "vitest";
import { BUILTIN_RULESETS } from "./builtin-rulesets";
import { scorePlayerGame } from "./engine";
import { GOLDEN_GAME, GOLDEN_PLAYERS } from "./golden.fixture";
import { parseRuleset } from "./ruleset";

describe(`golden: ${GOLDEN_GAME.provider} event ${GOLDEN_GAME.eventId} (${GOLDEN_GAME.date}), LAR 34 - CAR 31`, () => {
  describe.each(["placeholder", "league"] as const)("%s ruleset", (name) => {
    const ruleset = parseRuleset(BUILTIN_RULESETS[name]);
    it.each(GOLDEN_PLAYERS)("$name matches the hand calculation", (p) => {
      expect(scorePlayerGame(ruleset, p.position, p.stats).points).toBe(p[name]);
    });
  });
});

describe("league ruleset spot checks", () => {
  const league = parseRuleset(BUILTIN_RULESETS.league);
  const score = (
    position: "QB" | "RB" | "WR" | "K" | "DST",
    counts: Record<string, number>,
    events?: object,
  ) => scorePlayerGame(league, position, { counts, ...(events ? { events } : {}) } as never).points;

  it("passing yards score only for QBs, 1 per 30, fractional", () => {
    expect(score("QB", { pass_yds: 299 })).toBe(9.97);
    expect(score("QB", { pass_yds: 60 })).toBe(2);
    expect(score("WR", { pass_yds: 90 })).toBe(0);
  });
  it("rushing and receiving yardage are fractional, negatives included", () => {
    expect(score("RB", { rush_yds: 59 })).toBe(5.9);
    expect(score("RB", { rush_yds: -3 })).toBe(-0.3);
    expect(score("QB", { rush_yds: 24 })).toBe(2.4);
    expect(score("WR", { rec_yds: 99 })).toBe(9.9);
  });
  it("every touchdown is 6, including return, fumble-recovery and DST TDs", () => {
    expect(score("WR", { ret_td: 1 })).toBe(6);
    expect(score("RB", { fum_rec_td: 1 })).toBe(6);
    // 7 allowed = 8 (band 7-13), def TD 6 + return TD 6
    expect(score("DST", { def_pts_allowed: 7, def_td: 1, ret_td: 1 })).toBe(8 + 6 + 6);
  });
  it("full PPR: 1 per reception; 2-pt conversions are 2 for the passer AND the receiver", () => {
    expect(score("WR", { rec: 12 })).toBe(12);
    expect(score("QB", { pass_2pt: 1 })).toBe(2);
    expect(score("WR", { rec_2pt: 1 })).toBe(2);
    expect(score("RB", { rush_2pt: 1 })).toBe(2);
  });
  it("no yardage or threshold bonuses", () => {
    expect(score("RB", { rush_yds: 100 })).toBe(10);
    expect(score("RB", { rush_yds: 200 })).toBe(20);
  });
  it("kicker: -1 for each missed or blocked FG/XP, in addition to made kicks", () => {
    expect(score("K", { fg_missed: 2, fg_blocked: 1, xp_missed: 1, xp_blocked: 1 })).toBe(-5);
    expect(
      score(
        "K",
        { fg_made: 1, fg_missed: 1, xp_made: 1, xp_missed: 1 },
        { fg_made: [45], fg_missed: [52] },
      ),
    ).toBe(4 - 1 + 1 - 1);
    // a DST's blocked-kick stat is a different key: it does not touch the kicker's line
    expect(score("DST", { def_pts_allowed: 21, def_block: 2, fg_blocked: 3 })).toBe(2 + 2);
  });
  it("DST points allowed tiers, boundaries at 0, 6, 13, 20, 27, 34, 35", () => {
    const pa = (n: number) => score("DST", { def_pts_allowed: n });
    expect([0, 1, 6, 7, 13, 14, 20, 21, 27, 28, 34, 35, 60].map(pa)).toEqual([
      15, 10, 10, 8, 8, 5, 5, 2, 2, 0, 0, -5, -5,
    ]);
  });
  it("DST 1 pt per sack/INT/fumble recovery/block, 2 per safety", () => {
    expect(
      score("DST", {
        def_pts_allowed: 21,
        def_sack: 3,
        def_int: 1,
        def_fum_rec: 1,
        def_block: 1,
        def_safety: 1,
      }),
    ).toBe(2 + 3 + 1 + 1 + 1 + 2);
  });
  it("kicker: XP 1, FG 3/4/5 by distance", () => {
    expect(score("K", { fg_made: 3, xp_made: 2 }, { fg_made: [39, 40, 50] })).toBe(3 + 4 + 5 + 2);
  });
});
