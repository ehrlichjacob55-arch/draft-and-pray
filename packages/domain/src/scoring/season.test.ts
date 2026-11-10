import { describe, expect, it } from "vitest";
import { rosterPlayersForRound, type RosterAssignment } from "./roster-rounds";
import { parseRuleset } from "./ruleset";
import { computeSeason, sumPoints, type SeasonInput } from "./season";
import { computeStandings, type StandingsInput } from "./standings";

const ruleset = parseRuleset({
  version: 7,
  rules: [
    { stat: "rush_yds", points: 1, per: 10 },
    { stat: "rush_td", points: 6 },
  ],
});

describe("rosterPlayersForRound", () => {
  const a: RosterAssignment[] = [
    { slot: "QB", playerId: "q1", fromRound: 1 },
    { slot: "RB1", playerId: "r1", fromRound: 1 },
    { slot: "RB1", playerId: "r2", fromRound: 3 },
    { slot: "RB1", playerId: "r1b", fromRound: 2 },
  ];
  it("a slot holds different players in different rounds", () => {
    expect(rosterPlayersForRound(a, 1).sort()).toEqual(["q1", "r1"]);
    expect(rosterPlayersForRound(a, 2).sort()).toEqual(["q1", "r1b"]);
    expect(rosterPlayersForRound(a, 4).sort()).toEqual(["q1", "r2"]);
    expect(rosterPlayersForRound([...a].reverse(), 4).sort()).toEqual(["q1", "r2"]);
  });
  it("ignores entries that start later", () => {
    expect(rosterPlayersForRound([{ slot: "K", playerId: "k", fromRound: 3 }], 2)).toEqual([]);
  });
});

describe("sumPoints", () => {
  it("sums exactly", () => {
    expect(sumPoints([0.1, 0.2], 2)).toBe(0.3);
    expect(sumPoints([], 2)).toBe(0);
  });
});

const base = (): SeasonInput => ({
  ruleset,
  rounds: [
    { round: 1, status: "finalized" },
    { round: 2, status: "live" },
    { round: 3, status: "upcoming" },
  ],
  games: [
    { gameId: "g1", round: 1, home: "AAA", away: "BBB", status: "final" },
    { gameId: "g2", round: 2, home: "AAA", away: "CCC", status: "in" },
  ],
  players: [
    { playerId: "p1", position: "RB", nflTeam: "AAA" },
    { playerId: "p2", position: "RB", nflTeam: "CCC" },
    { playerId: "p3", position: "RB", nflTeam: "AAA" },
  ],
  playerGames: [
    { gameId: "g1", playerId: "p1", stats: { counts: { rush_td: 1 } } },
    { gameId: "g2", playerId: "p1", stats: { counts: { rush_yds: 55, rush_td: 1 } } },
    {
      gameId: "g2",
      playerId: "p2",
      stats: { counts: { rush_yds: 20 } },
      overrides: { rush_td: 2 },
    },
  ],
  teams: [
    { teamId: "T1", assignments: [{ slot: "RB1", playerId: "p1", fromRound: 1 }] },
    {
      teamId: "T2",
      assignments: [
        { slot: "RB1", playerId: "p2", fromRound: 1 },
        { slot: "RB2", playerId: "p3", fromRound: 1 },
        { slot: "RB2", playerId: "p1", fromRound: 2 },
      ],
    },
  ],
});

