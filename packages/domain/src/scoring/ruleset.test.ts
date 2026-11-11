import { describe, expect, it } from "vitest";
import { BUILTIN_RULESETS } from "./builtin-rulesets";
import { parseRuleset, safeParseRuleset } from "./ruleset";

const wrap = (...rules: unknown[]) => ({ version: 1, rules });
const errorsOf = (input: unknown): string[] => {
  const r = safeParseRuleset(input);
  if (r.ok) throw new Error("expected the ruleset to be rejected");
  return r.errors;
};

describe("shipped rulesets", () => {
  it.each(Object.entries(BUILTIN_RULESETS))("%s ruleset is valid", (_name, json) => {
    const rs = parseRuleset(json);
    expect(rs.version).toBe(1);
    expect(rs.rules.length).toBeGreaterThan(5);
  });
});

describe("rule shapes", () => {
  it("classifies every rule type and defaults rounding to 2", () => {
    const rs = parseRuleset(
      wrap(
        { stat: "rush_yds", points: 1, per: 10 },
        { stat: "rush_yds", points: 0.5, per: 10, fractional: true, label: "frac" },
        { stat: "rush_td", points: 6 },
        { stat: "rush_yds", gte: 100, points: 3 },
        {
          stat: "def_pts_allowed",
          tiers: [
            { min: 0, max: 6, points: 1 },
            { min: 7, points: 0 },
          ],
        },
        {
          stat: "fg_made",
          tiers: [
            { min: 50, points: 5 },
            { min: 0, max: 49, points: 3 },
          ],
        },
        { stat: "xp_made", points: 1, positions: ["K"] },
      ),
    );
    expect(rs.rounding).toBe(2);
    expect(rs.rules.map((r) => r.kind)).toEqual([
      "per_unit",
      "per_unit",
      "per_event",
      "bonus",
      "tiers",
      "distance_tiers",
      "per_event",
    ]);
    expect(rs.rules[0]).toMatchObject({ per: 10, fractional: false });
    expect(rs.rules[1]).toMatchObject({ fractional: true, label: "frac" });
    // tiers are stored sorted by min
    expect(rs.rules[5]).toMatchObject({ tiers: [{ min: 0 }, { min: 50 }] });
    expect(rs.rules[6]).toMatchObject({ positions: ["K"] });
  });

  it("accepts a matching explicit type", () => {
    expect(() =>
      parseRuleset(wrap({ stat: "rush_td", type: "per_event", points: 6 })),
    ).not.toThrow();
  });

  it("rejects a mismatched type", () => {
    expect(errorsOf(wrap({ stat: "rush_td", type: "bonus", points: 6 }))).toEqual([
      'rules[0]: rush_td: type "bonus" does not match its fields (they describe a per_event rule)',
    ]);
    expect(
      errorsOf(
        wrap({ stat: "def_sack", type: "distance_tiers", tiers: [{ min: 0, points: 1 }] }),
      )[0],
    ).toMatch(/describe a tiers rule/);
  });

  it("rejects unknown stat keys, naming the known ones", () => {
    const [msg] = errorsOf(wrap({ stat: "two_pt", points: 2 }));
    expect(msg).toMatch(/^rules\[0\].stat: unknown stat key "two_pt"; known keys: pass_yds/);
  });

  it("rejects unknown fields, bad positions and bad numbers", () => {
    expect(errorsOf(wrap({ stat: "rush_td", points: 6, bogus: 1 })).length).toBe(1);
    expect(errorsOf(wrap({ stat: "rush_td", points: 6, positions: ["LB"] })).length).toBe(1);
    expect(errorsOf(wrap({ stat: "rush_td", points: 6, positions: [] })).length).toBe(1);
    expect(errorsOf(wrap({ stat: "rush_yds", points: 1, per: 0 })).length).toBe(1);
    expect(errorsOf(wrap({ stat: "rush_yds", points: 1.00001, per: 10 }))[0]).toMatch(
      /at most 4 decimal/,
    );
  });

  it("rejects missing or conflicting fields", () => {
    expect(errorsOf(wrap({ stat: "rush_td" }))[0]).toMatch(/needs points, or tiers/);
    expect(errorsOf(wrap({ stat: "rush_yds", gte: 100 }))[0]).toMatch(/needs points, or tiers/);
    expect(errorsOf(wrap({ stat: "rush_yds", gte: 100, points: 3, per: 10 }))[0]).toMatch(
      /bonus rule/,
    );
    expect(errorsOf(wrap({ stat: "rush_yds", gte: 100, points: 3, fractional: true }))[0]).toMatch(
      /bonus rule/,
    );
    expect(errorsOf(wrap({ stat: "rush_td", points: 6, fractional: true }))[0]).toMatch(
      /only applies to a rule with per/,
    );
    expect(
      errorsOf(wrap({ stat: "def_sack", points: 1, tiers: [{ min: 0, points: 1 }] }))[0],
    ).toMatch(/cannot also have/);
    expect(errorsOf(wrap({ stat: "def_sack", per: 2, tiers: [{ min: 0, points: 1 }] }))[0]).toMatch(
      /cannot also have/,
    );
    expect(errorsOf(wrap({ stat: "def_sack", gte: 2, tiers: [{ min: 0, points: 1 }] }))[0]).toMatch(
      /cannot also have/,
    );
    expect(
      errorsOf(wrap({ stat: "def_sack", fractional: true, tiers: [{ min: 0, points: 1 }] }))[0],
    ).toMatch(/cannot also have/);
  });
});

