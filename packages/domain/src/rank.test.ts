import { describe, expect, it } from "vitest";
import { compareByRank, type RankSortable } from "./rank";

const seeds = new Map([
  ["AAA", 1],
  ["BBB", 2],
]);
const p = (
  name: string,
  position: string,
  nflTeam: string,
  rank?: number | null,
): RankSortable => ({
  name,
  position,
  nflTeam,
  rank,
});
const order = (xs: RankSortable[]) =>
  [...xs].sort((a, b) => compareByRank(a, b, seeds)).map((x) => x.name);

describe("compareByRank", () => {
  it("orders by rank ascending regardless of position", () => {
    expect(
      order([p("C", "K", "AAA", 30), p("A", "QB", "AAA", 2), p("B", "RB", "BBB", 10)]),
    ).toEqual(["A", "B", "C"]);
  });

  it("breaks equal ranks by name", () => {
    expect(order([p("Zed", "WR", "AAA", 5), p("Abe", "RB", "BBB", 5)])).toEqual(["Abe", "Zed"]);
  });

  it("puts ranked before unranked, in both argument orders", () => {
    expect(order([p("U", "QB", "AAA", null), p("R", "QB", "AAA", 900)])).toEqual(["R", "U"]);
    expect(order([p("R", "QB", "AAA", 900), p("U", "QB", "AAA")])).toEqual(["R", "U"]);
  });

  it("orders unranked D/STs before other unranked players, by seed, then name", () => {
    expect(
      order([
        p("Zoe Kicker", "K", "AAA"),
        p("B Defense", "DST", "BBB"),
        p("A Defense", "DST", "AAA"),
        p("Ann Punter", "K", "BBB"),
        p("X Defense", "DST", "AAA"),
      ]),
    ).toEqual(["A Defense", "X Defense", "B Defense", "Ann Punter", "Zoe Kicker"]);
    expect(order([p("Ann Punter", "K", "BBB"), p("B Defense", "DST", "BBB")])).toEqual([
      "B Defense",
      "Ann Punter",
    ]);
  });

  it("sorts a D/ST on a team with no seed last among D/STs", () => {
    expect(order([p("Q Defense", "DST", "ZZZ"), p("A Defense", "DST", "BBB")])).toEqual([
      "A Defense",
      "Q Defense",
    ]);
    expect(order([p("A Defense", "DST", "BBB"), p("Q Defense", "DST", "ZZZ")])).toEqual([
      "A Defense",
      "Q Defense",
    ]);
  });
});
