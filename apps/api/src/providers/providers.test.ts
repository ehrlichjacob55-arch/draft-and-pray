import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toEspnAbbr, toSleeperAbbr } from "./abbreviations";
import { createRealPoolSource, PROVIDER_USER_AGENT } from "./index";
import { parseEspnStandings } from "./espn";
import { parseSleeperPlayers, parseSleeperPlayersWithWarnings } from "./sleeper";
import { composePoolSource, parseSleeperStats, statLine } from "./index";
import { PoolSourceError } from "./types";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8"));
const espn = () => fixture("espn-standings-2025.trimmed.json");
const sleeper = () => fixture("sleeper-players.trimmed.json");

describe("abbreviation map", () => {
  it("maps the only differing team and is the identity elsewhere", () => {
    expect(toSleeperAbbr("WSH")).toBe("WAS");
    expect(toEspnAbbr("WAS")).toBe("WSH");
    expect(toSleeperAbbr("KC")).toBe("KC");
    expect(toEspnAbbr("KC")).toBe("KC");
  });
});

describe("parseEspnStandings", () => {
  it("returns the 14-team field with seeds 1-7 per conference", () => {
    const field = parseEspnStandings(espn());
    expect(field).toHaveLength(14);
    const afc = field.filter((t) => t.conference === "AFC");
    expect(afc.map((t) => t.seed)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(afc[0]).toMatchObject({ abbr: "DEN", name: "Denver Broncos" });
    expect(field.find((t) => t.conference === "NFC" && t.seed === 1)?.abbr).toBe("SEA");
  });

  it("refuses an odd field", () => {
    const bad = espn();
    bad.children[0].standings.entries.pop();
    expect(() => parseEspnStandings(bad)).toThrow(/7 distinct playoff seeds for the AFC/);
    const dup = espn();
    dup.children[1].standings.entries[1].stats[0].value = 1;
    expect(() => parseEspnStandings(dup)).toThrow(PoolSourceError);
    const dupTeam = espn();
    dupTeam.children[1].standings.entries[1].team.abbreviation =
      dupTeam.children[0].standings.entries[0].team.abbreviation;
    expect(() => parseEspnStandings(dupTeam)).toThrow(/twice/);
    expect(() => parseEspnStandings({})).toThrow(/unexpected shape/);
  });

  it("recognizes conferences by abbreviation and ignores unknown groups", () => {
    const j = espn();
    j.children[0].name = "x";
    j.children[0].abbreviation = "AFC";
    j.children.push({ name: "Other", standings: { entries: [] } });
    expect(parseEspnStandings(j)).toHaveLength(14);
  });
});

describe("parseSleeperPlayers", () => {
  const field = [
    { abbr: "NE", name: "New England Patriots", conference: "AFC" as const, seed: 2 },
    { abbr: "DEN", name: "Denver Broncos", conference: "AFC" as const, seed: 1 },
    { abbr: "WSH", name: "Washington Commanders", conference: "NFC" as const, seed: 7 },
  ];

  it("keeps active QB/RB/WR/TE/K on field teams and maps WAS to WSH", () => {
    const players = parseSleeperPlayers(sleeper(), field);
    expect(players.length).toBeGreaterThan(15);
    expect(new Set(players.map((p) => p.nflTeam))).toEqual(new Set(["NE", "DEN", "WSH"]));
    expect(players.every((p) => ["QB", "RB", "WR", "TE", "K"].includes(p.position))).toBe(true);
    expect(players.every((p) => p.providerPlayerId)).toBe(true);
    expect(players.some((p) => p.injuryStatus === "Questionable")).toBe(true);
    // Excludes: KC (not in field), inactive, free agents, DEF.
    expect(players.some((p) => p.nflTeam === "KC")).toBe(false);
    expect(players.some((p) => (p.position as string) === "DEF")).toBe(false);
  });

  it("maps search_rank to rank; huge, missing or invalid values become null", () => {
    const players = parseSleeperPlayers(sleeper(), field);
    const rank = (name: string) => players.find((p) => p.name === name)?.rank;
    expect(rank("Bo Nix")).toBe(15);
    expect(rank("Drake Maye")).toBe(22);
    expect(rank("Stefon Diggs")).toBe(240);
    expect(rank("Jaylen Waddle")).toBeNull(); // 9_999_999
    expect(rank("Wil Lutz")).toBeNull(); // missing
    expect(players.every((p) => p.rank == null || p.rank > 0)).toBe(true);
    const odd = parseSleeperPlayers(
      {
        a: {
          player_id: "1",
          full_name: "A",
          position: "QB",
          team: "NE",
          status: "Active",
          depth_chart_order: 1,
          search_rank: "5",
        },
        b: {
          player_id: "2",
          full_name: "B",
          position: "QB",
          team: "NE",
          status: "Active",
          depth_chart_order: 1,
          search_rank: 0,
        },
        c: {
          player_id: "3",
          full_name: "C",
          position: "QB",
          team: "NE",
          status: "Active",
          depth_chart_order: 1,
          search_rank: 12_000_000,
        },
        d: {
          player_id: "4",
          full_name: "D",
          position: "QB",
          team: "NE",
          status: "Active",
          depth_chart_order: 1,
          search_rank: 7,
        },
      },
      [field[0]!],
    );
    expect(odd.map((p) => p.rank)).toEqual([null, null, null, 7]);
  });

  describe("depth-chart filter", () => {
    const pit = { abbr: "PIT", name: "Pittsburgh Steelers", conference: "AFC" as const, seed: 4 };
    const withPit = [...field, pit];

    it("excludes retired and practice-squad records without a depth chart", () => {
      const { players } = parseSleeperPlayersWithWarnings(sleeper(), withPit);
      const names = players.map((p) => p.name);
      expect(names).not.toContain("Ben Roethlisberger");
      expect(names).not.toContain("Practice Squad Wr");
      expect(names).toContain("Aaron Rodgers");
      expect(names).toContain("Drake Maye");
      expect(players.filter((p) => p.nflTeam === "PIT")).toHaveLength(1);
    });

    it("falls back to non-depth-chart players for an uncovered position, with a warning", () => {
      const { players, warnings } = parseSleeperPlayersWithWarnings(sleeper(), withPit);
      expect(players.find((p) => p.name === "Drew Stevens")).toMatchObject({
        position: "K",
        nflTeam: "WSH",
        depthChartOrder: null,
      });
      expect(warnings).toEqual(["WSH K: no depth-chart players; included 1 without depth chart"]);
    });

    it("emits no warnings when every position is covered and the wrapper returns players", () => {
      const json = sleeper();
      json["13968"].depth_chart_order = 1;
      expect(parseSleeperPlayersWithWarnings(json, field).warnings).toEqual([]);
      expect(parseSleeperPlayers(sleeper(), field)).toHaveLength(
        parseSleeperPlayersWithWarnings(sleeper(), field).players.length,
      );
    });
  });

  it("fails loudly when a field team has no players or the shape is wrong", () => {
    expect(() =>
      parseSleeperPlayers(sleeper(), [
        ...field,
        { abbr: "ZZZ", name: "Nowhere", conference: "NFC", seed: 3 },
      ]),
    ).toThrow(/no active players for: ZZZ/);
    expect(() => parseSleeperPlayers([], field)).toThrow(PoolSourceError);
    expect(() => parseSleeperPlayers(null, field)).toThrow(PoolSourceError);
  });

  it("normalizes odd records", () => {
    const players = parseSleeperPlayers(
      {
        a: {
          player_id: "1",
          first_name: "Fi",
          last_name: "La",
          position: "QB",
          team: "NE",
          status: "Active",
          injury_status: "NA",
          depth_chart_order: 1.5,
        },
        b: { player_id: "2", full_name: "Bee", position: "K", team: "DEN", status: "Active" },
        c: { player_id: "3", position: "K", team: "WAS", status: "Active" },
        d: null,
        e: {
          player_id: "4",
          full_name: "Cee",
          position: "RB",
          team: "WAS",
          status: "Active",
          depth_chart_order: 2,
        },
      },
      field,
    );
    expect(players.find((p) => p.providerPlayerId === "1")).toMatchObject({
      name: "Fi La",
      injuryStatus: null,
      depthChartOrder: null,
    });
    expect(players.find((p) => p.providerPlayerId === "4")?.depthChartOrder).toBe(2);
    // a, e have depth entries; b is DEN's only K (kept by the safety net); c has no name.
    expect(players).toHaveLength(3);
  });
});

describe("createRealPoolSource", () => {
  it("fetches both sources with a descriptive User-Agent (no network)", async () => {
    const calls: { url: string; ua: string | null }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, ua: new Headers(init?.headers).get("user-agent") });
      if (url.includes("espn")) return new Response(JSON.stringify(espn()));
      return new Response(JSON.stringify(sleeper()));
    };
    // The trimmed Sleeper fixture covers only NE/DEN/WAS, so the full field must be refused.
    await expect(createRealPoolSource({ fetchImpl }).load(2025)).rejects.toThrow(
      /no active players for/,
    );
    expect(calls[0]?.url).toContain("season=2025");
    expect(calls.every((c) => c.ua === PROVIDER_USER_AGENT)).toBe(true);
    expect(PROVIDER_USER_AGENT).not.toMatch(/@/);
  });

  it("reports transport and HTTP failures as PoolSourceError", async () => {
    const down = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(createRealPoolSource({ fetchImpl: down }).load(2025)).rejects.toThrow(
      /could not be reached/,
    );
    const bad = async () => new Response("nope", { status: 503 });
    await expect(createRealPoolSource({ fetchImpl: bad }).load(2025)).rejects.toThrow(/HTTP 503/);
    const junk = async () => new Response("not json");
    await expect(createRealPoolSource({ fetchImpl: junk }).load(2025)).rejects.toThrow(
      /invalid JSON/,
    );
  });
});

