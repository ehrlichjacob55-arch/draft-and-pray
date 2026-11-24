import { GOLDEN_PLAYERS, type StatKey } from "@dnp/domain";
import { describe, expect, it } from "vitest";
import { parseEspnSummary, type ParsedSummary } from "./espn-boxscore";
import { EVENTS, allEventIds, poolFromSummary, summary, summaryJson } from "./espn-fixtures";
import {
  mapSummaryToStatLines,
  normalizeFullName,
  shortKeyOfPlayText,
  type MappedGame,
  type PoolPlayerRef,
} from "./espn-stat-mapping";
import { PoolSourceError } from "./types";

const mapAll = (id: string): { game: MappedGame; pool: PoolPlayerRef[] } => {
  const s = summary(id);
  const pool = poolFromSummary(s);
  return { game: mapSummaryToStatLines(s, pool), pool };
};
/** The mapped line of the player called `name`. */
const lineOf = (g: { game: MappedGame; pool: PoolPlayerRef[] }, name: string) => {
  const p = g.pool.find((x) => x.name === name);
  if (!p) throw new Error(`no pool player ${name}`);
  return g.game.lines.find((l) => l.playerId === p.playerId);
};
const counts = (g: { game: MappedGame; pool: PoolPlayerRef[] }, name: string) =>
  lineOf(g, name)?.canonical ?? {};

