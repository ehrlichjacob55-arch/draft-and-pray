import { describe, expect, it } from "vitest";
import { defaultAbbr } from "./team-abbr";

describe("defaultAbbr", () => {
  it.each([
    ["Team Alpha", "ALPH"],
    ["Team Smith", "SMIT"],
    ["team smith", "SMIT"],
    ["TEAM   Smith", "SMIT"],
    ["Red Zone", "REDZ"],
    ["Team Al", "AL"],
    ["Team O'Brien-Lee", "OBRI"],
    ["Team", "TEAM"],
    ["Team X", "TM"],
    ["!!", "TM"],
    ["", "TM"],
    ["Teammates", "TEAM"],
  ])("%s -> %s", (name, abbr) => {
    expect(defaultAbbr(name, [])).toBe(abbr);
  });

  it("replaces the last character with 2, 3, … on a clash (case-insensitive)", () => {
    expect(defaultAbbr("Team Smith", ["SMIT"])).toBe("SMI2");
    expect(defaultAbbr("Team Smith", ["smit", "SMI2"])).toBe("SMI3");
    expect(defaultAbbr("Team Al", ["AL"])).toBe("A2");
    expect(defaultAbbr("Team X", ["TM", "T2"])).toBe("T3");
  });

  it("keeps the length at most 4 for two-digit suffixes", () => {
    const taken = ["SMIT", ...Array.from({ length: 8 }, (_, i) => `SMI${i + 2}`)];
    const out = defaultAbbr("Team Smith", taken);
    expect(out).toBe("SM10");
    expect(out.length).toBeLessThanOrEqual(4);
  });

  it("accepts any iterable", () => {
    expect(defaultAbbr("Team Smith", new Set(["SMIT"]))).toBe("SMI2");
  });
});