describe("Sleeper stats mapping", () => {
  const stats = () => fixture("sleeper-stats-2025.trimmed.json");

  it("keeps only the listed keys per position and turns floats into integers", () => {
    const s = parseSleeperStats(stats());
    expect(s.forPlayer("4046", "QB")).toEqual({
      gp: 17,
      pass_cmp: 401,
      pass_att: 612,
      pass_yd: 4500,
      pass_td: 32,
      pass_int: 11,
      rush_yd: 210,
      rush_td: 2,
    });
    expect(s.forPlayer("9001", "RB")).toEqual({
      gp: 16,
      rush_att: 280,
      rush_yd: 1300,
      rush_td: 9,
      rec: 40,
      rec_yd: 320,
      rec_td: 1,
    });
    expect(s.forPlayer("2449", "WR")).toEqual({
      gp: 15,
      rec_tgt: 120,
      rec: 80,
      rec_yd: 1000,
      rec_td: 6,
      rush_yd: 12,
    });
    expect(Object.keys(s.forPlayer("3678", "K")!)).toEqual([
      "gp",
      "fgm",
      "fga",
      "fgm_50p",
      "xpm",
      "xpa",
    ]);
    expect(s.forPlayer("3678", "K")).toMatchObject({ fgm_50p: 4, xpa: 41 });
  });

  it("missing keys are 0 when an entry exists; no entry is null", () => {
    const s = parseSleeperStats(stats());
    expect(s.forPlayer("9002", "TE")).toEqual({
      gp: 0,
      rec_tgt: 0,
      rec: 0,
      rec_yd: 0,
      rec_td: 0,
      rush_yd: 0,
    });
    expect(s.forPlayer("nope", "QB")).toBeNull();
    expect(s.forPlayer("constructor", "QB")).toBeNull();
    expect(statLine("QB", { gp: "x", pass_yd: Number.NaN, pass_td: 2.6 })).toMatchObject({
      gp: 0,
      pass_yd: 0,
      pass_td: 3,
    });
  });

  it("maps DST through the ESPN<->Sleeper abbreviation table (WSH -> WAS)", () => {
    const s = parseSleeperStats(stats());
    expect(s.forTeam("WSH")).toEqual({
      gp: 17,
      sack: 45,
      int: 12,
      fum_rec: 8,
      def_td: 2,
      def_st_td: 1,
      pts_allow: 400,
    });
    expect(s.forTeam("DEN")).toBeNull();
  });

  it("rejects an unexpected shape", () => {
    expect(() => parseSleeperStats([])).toThrow(PoolSourceError);
    expect(() => parseSleeperStats(null)).toThrow(/unexpected shape/);
  });
});