describe("parseEspnSummary", () => {
  it("reads teams, scores, status, athletes (by keys) and plays", () => {
    const s = summary(EVENTS.golden);
    expect(s.status).toBe("final");
    expect([s.home.abbr, s.home.score, s.away.abbr, s.away.score]).toEqual(["CAR", 31, "LAR", 34]);
    const stafford = s.athletes.find((a) => a.name === "Matthew Stafford")!;
    expect(stafford.stats.passing?.passingYards).toBe("304");
    expect(stafford.stats.passing?.["sacks-sackYardsLost"]).toBe("1-9");
    expect(s.plays.length).toBeGreaterThan(100);
    expect(s.plays.some((p) => /No Play/.test(p.text))).toBe(false);
    expect(s.scoringPlays).toHaveLength(11);
  });

  it("parses every recorded game", () => {
    for (const id of allEventIds()) expect(summary(id).status).toBe("final");
    expect(allEventIds()).toHaveLength(13);
  });

  it("includes the current drive of a live game and tolerates a game that has not started", () => {
    const json = structuredClone(summaryJson(EVENTS.golden)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    json.drives.current = {
      plays: [{ type: { text: "Rush" }, text: "X.Y runs", start: { team: { id: "29" } } }],
    };
    json.header.competitions[0].status.type = { name: "STATUS_IN_PROGRESS", completed: false };
    const live = parseEspnSummary(json);
    expect(live.status).toBe("in_progress");
    expect(live.plays.at(-1)?.text).toBe("X.Y runs");

    const pre = parseEspnSummary({ header: json.header });
    expect(pre.athletes).toEqual([]);
    expect(pre.plays).toEqual([]);
    expect(pre.scoringPlays).toEqual([]);
  });

  it("fails loudly with a safe message on an unexpected shape", () => {
    expect(() => parseEspnSummary({ header: {} })).toThrow(PoolSourceError);
    expect(() => parseEspnSummary(null)).toThrow(/unexpected shape/);
    const noScores = structuredClone(summaryJson(EVENTS.golden)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    noScores.header.competitions[0].competitors[0].score = "abc";
    expect(() => parseEspnSummary(noScores)).toThrow(/unreadable scores/);
  });
});

describe("golden game (LAR 34 @ CAR 31): the parser reproduces GOLDEN_PLAYERS", () => {
  it("matches every hand-mapped line, built from a pool made of the golden names", () => {
    const s = summary(EVENTS.golden);
    const pool: PoolPlayerRef[] = GOLDEN_PLAYERS.map((g, i) => {
      const m = /^(.*) \((\w+) \w+\)$/.exec(g.name);
      return m
        ? { playerId: `g${i}`, name: m[1]!, nflTeam: m[2]!, position: g.position }
        : {
            playerId: `DST-${g.name.split(" ")[0]}`,
            name: g.name,
            nflTeam: g.name.split(" ")[0]!,
            position: "DST",
          };
    });
    const { lines } = mapSummaryToStatLines(s, pool);
    for (const [i, g] of GOLDEN_PLAYERS.entries()) {
      const id = pool[i]!.playerId;
      const line = lines.find((l) => l.playerId === id);
      expect(line, g.name).toBeDefined();
      expect(line!.canonical, g.name).toEqual(g.stats.counts);
      // The fixture lists distances ascending; the parser keeps play order.
      const sortAll = (e: object | undefined) =>
        Object.fromEntries(
          Object.entries(e ?? {}).map(([k, v]) => [k, [...(v as number[])].sort()]),
        );
      expect(sortAll(line!.events), g.name).toEqual(sortAll(g.stats.events));
    }
    expect(lines).toHaveLength(GOLDEN_PLAYERS.length);
  });

  it("warns about relevant box-score athletes missing from the pool, never about defenders", () => {
    const s = summary(EVENTS.golden);
    const { warnings } = mapSummaryToStatLines(s, []);
    expect(warnings).toContain("Kyren Williams (LAR) has stats but is not in the player pool");
    expect(warnings.some((w) => /Curl|Durant/.test(w))).toBe(false);
  });
});

describe("recorded postseason games", () => {
  it("GB @ CHI: the two-point conversion and Brandon McManus's misses", () => {
    const g = mapAll(EVENTS.gbChi);
    expect(counts(g, "Caleb Williams").pass_2pt).toBe(1);
    expect(counts(g, "Colston Loveland").rec_2pt).toBe(1);
    const k = lineOf(g, "Brandon McManus")!;
    expect(k.canonical).toMatchObject({ fg_missed: 2, xp_missed: 1, xp_made: 3 });
    expect(k.canonical.fg_made).toBeUndefined();
    expect(k.events).toEqual({ fg_missed: [55, 44] });
    // CHI blocked nothing and scored no defensive TD
    expect(counts(g, "CHI D/ST").def_td).toBeUndefined();
    expect(g.game.warnings).toEqual([]);
  });

  it("NE @ DEN: blocked field goal, misses with distances, and the blocking defense", () => {
    const g = mapAll(EVENTS.neDen);
    const lutz = lineOf(g, "Wil Lutz")!;
    expect(lutz.canonical).toMatchObject({ fg_blocked: 1, fg_missed: 1, xp_made: 1 });
    expect(lutz.canonical.fg_made).toBeUndefined();
    expect(lutz.events).toEqual({ fg_missed: [54] });
    const borregales = lineOf(g, "Andy Borregales")!;
    expect(borregales.canonical).toMatchObject({ fg_made: 1, fg_missed: 2, xp_made: 1 });
    expect(borregales.events).toEqual({ fg_made: [23], fg_missed: [63, 46] });
    expect(counts(g, "NE D/ST").def_block).toBeGreaterThanOrEqual(1);
    expect(counts(g, "NE D/ST").def_block).toBe(1);
    expect(counts(g, "DEN D/ST").def_block).toBeUndefined();
  });

  it("HOU @ PIT: defensive TDs (interception and fumble returns), missed PAT, points allowed", () => {
    const s = summary(EVENTS.houPit);
    const g = mapAll(EVENTS.houPit);
    expect(counts(g, "HOU D/ST").def_td).toBe(2);
    expect(counts(g, "PIT D/ST").def_td).toBeUndefined();
    expect(lineOf(g, "Ka'imi Fairbairn")!.canonical.xp_missed).toBe(1);
    // HOU's 30 include Bullock's pick-six (PAT failed, 6) and Rankins's fumble return (kick, 7)
    expect(s.away.score).toBe(30);
    expect(counts(g, "PIT D/ST").def_pts_allowed).toBe(17);
    expect(lineOf(g, "PIT D/ST")!.raw.opponentDefensivePoints).toBe(13);
    expect(counts(g, "HOU D/ST").def_pts_allowed).toBe(6);
    // the defensive TDs are not attributed to any offensive player
    expect(g.game.warnings).toEqual([]);
  });

  it("HOU @ NE: Marcus Jones's pick-six (with kick) does not count against HOU's D/ST", () => {
    const s = summary(EVENTS.houNe);
    const g = mapAll(EVENTS.houNe);
    expect(counts(g, "NE D/ST").def_td).toBe(1);
    const hou = lineOf(g, "HOU D/ST")!;
    expect(hou.raw.opponentDefensivePoints).toBe(7);
    expect(hou.canonical.def_pts_allowed).toBe(s.home.score - 7);
    expect(g.game.warnings).toEqual([]);
  });

  it("SF @ SEA: kickoff return TD for the returner and the DST", () => {
    const g = mapAll(EVENTS.sfSea);
    expect(counts(g, "Rashid Shaheed").ret_td).toBe(1);
    expect(counts(g, "SEA D/ST").ret_td).toBe(1);
    expect(counts(g, "SF D/ST").ret_td).toBeUndefined();
  });

  it("Super Bowl: the failed two-point attempt scores nothing, Nwosu's pick-six is a DST TD", () => {
    const g = mapAll(EVENTS.superBowl);
    expect(counts(g, "Drake Maye").pass_2pt ?? 0).toBe(0);
    expect(counts(g, "Hunter Henry").rec_2pt ?? 0).toBe(0);
    expect(counts(g, "SEA D/ST").def_td).toBe(1);
    expect(counts(g, "SEA D/ST").def_int).toBe(2);
    expect(counts(g, "NE D/ST").def_td).toBeUndefined();
    const s = summary(EVENTS.superBowl);
    const sea = s.home.abbr === "SEA" ? s.home : s.away;
    const ne = lineOf(g, "NE D/ST")!;
    expect(ne.raw.opponentDefensivePoints).toBe(7);
    expect(ne.canonical.def_pts_allowed).toBe(sea.score - 7);
  });

  it("every recorded game maps without warnings and gives both DSTs a full base line", () => {
    for (const id of allEventIds()) {
      const s = summary(id);
      const { lines, warnings } = mapSummaryToStatLines(s, poolFromSummary(s));
      expect(warnings, id).toEqual([]);
      for (const t of [s.home, s.away]) {
        const dst = lines.find((l) => l.playerId === `DST-${t.abbr}`)!;
        const base: StatKey[] = ["def_pts_allowed", "def_sack", "def_int", "def_fum_rec"];
        for (const k of base) expect(dst.canonical[k], `${id} ${t.abbr} ${k}`).toBeDefined();
        const opp = t === s.home ? s.away : s.home;
        const defPts = dst.raw.opponentDefensivePoints as number;
        expect(dst.canonical.def_pts_allowed, `${id} ${t.abbr}`).toBe(opp.score - defPts);
      }
    }
  });

  it("DST turnovers equal the opponent's: interceptions thrown and fumbles lost", () => {
    const g = mapAll(EVENTS.golden);
    expect(counts(g, "LAR D/ST")).toMatchObject({ def_int: 1, def_fum_rec: 1, def_sack: 2 });
    expect(counts(g, "CAR D/ST")).toMatchObject({
      def_int: 1,
      def_fum_rec: 0,
      def_sack: 1,
      def_block: 1,
    });
  });
});

describe("player matching", () => {
  const golden = () => summary(EVENTS.golden);
  const stafford = (extra: Partial<PoolPlayerRef> = {}): PoolPlayerRef => ({
    playerId: "qb",
    name: "Matthew Stafford",
    position: "QB",
    nflTeam: "LAR",
    ...extra,
  });
  const ids = (pool: PoolPlayerRef[]) =>
    mapSummaryToStatLines(golden(), pool).lines.map((l) => l.playerId);

  it("matches by ESPN id even when the name differs and the team is stale", () => {
    expect(ids([stafford({ name: "Matt S.", nflTeam: "XXX", espnId: "12483" })])).toContain("qb");
  });
  it("falls back to the normalized name on the same team", () => {
    expect(ids([stafford({ name: "MATTHEW  STAFFORD Jr." })])).toContain("qb");
    expect(ids([stafford({ nflTeam: "CAR" })])).not.toContain("qb");
  });
  it("requires a kicker to match a kicker and a non-kicker to match a non-kicker", () => {
    const pool: PoolPlayerRef[] = [
      { playerId: "k", name: "Harrison Mevis", position: "K", nflTeam: "LAR" },
      { playerId: "rb", name: "Harrison Mevis", position: "RB", nflTeam: "LAR" },
    ];
    const { lines } = mapSummaryToStatLines(golden(), pool);
    expect(lines.map((l) => l.playerId)).toContain("k");
    expect(lines.map((l) => l.playerId)).not.toContain("rb");
  });
  it("does not guess between two pool players with the same name", () => {
    const pool = [stafford({ playerId: "a" }), stafford({ playerId: "b" })];
    const { lines, warnings } = mapSummaryToStatLines(golden(), pool);
    expect(lines.map((l) => l.playerId)).not.toContain("a");
    expect(warnings).toContain(
      "Matthew Stafford (LAR) matches more than one player in the pool; not guessing",
    );
  });
  it("matches an athlete to a pool player only once", () => {
    const pool = [
      stafford({ playerId: "a", espnId: "12483" }),
      stafford({ playerId: "b", name: "Other", espnId: "12483" }),
    ];
    const { lines } = mapSummaryToStatLines(golden(), pool);
    expect(lines.filter((l) => l.playerId === "a" || l.playerId === "b")).toHaveLength(1);
  });

  it("normalizes names", () => {
    expect(normalizeFullName("Brian Thomas Jr.")).toBe("brian thomas");
    expect(normalizeFullName("D'Ernest  Johnson")).toBe("dernest johnson");
    expect(normalizeFullName("C.J. Stroud")).toBe(normalizeFullName("CJ Stroud"));
    expect(shortKeyOfPlayText("A.St. Brown")).toBe("astbrown");
    expect(shortKeyOfPlayText("J.Smith-Njigba")).toBe("jsmithnjigba");
    expect(shortKeyOfPlayText("Stroud")).toBeUndefined();
  });
});

// ---- Branches the 2025 playoffs did not exercise: hand-built snapshots ----
const base = (over: Partial<ParsedSummary> = {}): ParsedSummary => ({
  status: "final",
  home: { id: "1", abbr: "HOM", score: 20 },
  away: { id: "2", abbr: "AWY", score: 17 },
  athletes: [],
  plays: [],
  scoringPlays: [],
  ...over,
});
const kicker = (
  teamId: string,
  id: string,
  first: string,
  last: string,
  fg: string,
  xp: string,
) => ({
  id,
  name: `${first} ${last}`,
  firstName: first,
  lastName: last,
  teamId,
  stats: {
    kicking: { "fieldGoalsMade/fieldGoalAttempts": fg, "extraPointsMade/extraPointAttempts": xp },
  },
});
const passer = (teamId: string, id: string, first: string, last: string, sacks = "0-0") => ({
  id,
  name: `${first} ${last}`,
  firstName: first,
  lastName: last,
  teamId,
  stats: {
    passing: {
      passingYards: "200",
      passingTouchdowns: "1",
      interceptions: "0",
      "sacks-sackYardsLost": sacks,
    },
  },
});
const P = (
  playerId: string,
  name: string,
  nflTeam: string,
  position: PoolPlayerRef["position"] = "WR",
): PoolPlayerRef => ({
  playerId,
  name,
  position,
  nflTeam,
});
const g2 = (g: MappedGame, abbr: string) =>
  g.lines.find((l) => l.playerId === `DST-${abbr}`)?.canonical.def_pts_allowed;
const dstOf = (g: MappedGame, abbr: string) =>
  g.lines.find((l) => l.playerId === `DST-${abbr}`)?.canonical;

describe("scoring-play classification", () => {
  const sp = (
    type: string,
    text: string,
    teamId = "1",
    homeScore?: number,
    awayScore?: number,
  ) => ({
    type,
    text,
    teamId,
    ...(homeScore !== undefined && awayScore !== undefined ? { homeScore, awayScore } : {}),
  });
  const map = (scoringPlays: ParsedSummary["scoringPlays"], pool: PoolPlayerRef[] = []) =>
    mapSummaryToStatLines(base({ scoringPlays }), pool);

  it("credits safeties, blocked-kick return TDs and defensive TDs to the scoring team's DST", () => {
    const g = map([
      sp("Safety", "Someone sacked in end zone for a Safety", "1", 2, 0),
      sp("Blocked Punt Touchdown", "X 20 Yd Blocked Punt Return (Y Kick)", "2", 2, 7),
      sp("Missed Field Goal Return Touchdown", "X 60 Yd Missed FG Return", "2", 2, 13),
      sp("Interception Return Touchdown", "Z 30 Yd Interception Return (K Kick)", "2", 2, 20),
      sp("Fumble Recovery (Opponent)", "Z 12 Yd Fumble Return (K PAT Failed)", "1", 8, 20),
      sp("Passing Touchdown", "A 5 Yd pass from B", "1", 14, 20),
      sp("Field Goal Good", "K 40 Yd Field Goal", "1", 17, 20),
      sp("Kickoff Return Touchdown", "R 90 Yd Kickoff Return", "1", 23, 20),
      sp("Two Point Rush", "K 2 Yd Run", "1", 25, 20),
    ]);
    expect(dstOf(g, "HOM")).toMatchObject({ def_safety: 1, def_td: 1 });
    expect(dstOf(g, "AWY")).toMatchObject({ ret_td: 2, def_td: 1 });
    expect(g.warnings).toEqual([]);
  });

  it("points allowed exclude the opponent's defensive TD drives (6 + conversion); return TDs and safeties count", () => {
    // Home 20 / away 17 in base(). Away's pick-six + kick = 7; home's fumble return + failed PAT = 6.
    const g = map([
      sp("Safety", "Someone sacked in end zone for a Safety", "1", 2, 0),
      sp("Interception Return Touchdown", "Z 30 Yd Interception Return (K Kick)", "2", 2, 7),
      sp("Fumble Recovery (Opponent)", "Z 12 Yd Fumble Return (K PAT Failed)", "1", 8, 7),
      sp("Kickoff Return Touchdown", "R 90 Yd Kickoff Return", "2", 8, 13),
    ]);
    // HOM allowed 17 - 7 (away's pick-six + kick); AWY allowed 20 - 6 (home's fumble return, PAT failed)
    expect(dstOf(g, "HOM")?.def_pts_allowed).toBe(17 - 7);
    expect(dstOf(g, "AWY")?.def_pts_allowed).toBe(20 - 6);
    expect(g.lines.find((l) => l.playerId === "DST-HOM")?.raw.opponentDefensivePoints).toBe(7);
    expect(g.lines.find((l) => l.playerId === "DST-AWY")?.raw.opponentDefensivePoints).toBe(6);
    expect(g.warnings).toEqual([]);
  });

  it("a successful two-point conversion after a defensive TD is excluded too (8); a missing score change falls back with a warning", () => {
    const two = map([
      sp("Interception Return Touchdown", "Z 30 Yd Interception Return", "2", 0, 8),
    ]);
    expect(g2(two, "HOM")).toBe(17 - 8);
    const g = map([
      sp("Interception Return Touchdown", "Z 30 Yd Interception Return (K Kick)", "2"),
    ]);
    expect(dstOf(g, "HOM")?.def_pts_allowed).toBe(17 - 7);
    expect(g.warnings).toHaveLength(1);
    expect(g.warnings[0]).toMatch(/score change/);
  });

  it("never goes below zero", () => {
    const g = mapSummaryToStatLines(
      base({
        away: { id: "2", abbr: "AWY", score: 6 },
        scoringPlays: [
          sp("Interception Return Touchdown", "Z 1 Yd Interception Return", "2", 0, 8),
        ],
      }),
      [],
    );
    expect(dstOf(g, "HOM")?.def_pts_allowed).toBe(0);
  });

  it("warns about a scoring play it cannot classify, and about special-teams fumble TDs", () => {
    const g = map([
      sp("Mystery Score", "Somebody did something"),
      sp("", "Typeless score"),
      sp(
        "Fumble Recovery (Opponent)",
        "T.Muffs MUFFS catch, RECOVERED by HOM-A.B. A.B. 9 Yd Fumble Recovery",
      ),
    ]);
    expect(g.warnings).toEqual([
      "Unclassified scoring play (Mystery Score): Somebody did something",
      "Unclassified scoring play (no type): Typeless score",
      "Unclassified scoring play (Fumble Recovery (Opponent)): T.Muffs MUFFS catch, RECOVERED by HOM-A.B. A.B. 9 Yd Fumble Recovery",
    ]);
    expect(dstOf(g, "HOM")).not.toHaveProperty("def_td");
  });

  it("gives an own-fumble-recovery TD to the (matched) scorer, and warns when it cannot", () => {
    const pool = [P("te", "Tight End", "HOM", "TE")];
    const ok = map([sp("Fumble Recovery (Own)", "Tight End 3 Yd Fumble Recovery (K Kick)")], pool);
    expect(ok.lines.find((l) => l.playerId === "te")?.canonical).toEqual({ fum_rec_td: 1 });
    const bad = map([sp("Fumble Recovery (Own)", "Nobody Known 3 Yd Fumble Recovery")], pool);
    expect(bad.warnings).toEqual([
      "Unclassified scoring play (fumble recovery touchdown): Nobody Known 3 Yd Fumble Recovery",
    ]);
    const noName = map([sp("Fumble Recovery (Own)", "weird")], pool);
    expect(noName.warnings).toHaveLength(1);
  });
});

describe("kicking", () => {
  const play = (text: string, teamId = "1", type = "Field Goal Good") => ({ teamId, type, text });
  const kicks = (
    plays: ParsedSummary["plays"],
    athletes: ParsedSummary["athletes"],
    pool: PoolPlayerRef[],
  ) => mapSummaryToStatLines(base({ plays, athletes }), pool);

  it("attributes kicks by name when a team has two kickers", () => {
    const athletes = [
      kicker("1", "k1", "Alan", "Aaa", "1/1", "0/0"),
      kicker("1", "k2", "Bob", "Bbb", "1/1", "0/0"),
    ];
    const pool = [P("k1", "Alan Aaa", "HOM", "K"), P("k2", "Bob Bbb", "HOM", "K")];
    const g = kicks(
      [
        play("A.Aaa 30 yard field goal is GOOD, Center-X"),
        play("B.Bbb 52 yard field goal is GOOD, Center-X"),
      ],
      athletes,
      pool,
    );
    expect(g.lines.find((l) => l.playerId === "k1")?.events).toEqual({ fg_made: [30] });
    expect(g.lines.find((l) => l.playerId === "k2")?.events).toEqual({ fg_made: [52] });
  });

  it("uses the play's team to separate two kickers who share a short name", () => {
    const athletes = [
      kicker("1", "k1", "Alan", "Aaa", "1/1", "0/0"),
      kicker("2", "k2", "Adam", "Aaa", "0/1", "0/0"),
    ];
    const pool = [P("k1", "Alan Aaa", "HOM", "K"), P("k2", "Adam Aaa", "AWY", "K")];
    const g = kicks(
      [
        play("A.Aaa 30 yard field goal is GOOD, Center-X", "1"),
        play("A.Aaa 41 yard field goal is No Good, Wide Left", "2", "Field Goal Missed"),
      ],
      athletes,
      pool,
    );
    expect(g.lines.find((l) => l.playerId === "k1")?.events).toEqual({ fg_made: [30] });
    expect(g.lines.find((l) => l.playerId === "k2")?.events).toEqual({ fg_missed: [41] });
  });

  it("warns and records no distances when the plays do not add up, and for an unknown kicker", () => {
    const athletes = [kicker("1", "k1", "Alan", "Aaa", "2/3", "0/0")];
    const pool = [P("k1", "Alan Aaa", "HOM", "K")];
    const g = kicks(
      [
        play("A.Aaa 30 yard field goal is GOOD, Center-X"),
        play("Q.Zzz 33 yard field goal is GOOD, Center-X"),
        play("A.Aaa 47 yard field goal is No Good, Wide Right"),
        play("A.Aaa 48 yard field goal is No Good, Wide Right"),
      ],
      athletes,
      pool,
    );
    const k = g.lines.find((l) => l.playerId === "k1")!;
    expect(k.canonical).toEqual({ fg_made: 2, fg_missed: 1 });
    expect(k.events).toBeUndefined();
    expect(g.warnings).toEqual([
      "Could not tell which kicker made the 33-yard field goal try by Q.Zzz (HOM)",
      "Alan Aaa (HOM): found 1 field goal distances for 2 made kicks; distances not recorded, so this game needs a commissioner override",
      "Alan Aaa (HOM): found 2 field goal distances for 1 missed kicks; distances not recorded, so this game needs a commissioner override",
    ]);
  });

  it("counts blocked extra points and gives the block to the other team's DST", () => {
    const athletes = [kicker("1", "k1", "Alan", "Aaa", "0/0", "1/3")];
    const pool = [P("k1", "Alan Aaa", "HOM", "K")];
    const g = kicks(
      [
        play(
          "(Shotgun) X.Y pass to Z.W for 5 yards, TOUCHDOWN. A.Aaa extra point is BLOCKED (D.Ef)",
          "1",
          "Passing Touchdown",
        ),
        play("Other TD. A.Aaa extra point is No Good, Wide Left", "1", "Rushing Touchdown"),
        play("Q.Zzz extra point is BLOCKED", "1", "Rushing Touchdown"),
        play("B.Cc punt is BLOCKED by D.Ee", "2", "Blocked Punt"),
        play("B.Cc punts 40 yards", "2", "Punt"),
      ],
      athletes,
      pool,
    );
    expect(g.lines.find((l) => l.playerId === "k1")?.canonical).toEqual({
      xp_made: 1,
      xp_missed: 1,
      xp_blocked: 1,
    });
    expect(dstOf(g, "AWY")).toMatchObject({ def_block: 1 });
    expect(dstOf(g, "HOM")).toMatchObject({ def_block: 1 });
    expect(g.warnings).toEqual([
      "Could not tell which kicker had the blocked extra point by Q.Zzz",
    ]);
  });

  it("never lets attempts minus made go negative", () => {
    const athletes = [kicker("1", "k1", "Alan", "Aaa", "1/1", "0/0")];
    const g = kicks(
      [play("A.Aaa 40 yard field goal is BLOCKED (D.E)", "1", "Blocked Field Goal")],
      athletes,
      [P("k1", "Alan Aaa", "HOM", "K")],
    );
    const k = g.lines.find((l) => l.playerId === "k1")!;
    expect(k.canonical).toEqual({ fg_made: 1, fg_blocked: 1 });
    expect(k.events).toBeUndefined();
  });
});

describe("two-point conversions", () => {
  const two = (text: string, teamId = "1", type = "Passing Touchdown") => ({ teamId, type, text });
  const run = (plays: ParsedSummary["plays"], pool: PoolPlayerRef[]) =>
    mapSummaryToStatLines(base({ plays }), pool);
  const pool = [
    P("qb", "Quinn Back", "HOM", "QB"),
    P("wr", "Wade Receiver", "HOM"),
    P("rb", "Rex Runner", "HOM", "RB"),
    P("dqb", "Dan Defender", "AWY", "QB"),
    P("dwr", "Dee Wide", "AWY"),
  ];

  it("credits the passer and the receiver, or the runner", () => {
    const g = run(
      [
        two(
          "X TOUCHDOWN. TWO-POINT CONVERSION ATTEMPT. Q.Back pass to W.Receiver is complete. ATTEMPT SUCCEEDS.",
        ),
        two(
          "Y TOUCHDOWN. TWO-POINT CONVERSION ATTEMPT. R.Runner rushes up the middle. ATTEMPT SUCCEEDS.",
          "1",
          "Rushing Touchdown",
        ),
        two(
          "TWO-POINT CONVERSION ATTEMPT. Q.Back pass to W.Receiver is incomplete. ATTEMPT FAILS.",
        ),
      ],
      pool,
    );
    const c = (id: string) => g.lines.find((l) => l.playerId === id)?.canonical;
    expect(c("qb")).toEqual({ pass_2pt: 1 });
    expect(c("wr")).toEqual({ rec_2pt: 1 });
    expect(c("rb")).toEqual({ rush_2pt: 1 });
    expect(g.warnings).toEqual([]);
  });

  it("gives a conversion after a defensive TD to the scoring team, not the team with the ball", () => {
    const g = run(
      [
        two(
          "X pass INTERCEPTED. TOUCHDOWN. TWO-POINT CONVERSION ATTEMPT. D.Defender pass to D.Wide is complete. ATTEMPT SUCCEEDS.",
          "1",
          "Interception Return Touchdown",
        ),
      ],
      pool,
    );
    expect(g.lines.find((l) => l.playerId === "dqb")?.canonical).toEqual({ pass_2pt: 1 });
    expect(g.lines.find((l) => l.playerId === "dwr")?.canonical).toEqual({ rec_2pt: 1 });
  });

  it("warns instead of guessing", () => {
    const g = run(
      [
        two("TWO-POINT CONVERSION ATTEMPT. ??? ATTEMPT SUCCEEDS."),
        two(
          "TWO-POINT CONVERSION ATTEMPT. N.Obody pass to W.Receiver is complete. ATTEMPT SUCCEEDS.",
        ),
        two("TWO-POINT CONVERSION ATTEMPT. Q.Back pass to N.Obody is complete. ATTEMPT SUCCEEDS."),
      ],
      pool,
    );
    expect(g.warnings).toEqual([
      "Could not read a successful two-point conversion: ???",
      "Could not match N.Obody (HOM) for a two-point conversion",
      "Could not match N.Obody (HOM) for a two-point conversion",
    ]);
    // the part of a conversion that can be identified is still credited
    expect(g.lines.find((l) => l.playerId === "qb")?.canonical).toEqual({ pass_2pt: 1 });
    expect(g.lines.find((l) => l.playerId === "wr")?.canonical).toEqual({ rec_2pt: 1 });
  });

  it("uses box-score ids to tell apart two players with the same short name", () => {
    const athletes = [
      {
        id: "11",
        name: "Kyle Williams",
        firstName: "Kyle",
        lastName: "Williams",
        teamId: "1",
        stats: { rushing: { rushingYards: "0", rushingTouchdowns: "0" } },
      },
    ];
    const pool2: PoolPlayerRef[] = [
      { ...P("a", "Kyle Williams", "HOM", "RB"), espnId: "11" },
      { ...P("b", "Karl Williams", "HOM", "RB"), espnId: "99" },
      P("qb", "Quinn Back", "HOM", "QB"),
    ];
    const g = mapSummaryToStatLines(
      base({
        athletes,
        plays: [
          two(
            "TWO-POINT CONVERSION ATTEMPT. Q.Back pass to K.Williams is complete. ATTEMPT SUCCEEDS.",
          ),
        ],
      }),
      pool2,
    );
    expect(g.lines.find((l) => l.playerId === "a")?.canonical).toEqual({ rush_yds: 0, rec_2pt: 1 });
    expect(g.lines.find((l) => l.playerId === "b")).toBeUndefined();
    // without that box-score athlete it is ambiguous
    const amb = mapSummaryToStatLines(
      base({
        plays: [
          two(
            "TWO-POINT CONVERSION ATTEMPT. Q.Back pass to K.Williams is complete. ATTEMPT SUCCEEDS.",
          ),
        ],
      }),
      pool2,
    );
    expect(amb.warnings).toEqual(["Could not match K.Williams (HOM) for a two-point conversion"]);
  });
});

describe("box-score strictness", () => {
  const withStats = (stats: Record<string, Record<string, string>>) =>
    base({
      athletes: [{ id: "1", name: "A B", teamId: "1", stats }],
    });
  it("fails loudly on a missing column or a malformed value", () => {
    expect(() =>
      mapSummaryToStatLines(withStats({ passing: { passingTouchdowns: "1" } }), []),
    ).toThrow(/no "passingYards" column/);
    expect(() =>
      mapSummaryToStatLines(
        withStats({ rushing: { rushingYards: "x", rushingTouchdowns: "0" } }),
        [],
      ),
    ).toThrow(/rushing.rushingYards is not a number/);
    expect(() =>
      mapSummaryToStatLines(
        withStats({
          kicking: {
            "fieldGoalsMade/fieldGoalAttempts": "2",
            "extraPointsMade/extraPointAttempts": "1/1",
          },
        }),
        [],
      ),
    ).toThrow(/is not a "\/" pair/);
  });
  it("sums punt-return TDs too, and reads fumbles lost", () => {
    const s = base({
      athletes: [
        {
          id: "1",
          name: "Pat Returner",
          firstName: "Pat",
          lastName: "Returner",
          teamId: "1",
          stats: {
            fumbles: { fumblesLost: "1" },
            kickReturns: { kickReturnTouchdowns: "0" },
            puntReturns: { puntReturnTouchdowns: "1" },
          },
        },
      ],
    });
    const g = mapSummaryToStatLines(s, [P("r", "Pat Returner", "HOM")]);
    expect(g.lines.find((l) => l.playerId === "r")?.canonical).toEqual({ fum_lost: 1, ret_td: 1 });
    expect(dstOf(g, "HOM")).toMatchObject({ ret_td: 1, def_fum_rec: 0 });
    expect(dstOf(g, "AWY")).toMatchObject({ def_fum_rec: 1 });
  });
  it("skips players whose only stats are zero-valued non-scoring columns", () => {
    const s = base({
      athletes: [
        {
          id: "1",
          name: "Nobody Special",
          teamId: "1",
          stats: { kickReturns: { kickReturnTouchdowns: "0" }, fumbles: { fumblesLost: "0" } },
        },
      ],
    });
    const g = mapSummaryToStatLines(s, [P("n", "Nobody Special", "HOM")]);
    expect(g.lines.map((l) => l.playerId).sort()).toEqual(["DST-AWY", "DST-HOM"]);
    expect(g.warnings).toEqual([]);
  });
  it("counts sacks and interceptions from the opposing passers", () => {
    const g = mapSummaryToStatLines(
      base({ athletes: [passer("2", "p", "Pat", "Passer", "3-21")] }),
      [],
    );
    expect(dstOf(g, "HOM")).toMatchObject({ def_sack: 3, def_int: 0, def_pts_allowed: 17 });
    expect(dstOf(g, "AWY")).toMatchObject({ def_sack: 0, def_pts_allowed: 20 });
  });
});
