import { describe, expect, it } from "vitest";
import {
  draftPositionOnClock,
  indexInRound,
  nextPickFor,
  picksForPosition,
  picksUntilTurn,
  roundOf,
  teamOnClock,
} from "./draft-order";

const ORDER = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"];

describe("pick math", () => {
  it("matches the 03 §1 table", () => {
    expect(roundOf(1)).toBe(1);
    expect(roundOf(9)).toBe(1);
    expect(roundOf(10)).toBe(2);
    expect(roundOf(90)).toBe(10);
    expect(indexInRound(1)).toBe(0);
    expect(indexInRound(9)).toBe(8);
    expect(indexInRound(10)).toBe(0);
    const round = (r: number) =>
      Array.from({ length: 9 }, (_, i) => draftPositionOnClock((r - 1) * 9 + i + 1));
    expect(round(1)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(round(2)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(round(3)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(round(10)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it("rejects out-of-range input", () => {
    for (const bad of [0, 91, 1.5, -1, Number.NaN]) {
      expect(() => roundOf(bad)).toThrow(RangeError);
      expect(() => indexInRound(bad)).toThrow(RangeError);
      expect(() => draftPositionOnClock(bad)).toThrow(RangeError);
    }
    for (const bad of [0, 10, 2.5]) expect(() => picksForPosition(bad)).toThrow(RangeError);
    expect(() => teamOnClock(1, ORDER.slice(1))).toThrow(RangeError);
  });

  it("maps the on-clock team through the order", () => {
    expect(teamOnClock(1, ORDER)).toBe("t1");
    expect(teamOnClock(9, ORDER)).toBe("t9");
    expect(teamOnClock(10, ORDER)).toBe("t9");
    expect(teamOnClock(18, ORDER)).toBe("t1");
  });
});

describe("per-position queries", () => {
  it("lists a position's ten picks", () => {
    expect(picksForPosition(1)).toEqual([1, 18, 19, 36, 37, 54, 55, 72, 73, 90]);
    expect(picksForPosition(9)).toEqual([9, 10, 27, 28, 45, 46, 63, 64, 81, 82]);
  });

  it("finds the next pick", () => {
    expect(nextPickFor(1, 0)).toBe(1);
    expect(nextPickFor(1, 1)).toBe(18);
    expect(nextPickFor(1, 90)).toBeNull();
    expect(nextPickFor(9, 9)).toBe(10);
  });

  it("counts picks until the turn", () => {
    expect(picksUntilTurn(1, 1)).toBe(0);
    expect(picksUntilTurn(1, 2)).toBe(16);
    expect(picksUntilTurn(5, 1)).toBe(4);
    expect(picksUntilTurn(1, 90)).toBe(0);
    expect(picksUntilTurn(2, 90)).toBeNull();
  });
});

describe("properties", () => {
  it("every position gets exactly 10 picks, 1..90 each used once, snake reversal holds", () => {
    const seen = new Map<number, number[]>();
    for (let pick = 1; pick <= 90; pick++) {
      const pos = draftPositionOnClock(pick);
      seen.set(pos, [...(seen.get(pos) ?? []), pick]);
    }
    expect([...seen.keys()].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const [pos, picks] of seen) {
      expect(picks).toHaveLength(10);
      expect(picks).toEqual(picksForPosition(pos));
    }
    expect([...seen.values()].flat().sort((a, b) => a - b)).toEqual(
      Array.from({ length: 90 }, (_, i) => i + 1),
    );
    // Back-to-back picks around each round turn belong to the same position.
    for (let r = 1; r < 10; r++)
      expect(draftPositionOnClock(r * 9)).toBe(draftPositionOnClock(r * 9 + 1));
  });
});
