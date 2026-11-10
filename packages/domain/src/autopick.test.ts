import { describe, expect, it } from "vitest";
import { chooseAutopick, POSITION_ORDER, type AutopickCandidate } from "./autopick";
import { SLOTS, type Position, type Slot } from "./roster";

const c = (
  playerId: string,
  name: string,
  position: Position,
  nflTeam: string,
): AutopickCandidate => ({ playerId, name, position, nflTeam });

const SEEDS = { AAA: 1, BBB: 2, CCC: 3 };

/** Low-priority filler so the dead-end guard (enough players left to finish a roster) passes. */
const FILL: AutopickCandidate[] = [];
for (const [pos, n] of [
  ["QB", 3],
  ["RB", 6],
  ["WR", 6],
  ["TE", 4],
  ["K", 2],
  ["DST", 2],
] as const)
  for (let i = 0; i < n; i++) FILL.push(c(`f-${pos}${i}`, `Zzz ${pos} ${i}`, pos, "ZZZ"));

const POOL: AutopickCandidate[] = [
  c("q1", "Zed Quarterback", "QB", "CCC"),
  c("q2", "Amy Quarterback", "QB", "AAA"),
  c("r1", "Rob Runner", "RB", "BBB"),
  c("r2", "Al Runner", "RB", "BBB"),
  c("w1", "Wes Wideout", "WR", "AAA"),
  c("t1", "Tom Tight", "TE", "CCC"),
  c("k1", "Kyle Kicker", "K", "BBB"),
  c("d1", "DST-AAA", "DST", "AAA"),
  ...FILL,
];

describe("POSITION_ORDER", () => {
  it("covers every slot exactly once", () => {
    expect([...POSITION_ORDER].sort()).toEqual([...SLOTS].sort());
  });
});

describe("chooseAutopick", () => {
  it("takes the top queued player that is available and eligible", () => {
    const r = chooseAutopick({
      queue: ["missing", "q2", "r1"],
      available: POOL,
      filledSlots: ["QB"],
      nflTeamSeeds: SEEDS,
    });
    // q2 is not eligible (QB filled); r1 is.
    expect(r).toEqual({ playerId: "r1", slot: "RB1" });
  });

  it("falls back to position order, seed ascending then name", () => {
    const first = chooseAutopick({
      queue: [],
      available: POOL,
      filledSlots: [],
      nflTeamSeeds: SEEDS,
    });
    expect(first).toEqual({ playerId: "q2", slot: "QB" }); // seed 1 beats seed 3
    const rb = chooseAutopick({
      queue: [],
      available: POOL,
      filledSlots: ["QB"],
      nflTeamSeeds: SEEDS,
    });
    expect(rb).toEqual({ playerId: "r2", slot: "RB1" }); // same seed -> name A-Z
  });

  it("puts unknown-seed teams last and breaks full ties by id", () => {
    const pool = [...FILL, c("b", "Same Name", "RB", "YYY"), c("a", "Same Name", "RB", "YYY")];
    const r = chooseAutopick({ queue: [], available: pool, filledSlots: ["QB"], nflTeamSeeds: {} });
    expect(r?.playerId).toBe("a");
  });

  it("returns null when the remaining slots can no longer be filled", () => {
    const r = chooseAutopick({
      queue: ["w1"],
      available: [c("w1", "Wes Wideout", "WR", "AAA")],
      filledSlots: [],
      nflTeamSeeds: SEEDS,
    });
    expect(r).toBeNull();
  });

  it("uses FLEX only after base slots are full", () => {
    const filled: Slot[] = ["QB", "RB1", "RB2", "WR1", "WR2", "TE"];
    const r = chooseAutopick({
      queue: [],
      available: [c("r9", "Extra Runner", "RB", "AAA"), ...FILL],
      filledSlots: filled,
      nflTeamSeeds: SEEDS,
    });
    expect(r).toEqual({ playerId: "r9", slot: "FLEX1" });
  });

  it("returns null when the roster is full or the pool is empty", () => {
    expect(
      chooseAutopick({ queue: [], available: POOL, filledSlots: [...SLOTS], nflTeamSeeds: SEEDS }),
    ).toBeNull();
    expect(
      chooseAutopick({ queue: ["q1"], available: [], filledSlots: [], nflTeamSeeds: SEEDS }),
    ).toBeNull();
  });

  it("fills a roster completely from a plentiful pool", () => {
    const pool: AutopickCandidate[] = [];
    for (const [pos, n] of [
      ["QB", 3],
      ["RB", 6],
      ["WR", 6],
      ["TE", 4],
      ["K", 2],
      ["DST", 2],
    ] as const)
      for (let i = 0; i < n; i++)
        pool.push(c(`${pos}${i}`, `${pos} ${i}`, pos, i % 2 ? "AAA" : "BBB"));
    const filled: Slot[] = [];
    let avail = pool;
    for (let i = 0; i < 10; i++) {
      const r = chooseAutopick({
        queue: [],
        available: avail,
        filledSlots: filled,
        nflTeamSeeds: SEEDS,
      });
      expect(r).not.toBeNull();
      filled.push(r!.slot);
      avail = avail.filter((p) => p.playerId !== r!.playerId);
    }
    expect(new Set(filled)).toEqual(new Set(SLOTS));
  });
});