describe("computeSeason", () => {
  it("emits only non-finalized rounds, with overrides applied and the ruleset version", () => {
    const r = computeSeason(base());
    expect(r.issues).toEqual([]);
    expect(r.points).toEqual([
      {
        gameId: "g2",
        playerId: "p1",
        round: 2,
        points: 11,
        rulesetVersion: 7,
        overridden: [],
        breakdown: [
          { ruleIndex: 0, stat: "rush_yds", value: 55, points: 5 },
          { ruleIndex: 1, stat: "rush_td", value: 1, points: 6 },
        ],
      },
      {
        gameId: "g2",
        playerId: "p2",
        round: 2,
        points: 14,
        rulesetVersion: 7,
        overridden: ["rush_td"],
        breakdown: [
          { ruleIndex: 0, stat: "rush_yds", value: 20, points: 2 },
          { ruleIndex: 1, stat: "rush_td", value: 2, points: 12 },
        ],
      },
    ]);
    // round 1 is frozen (nothing emitted); round 3 is upcoming (zeros)
    expect(r.teamScores).toEqual([
      { teamId: "T1", round: 2, points: 11, provisional: true },
      { teamId: "T2", round: 2, points: 25, provisional: true },
      { teamId: "T1", round: 3, points: 0, provisional: true },
      { teamId: "T2", round: 3, points: 0, provisional: true },
    ]);
  });

  it("a player's points count for a team only in rounds it holds them (roster exception)", () => {
    const input = base();
    // T2 swaps p1 in from round 2: round-2 score includes p1 (11) + p2 (14); p3 had no stats
    expect(
      computeSeason(input).teamScores.find((s) => s.teamId === "T2" && s.round === 2)?.points,
    ).toBe(25);
    // Without the swap T2 would have only p2 + p3
    input.teams[1]!.assignments.pop();
    expect(
      computeSeason(input).teamScores.find((s) => s.teamId === "T2" && s.round === 2)?.points,
    ).toBe(14);
  });

  it("is deterministic: same input, same output", () => {
    expect(computeSeason(base())).toEqual(computeSeason(base()));
  });

  it("records issues instead of failing: unknown game/player, bad override, bad stat line", () => {
    const input = base();
    input.playerGames.push(
      { gameId: "nope", playerId: "p1", stats: { counts: {} } },
      { gameId: "g2", playerId: "nobody", stats: { counts: {} } },
      { gameId: "g2", playerId: "p3", stats: { counts: {} }, overrides: { bogus: 1 } as never },
      { gameId: "g2", playerId: "p3", stats: { counts: { fg_made: 2 }, events: { fg_made: [1] } } },
    );
    const r = computeSeason(input);
    expect(r.points).toHaveLength(2);
    expect(r.issues).toEqual([
      { gameId: "nope", playerId: "p1", message: "unknown game" },
      { gameId: "g2", playerId: "nobody", message: "unknown player" },
      { gameId: "g2", playerId: "p3", message: "Unknown stat key in override: bogus" },
      expect.objectContaining({
        gameId: "g2",
        playerId: "p3",
        message: expect.stringMatching(/Invalid stat line/),
      }),
    ]);
  });

  it("does not report problems for finalized-round games, even with unknown players", () => {
    const input = base();
    input.playerGames.push({ gameId: "g1", playerId: "ghost", stats: { counts: {} } });
    expect(computeSeason(input).issues).toEqual([]);
  });

  it("emits nothing when every round is finalized", () => {
    const input = base();
    input.rounds = [1, 2, 3].map((round) => ({ round, status: "finalized" as const }));
    expect(computeSeason(input)).toEqual({ points: [], teamScores: [], issues: [] });
  });
});

