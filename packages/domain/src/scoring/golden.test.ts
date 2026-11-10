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

  it("the league ruleset only differs where the rules differ (QB passing, turnovers, DST)", () => {
    const diffs = GOLDEN_PLAYERS.filter((p) => p.placeholder !== p.league).map((p) => p.name);
    expect(diffs).toEqual([
      "Matthew Stafford (LAR QB)",
      "Bryce Young (CAR QB)",
      "Trevor Etienne (CAR RB)",
      "LAR DST",
      "CAR DST",
    ]);
  });
});

describe("league ruleset spot checks", () => {
  const league = parseRuleset(BUILTIN_RULESETS.league);
  const score = (
    position: "QB" | "RB" | "WR" | "K" | "DST",
    counts: Record<string, number>,
    events?: object,
  ) => scorePlayerGame(league, position, { counts, ...(events ? { events } : {}) } as never).points;

  it("passing yards score only for QBs, 1 per 30 whole units", () => {
    expect(score("QB", { pass_yds: 59 })).toBe(1);
    expect(score("QB", { pass_yds: 60 })).toBe(2);
    expect(score("WR", { pass_yds: 90 })).toBe(0);
  });
  it("every touchdown is 6, including return, fumble-recovery and DST TDs", () => {
    expect(score("WR", { ret_td: 1 })).toBe(6);
    expect(score("RB", { fum_rec_td: 1 })).toBe(6);
    // 7 allowed = 8 (band 7-13), def TD 6 + return TD 6
    expect(score("DST", { def_pts_allowed: 7, def_td: 1, ret_td: 1 })).toBe(8 + 6 + 6);
  });
  it("no points for receptions, 2-point conversions, misses, or yardage bonuses", () => {
    expect(score("WR", { rec: 12, rec_2pt: 1 })).toBe(0);
    expect(score("RB", { rush_2pt: 1, rush_yds: 100 })).toBe(10);
    expect(score("K", { fg_missed: 2, xp_missed: 1 })).toBe(0);
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
