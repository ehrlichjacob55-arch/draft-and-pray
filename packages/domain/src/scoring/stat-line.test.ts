import { describe, expect, it } from "vitest";
import { applyOverrides, parseStatLine } from "./stat-line";
import { isEventStat, isStatKey } from "./stat-keys";

describe("stat keys", () => {
  it("recognizes canonical keys", () => {
    expect(isStatKey("rush_yds")).toBe(true);
    expect(isStatKey("two_pt")).toBe(false);
    expect(isEventStat("fg_made")).toBe(true);
    expect(isEventStat("rush_yds")).toBe(false);
  });
});

describe("parseStatLine", () => {
  it("accepts counts-only and consistent event lists", () => {
    expect(parseStatLine({ counts: { rush_yds: 10 } })).toEqual({ counts: { rush_yds: 10 } });
    expect(parseStatLine({ counts: { fg_made: 2 }, events: { fg_made: [30, 45] } })).toEqual({
      counts: { fg_made: 2 },
      events: { fg_made: [30, 45] },
    });
  });
  it("fills a missing count from the distances and leaves other event stats alone", () => {
    expect(parseStatLine({ counts: { xp_made: 1 }, events: { fg_missed: [52] } })).toEqual({
      counts: { xp_made: 1, fg_missed: 1 },
      events: { fg_missed: [52] },
    });
  });
  it("rejects count/distance mismatches, unknown keys and non-integers", () => {
    expect(() => parseStatLine({ counts: { fg_made: 3 }, events: { fg_made: [30] } })).toThrow(
      "Invalid stat line: fg_made count is 3 but 1 distances are listed",
    );
    expect(() => parseStatLine({ counts: { bogus: 1 } })).toThrow(/Invalid stat line/);
    expect(() => parseStatLine({ counts: { rush_yds: 1.5 } })).toThrow(/Invalid stat line/);
    expect(() => parseStatLine({ counts: {}, extra: 1 })).toThrow(/Invalid stat line/);
  });
});

describe("applyOverrides", () => {
  it("replaces counts and reports the overridden keys", () => {
    const r = applyOverrides({ counts: { rush_td: 1, rush_yds: 50 } }, { rush_td: 2, rec: 3 });
    expect(r.statLine).toEqual({ counts: { rush_td: 2, rush_yds: 50, rec: 3 } });
    expect(r.overridden).toEqual(["rush_td", "rec"]);
  });
  it("does not mutate the input", () => {
    const line = { counts: { rush_td: 1 }, events: { fg_made: [30] } };
    applyOverrides(line, { rush_td: 0, fg_made: 0 });
    expect(line).toEqual({ counts: { rush_td: 1 }, events: { fg_made: [30] } });
  });
  it("keeps the first N distances when a distance stat is lowered, and the list when unchanged", () => {
    const line = { counts: { fg_made: 3 }, events: { fg_made: [20, 45, 55] } };
    expect(applyOverrides(line, { fg_made: 2 }).statLine).toEqual({
      counts: { fg_made: 2 },
      events: { fg_made: [20, 45] },
    });
    expect(applyOverrides(line, { fg_made: 3 }).statLine.events).toEqual({ fg_made: [20, 45, 55] });
  });
  it("overrides a distance stat that has no list, and other keys beside a list", () => {
    expect(applyOverrides({ counts: { fg_made: 1 } }, { fg_made: 2 }).statLine).toEqual({
      counts: { fg_made: 2 },
    });
    expect(
      applyOverrides({ counts: { fg_made: 1 }, events: { fg_made: [30] } }, { fg_missed: 1 })
        .statLine,
    ).toEqual({ counts: { fg_made: 1, fg_missed: 1 }, events: { fg_made: [30] } });
  });
  it("rejects raising a distance stat above its list, unknown keys and fractions", () => {
    expect(() =>
      applyOverrides({ counts: { fg_made: 1 }, events: { fg_made: [30] } }, { fg_made: 2 }),
    ).toThrow("Override fg_made=2 exceeds the 1 recorded distances");
    expect(() => applyOverrides({ counts: {} }, { two_pt: 1 } as never)).toThrow(
      "Unknown stat key in override: two_pt",
    );
    expect(() => applyOverrides({ counts: {} }, { rush_td: 1.5 })).toThrow(
      "Override rush_td must be an integer",
    );
  });
});
