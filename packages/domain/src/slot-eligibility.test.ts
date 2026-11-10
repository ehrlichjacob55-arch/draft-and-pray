import { describe, expect, it } from "vitest";
import { POSITIONS, SLOTS, type Position, type Slot } from "./roster";
import { assignSlot, eligiblePositions, isDraftable } from "./slot-eligibility";

const BIG = { QB: 50, RB: 50, WR: 50, TE: 50, K: 50, DST: 50 } as const;

describe("assignSlot", () => {
  it("uses the most specific slot first", () => {
    expect(assignSlot("RB", [])).toBe("RB1");
    expect(assignSlot("RB", ["RB1"])).toBe("RB2");
    expect(assignSlot("RB", ["RB1", "RB2"])).toBe("FLEX1");
    expect(assignSlot("RB", ["RB1", "RB2", "FLEX1"])).toBe("FLEX2");
    expect(assignSlot("RB", ["RB1", "RB2", "FLEX1", "FLEX2"])).toBeNull();
    expect(assignSlot("TE", ["TE"])).toBe("FLEX1");
    expect(assignSlot("QB", ["QB"])).toBeNull();
    expect(assignSlot("K", [])).toBe("K");
    expect(assignSlot("DST", new Set<Slot>(["DST"]))).toBeNull();
  });
});

describe("eligiblePositions", () => {
  it("lists positions with an open slot", () => {
    expect(eligiblePositions([])).toEqual([...POSITIONS]);
    expect(eligiblePositions(["QB", "K"])).toEqual(["RB", "WR", "TE", "DST"]);
    expect(eligiblePositions(["RB1", "RB2", "WR1", "WR2", "TE", "FLEX1", "FLEX2"])).toEqual([
      "QB",
      "K",
      "DST",
    ]);
  });
});

describe("isDraftable", () => {
  it("is false without an open slot or without supply", () => {
    expect(isDraftable("QB", ["QB"], BIG)).toBe(false);
    expect(isDraftable("QB", [], { ...BIG, QB: 0 })).toBe(false);
    expect(isDraftable("QB", [], {})).toBe(false);
  });

  it("is true for a normal pick with a big pool", () => {
    for (const p of POSITIONS) expect(isDraftable(p, [], BIG)).toBe(true);
  });

  it("guards against dead ends", () => {
    // Only one K left, and the team still needs K: taking the last RB-eligible... K itself is fine.
    expect(isDraftable("K", [], { ...BIG, K: 1 })).toBe(true);
    // No kicker left at all after this pick means a K slot can never be filled.
    expect(isDraftable("QB", [], { ...BIG, K: 0 })).toBe(false);
    // Flex supply: one WR left must fill WR1/WR2/FLEX needs, so the team cannot finish.
    const filled: Slot[] = ["QB", "RB1", "RB2", "WR1", "TE", "FLEX1", "FLEX2", "K", "DST"];
    expect(isDraftable("WR", filled, { ...BIG, WR: 1 })).toBe(true);
    // Remaining flex slots need extra RB/WR/TE beyond base needs.
    const f2: Slot[] = ["QB", "RB1", "RB2", "WR1", "WR2", "TE", "K", "DST"];
    expect(isDraftable("RB", f2, { QB: 5, RB: 1, WR: 0, TE: 0, K: 5, DST: 5 })).toBe(false);
    expect(isDraftable("RB", f2, { QB: 5, RB: 2, WR: 0, TE: 0, K: 5, DST: 5 })).toBe(true);
  });
});

describe("properties (seeded random sequences)", () => {
  function rng(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("any pick sequence that fits always fills all 10 slots, and FLEX is never used early", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const filled: Slot[] = [];
      let guard = 0;
      while (filled.length < SLOTS.length && guard++ < 500) {
        const pos = POSITIONS[Math.floor(r() * POSITIONS.length)] as Position;
        const slot = assignSlot(pos, filled);
        if (slot === null) continue;
        if (slot === "FLEX1" || slot === "FLEX2") {
          // A matching base slot must be full.
          const base = { RB: ["RB1", "RB2"], WR: ["WR1", "WR2"], TE: ["TE"] }[
            pos as "RB" | "WR" | "TE"
          ] as Slot[];
          for (const b of base) expect(filled).toContain(b);
        }
        expect(filled).not.toContain(slot);
        filled.push(slot);
      }
      expect(new Set(filled)).toEqual(new Set(SLOTS));
    }
  });

  it("exhaustive: draftable picks never strand a team when the pool is plentiful", () => {
    for (let mask = 0; mask < 1 << 10; mask++) {
      const filled = SLOTS.filter((_, i) => mask & (1 << i));
      for (const p of POSITIONS)
        expect(isDraftable(p, filled, BIG)).toBe(assignSlot(p, filled) !== null);
    }
  });
});
