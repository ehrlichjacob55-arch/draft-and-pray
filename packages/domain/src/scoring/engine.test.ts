import { describe, expect, it } from "vitest";
import { microToPoints, scorePlayerGame } from "./engine";
import { parseRuleset, type Ruleset } from "./ruleset";
import type { StatLine } from "./stat-line";

const rs = (rules: unknown[], rounding = 2): Ruleset =>
  parseRuleset({ version: 1, rounding, rules });
const line = (counts: StatLine["counts"], events?: StatLine["events"]): StatLine =>
  events ? { counts, events } : { counts };

describe("per-unit rules", () => {
  const r = rs([{ stat: "rush_yds", points: 1, per: 10 }]);
  it("scores whole units only", () => {
    expect(scorePlayerGame(r, "RB", line({ rush_yds: 99 })).points).toBe(9);
    expect(scorePlayerGame(r, "RB", line({ rush_yds: 100 })).points).toBe(10);
    expect(scorePlayerGame(r, "RB", line({ rush_yds: 9 })).points).toBe(0);
  });
  it("truncates negative yardage toward zero", () => {
    expect(scorePlayerGame(r, "RB", line({ rush_yds: -15 })).points).toBe(-1);
    expect(scorePlayerGame(r, "RB", line({ rush_yds: -9 })).points).toBe(0);
    expect(scorePlayerGame(r, "RB", line({ rush_yds: -10 })).points).toBe(-1);
  });
  it("opts into fractional units", () => {
    const f = rs([{ stat: "rush_yds", points: 1, per: 10, fractional: true }]);
    expect(scorePlayerGame(f, "RB", line({ rush_yds: 99 })).points).toBe(9.9);
    expect(scorePlayerGame(f, "RB", line({ rush_yds: -15 })).points).toBe(-1.5);
    expect(scorePlayerGame(f, "RB", line({ rush_yds: 1 })).points).toBe(0.1);
  });
  it("supports decimal point values without drift", () => {
    const d = rs([{ stat: "rush_yds", points: 0.1, per: 1 }]);
    expect(scorePlayerGame(d, "RB", line({ rush_yds: 3 })).points).toBe(0.3);
    expect(scorePlayerGame(rs([{ stat: "rec", points: 0.1 }]), "WR", line({ rec: 7 })).points).toBe(
      0.7,
    );
  });
});

describe("per-event and bonus rules", () => {
  it("per-event multiplies the count, including negatives per event", () => {
    const r = rs([
      { stat: "pass_int", points: -2 },
      { stat: "rush_td", points: 6 },
    ]);
    expect(scorePlayerGame(r, "QB", line({ pass_int: 3, rush_td: 1 })).points).toBe(0);
    expect(scorePlayerGame(r, "QB", line({})).points).toBe(0);
  });
  it("a bonus pays once at exactly the threshold and above, never below", () => {
    const r = rs([{ stat: "rush_yds", gte: 100, points: 3 }]);
    expect(scorePlayerGame(r, "RB", line({ rush_yds: 99 })).points).toBe(0);
    expect(scorePlayerGame(r, "RB", line({ rush_yds: 100 })).points).toBe(3);
    expect(scorePlayerGame(r, "RB", line({ rush_yds: 250 })).points).toBe(3);
  });
});

describe("tier rules", () => {
  const r = rs([
    {
      stat: "def_pts_allowed",
      tiers: [
        { min: 0, max: 0, points: 10 },
        { min: 1, max: 6, points: 7 },
        { min: 7, points: -1 },
      ],
    },
  ]);
  it.each([
    [0, 10],
    [1, 7],
    [6, 7],
    [7, -1],
    [99, -1],
  ])("allowed %i -> %i", (allowed, expected) => {
    expect(scorePlayerGame(r, "DST", line({ def_pts_allowed: allowed })).points).toBe(expected);
  });
  it("an unreported stat counts as 0 and a negative value matches no band", () => {
    expect(scorePlayerGame(r, "DST", line({})).points).toBe(10);
    expect(scorePlayerGame(r, "DST", line({ def_pts_allowed: -3 })).points).toBe(0);
  });
});

