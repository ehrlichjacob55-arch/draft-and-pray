import { describe, expect, it } from "vitest";
import {
  POSITIONS,
  ROSTER_SIZE,
  ROUNDS,
  SLOTS,
  SLOT_PREFERENCE,
  TEAM_COUNT,
  TOTAL_PICKS,
} from "./index";

describe("roster constants", () => {
  it("has consistent sizes", () => {
    expect(SLOTS).toHaveLength(ROSTER_SIZE);
    expect(ROUNDS).toBe(ROSTER_SIZE);
    expect(TOTAL_PICKS).toBe(TEAM_COUNT * ROUNDS);
    expect(new Set(SLOTS).size).toBe(SLOTS.length);
  });

  it("covers every position and only references real slots", () => {
    expect(Object.keys(SLOT_PREFERENCE).sort()).toEqual([...POSITIONS].sort());
    for (const prefs of Object.values(SLOT_PREFERENCE)) {
      for (const s of prefs) expect(SLOTS).toContain(s);
    }
  });

  it("makes every slot reachable from some position", () => {
    const reachable = new Set(Object.values(SLOT_PREFERENCE).flat());
    for (const s of SLOTS) expect(reachable.has(s)).toBe(true);
  });
});