describe("tier validation", () => {
  const tiers = (t: unknown[]) => wrap({ stat: "def_pts_allowed", tiers: t });
  it("rejects overlaps, gaps, a missing 0 start, closed last bands and open middle bands", () => {
    expect(
      errorsOf(
        tiers([
          { min: 0, max: 6, points: 1 },
          { min: 6, points: 0 },
        ]),
      )[0],
    ).toMatch(/overlap: 0-6 and 6\+/);
    expect(
      errorsOf(
        tiers([
          { min: 0, max: 6, points: 1 },
          { min: 8, points: 0 },
        ]),
      )[0],
    ).toMatch(/nothing covers 7..7/);
    expect(errorsOf(tiers([{ min: 1, points: 1 }]))[0]).toMatch(/must start at 0/);
    expect(errorsOf(tiers([{ min: 0, max: 6, points: 1 }]))[0]).toMatch(
      /last tier must be open-ended/,
    );
    expect(
      errorsOf(
        tiers([
          { min: 0, points: 1 },
          { min: 7, points: 0 },
        ]),
      )[0],
    ).toMatch(/open-ended but is followed/);
    expect(
      errorsOf(
        tiers([
          { min: 5, max: 2, points: 1 },
          { min: 6, points: 0 },
        ]),
      )[0],
    ).toMatch(/max below min/);
  });
});

describe("ruleset envelope", () => {
  it("checks version, rounding and rules", () => {
    expect(errorsOf({ version: 0, rules: [] })).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^version/),
        "rules: a ruleset needs at least one rule",
      ]),
    );
    expect(
      errorsOf({ version: 1, rounding: 5, rules: [{ stat: "rush_td", points: 6 }] })[0],
    ).toMatch(/^rounding/);
    expect(errorsOf("nope").length).toBe(1);
    expect(
      errorsOf({ version: 1, rules: [{ stat: "rush_td", points: 6 }], extra: true }).length,
    ).toBe(1);
  });

  it("parseRuleset throws every problem on its own line", () => {
    expect(() => parseRuleset({ version: 1, rules: [{ stat: "x" }, { stat: "rush_td" }] })).toThrow(
      /^Invalid ruleset:\n- rules\[0\]\.stat: unknown stat key "x".*\n- rules\[1\]/s,
    );
  });

  it("safeParseRuleset also returns structured issues keyed by rule index", () => {
    const r = safeParseRuleset({
      version: 1,
      rounding: 9,
      rules: [
        { stat: "rush_td", points: 6 },
        { stat: "rush_yds", points: 1, per: 0 },
        { stat: "fg_made", tiers: [{ min: 1, points: 3 }] },
      ],
    });
    if (r.ok) throw new Error("expected failure");
    expect(r.issues).toEqual([
      { message: expect.stringMatching(/^rounding: /) },
      { ruleIndex: 1, field: "per", message: expect.any(String) },
      { ruleIndex: 2, message: expect.stringMatching(/^fg_made: tiers must start at 0/) },
    ]);
    expect(r.issues).toHaveLength(r.errors.length);
    const empty = safeParseRuleset({ version: 1, rules: [] });
    if (empty.ok) throw new Error("expected failure");
    expect(empty.issues).toEqual([{ message: "rules: a ruleset needs at least one rule" }]);
  });
});