describe("computeStandings", () => {
  const input = (): StandingsInput => ({
    rounding: 2,
    teams: [
      {
        teamId: "A",
        assignments: [
          { slot: "QB", playerId: "q-alive", fromRound: 1 },
          { slot: "RB1", playerId: "r-bye", fromRound: 1 },
          { slot: "WR1", playerId: "w-out", fromRound: 1 },
          { slot: "K", playerId: "k-champ", fromRound: 1 },
          { slot: "DST", playerId: "d-played", fromRound: 1 },
          { slot: "TE", playerId: "unknown-team", fromRound: 1 },
          { slot: "FLEX1", playerId: "not-a-player", fromRound: 1 },
        ],
      },
      { teamId: "B", assignments: [{ slot: "QB", playerId: "q-alive", fromRound: 1 }] },
      { teamId: "C", assignments: [{ slot: "QB", playerId: "q-alive", fromRound: 1 }] },
      { teamId: "D", assignments: [{ slot: "QB", playerId: "q-alive", fromRound: 1 }] },
    ],
    teamScores: [
      { teamId: "A", round: 1, points: 10.1 },
      { teamId: "A", round: 2, points: 5.3 },
      { teamId: "B", round: 1, points: 15.3 },
      { teamId: "C", round: 1, points: 20 },
      { teamId: "D", round: 1, points: 20 },
    ],
    rounds: [
      { round: 3, status: "upcoming" },
      { round: 1, status: "finalized" },
      { round: 2, status: "final" },
      { round: 4, status: "upcoming" },
    ],
    games: [
      { gameId: "g1", round: 1, home: "ALV", away: "OUT", status: "final" },
      { gameId: "g2", round: 2, home: "PLY", away: "ZZZ", status: "final" },
      { gameId: "g3", round: 2, home: "PLY", away: "ZZZ", status: "live" },
    ],
    players: [
      { playerId: "q-alive", position: "QB", nflTeam: "ALV" },
      { playerId: "r-bye", position: "RB", nflTeam: "BYE" },
      { playerId: "w-out", position: "WR", nflTeam: "OUT" },
      { playerId: "k-champ", position: "K", nflTeam: "CHP" },
      { playerId: "d-played", position: "DST", nflTeam: "PLY" },
      { playerId: "unknown-team", position: "TE", nflTeam: "???" },
    ],
    nflTeams: [
      { abbr: "ALV", status: "alive" },
      { abbr: "BYE", status: "bye" },
      { abbr: "OUT", status: "eliminated" },
      { abbr: "CHP", status: "champion" },
      { abbr: "PLY", status: "alive" },
    ],
  });

  it("ranks by total, ties share a rank and are flagged, with players alive and games remaining", () => {
    const rows = computeStandings(input());
    expect(rows.map((r) => [r.teamId, r.total, r.rank, r.tied])).toEqual([
      ["C", 20, 1, true],
      ["D", 20, 1, true],
      ["A", 15.4, 3, false],
      ["B", 15.3, 4, false],
    ]);
  });

  it("counts players alive and max games remaining (bye skips the Wild Card; a won round is not counted)", () => {
    const a = computeStandings(input()).find((r) => r.teamId === "A")!;
    // as-of round = 2 (first non-finalized). alive: q-alive, r-bye, k-champ, d-played; not: w-out, unknown, missing
    expect(a.playersTotal).toBe(7);
    expect(a.playersAlive).toBe(4);
    // q-alive ALV: rounds 2,3,4 (2 is "final" -> excluded) = 3,4 -> 2
    // r-bye BYE: skips 1 (bye), round 2 final -> excluded, 3,4 -> 2
    // k-champ: 0 ; d-played PLY: round 2 final excluded; 3,4 -> 2
    expect(a.maxGamesRemaining).toBe(6);
  });

  it("a team that already won a round in a live round does not count it again", () => {
    const i = input();
    i.rounds = [
      { round: 1, status: "finalized" },
      { round: 2, status: "live" },
      { round: 3, status: "upcoming" },
      { round: 4, status: "upcoming" },
    ];
    const a = computeStandings(i).find((r) => r.teamId === "A")!;
    // ALV: 2,3,4 = 3; BYE: 2,3,4 = 3 (bye skip applies only to round 1); PLY won round 2: 3,4 = 2
    expect(a.maxGamesRemaining).toBe(3 + 3 + 2);
  });

  it("a bye team in an open Wild Card round has 3 games left, an alive one 4", () => {
    const i = input();
    i.rounds = [
      { round: 1, status: "live" },
      { round: 2, status: "upcoming" },
      { round: 3, status: "upcoming" },
      { round: 4, status: "upcoming" },
    ];
    i.games = [];
    const a = computeStandings(i).find((r) => r.teamId === "A")!;
    expect(a.maxGamesRemaining).toBe(4 + 3 + 0 + 4);
  });

  it("uses the Super Bowl roster once every round is finalized", () => {
    const i = input();
    i.rounds = [1, 2, 3, 4].map((round) => ({ round, status: "finalized" as const }));
    i.teams[1]!.assignments.push({ slot: "QB", playerId: "w-out", fromRound: 4 });
    const b = computeStandings(i).find((r) => r.teamId === "B")!;
    expect(b.playersAlive).toBe(0);
    expect(b.maxGamesRemaining).toBe(0);
  });

  it("works with no rounds yet", () => {
    const i = input();
    i.rounds = [];
    expect(computeStandings(i)).toHaveLength(4);
  });
});