describe("distance tiers", () => {
  const r = rs([
    {
      stat: "fg_made",
      tiers: [
        { min: 0, max: 39, points: 3 },
        { min: 40, max: 49, points: 4 },
        { min: 50, points: 5 },
      ],
    },
  ]);
  it("scores each kick by its own distance, at the band edges", () => {
    expect(
      scorePlayerGame(r, "K", line({ fg_made: 6 }, { fg_made: [39, 40, 49, 50, 20, 61] })).points,
    ).toBe(3 + 4 + 4 + 5 + 3 + 5);
  });
  it("scores 0 for no kicks, with or without a list; rejects counts without distances", () => {
    expect(scorePlayerGame(r, "K", line({})).points).toBe(0);
    expect(scorePlayerGame(r, "K", line({ fg_made: 0 }, { fg_made: [] })).points).toBe(0);
    expect(() => scorePlayerGame(r, "K", line({ fg_made: 2 }))).toThrow(
      /no distances were recorded/,
    );
  });
  it("rejects an inconsistent stat line", () => {
    expect(() => scorePlayerGame(r, "K", line({ fg_made: 2 }, { fg_made: [30] }))).toThrow(
      /Invalid stat line/,
    );
  });
  it("a distance with no covering tier scores 0 (tier lists from code, not parsed)", () => {
    const manual: Ruleset = {
      version: 1,
      rounding: 2,
      rules: [{ kind: "distance_tiers", stat: "fg_made", tiers: [{ min: 0, max: 39, points: 3 }] }],
    };
    expect(scorePlayerGame(manual, "K", line({ fg_made: 2 }, { fg_made: [30, 45] })).points).toBe(
      3,
    );
  });
});

describe("position scope", () => {
  const r = rs([
    { stat: "pass_yds", points: 1, per: 30, positions: ["QB"] },
    { stat: "rec", points: 0.5, positions: ["TE"] },
    { stat: "rush_yds", points: 1, per: 10 },
  ]);
  it("rules for other positions contribute nothing", () => {
    const l = line({ pass_yds: 90, rec: 4, rush_yds: 20 });
    expect(scorePlayerGame(r, "QB", l).points).toBe(3 + 2);
    expect(scorePlayerGame(r, "TE", l).points).toBe(2 + 2);
    expect(scorePlayerGame(r, "WR", l).points).toBe(2);
  });
});

describe("rounding and breakdown", () => {
  it("rounds once at the end, half away from zero", () => {
    const f = [{ stat: "rush_yds", points: 1, per: 8, fractional: true }];
    // 5 yds * 1/8 = 0.625
    expect(scorePlayerGame(rs(f, 2), "RB", line({ rush_yds: 5 })).points).toBe(0.63);
    expect(scorePlayerGame(rs(f, 2), "RB", line({ rush_yds: -5 })).points).toBe(-0.63);
    expect(scorePlayerGame(rs(f, 1), "RB", line({ rush_yds: 5 })).points).toBe(0.6);
    expect(scorePlayerGame(rs(f, 0), "RB", line({ rush_yds: 5 })).points).toBe(1);
    expect(scorePlayerGame(rs(f, 3), "RB", line({ rush_yds: 5 })).points).toBe(0.625);
    // three 0.625s add to 1.875 before a single rounding (rounding each first would give 1.89)
    const three = rs(
      [
        { stat: "rush_yds", points: 1, per: 8, fractional: true },
        { stat: "rec_yds", points: 1, per: 8, fractional: true },
        { stat: "pass_yds", points: 1, per: 8, fractional: true },
      ],
      2,
    );
    expect(
      scorePlayerGame(three, "RB", line({ rush_yds: 5, rec_yds: 5, pass_yds: 5 })).points,
    ).toBe(1.88);
  });
  it("microToPoints handles zero, exact and rounded values", () => {
    expect(microToPoints(0, 2)).toBe(0);
    expect(microToPoints(1_500_000, 0)).toBe(2);
    expect(microToPoints(1_499_999, 0)).toBe(1);
    expect(microToPoints(-12_345_678, 4)).toBe(-12.3457);
  });
  it("lists contributing rules with label, value and points; omits zero-point rules", () => {
    const r = rs([
      { stat: "rush_yds", points: 1, per: 10, label: "Rushing yards" },
      { stat: "rush_td", points: 6 },
      { stat: "rec", points: 0 },
      { stat: "rush_yds", gte: 100, points: 3 },
    ]);
    expect(scorePlayerGame(r, "RB", line({ rush_yds: 104, rush_td: 1, rec: 5 }))).toEqual({
      points: 19,
      breakdown: [
        { ruleIndex: 0, stat: "rush_yds", label: "Rushing yards", value: 104, points: 10 },
        { ruleIndex: 1, stat: "rush_td", value: 1, points: 6 },
        { ruleIndex: 3, stat: "rush_yds", value: 104, points: 3 },
      ],
    });
  });
  it("is deterministic and empty for an empty line", () => {
    const r = rs([{ stat: "rush_td", points: 6 }]);
    expect(scorePlayerGame(r, "RB", line({}))).toEqual({ points: 0, breakdown: [] });
  });
});