describe("composePoolSource with stats", () => {
  const teams = [
    { abbr: "WSH", name: "Washington Commanders", conference: "NFC" as const, seed: 7 },
  ];
  const base = (stats: () => Promise<ReturnType<typeof parseSleeperStats>>) =>
    composePoolSource(
      "t",
      { fetchField: async () => teams },
      {
        fetchPlayers: async () => ({
          players: [
            {
              providerPlayerId: "2449",
              name: "A",
              position: "WR",
              nflTeam: "WSH",
              injuryStatus: null,
            },
            {
              providerPlayerId: "zzz",
              name: "B",
              position: "RB",
              nflTeam: "WSH",
              injuryStatus: null,
            },
          ],
          warnings: [],
        }),
      },
      { fetchStats: stats },
    );

  it("attaches stats, null for no entry, and DST stats by team", async () => {
    const data = await base(async () =>
      parseSleeperStats(fixture("sleeper-stats-2025.trimmed.json")),
    ).load(2025);
    expect(data.statsSeason).toBe(2025);
    expect(data.players[0]?.stats?.rec_yd).toBe(1000);
    expect(data.players[1]?.stats).toBeNull();
    expect(data.dstStats?.WSH?.sack).toBe(45);
    expect(data.warnings).toEqual([]);
  });

  it("a stats failure still imports players, without stats, with a warning", async () => {
    const data = await base(async () => {
      throw new PoolSourceError("Sleeper stats returned HTTP 503");
    }).load(2025);
    expect(data.players).toHaveLength(2);
    expect(data.players.every((p) => p.stats === undefined)).toBe(true);
    expect(data.statsSeason).toBeUndefined();
    expect(data.dstStats).toBeUndefined();
    expect(data.warnings).toEqual(["stats unavailable for 2025"]);
  });
});
