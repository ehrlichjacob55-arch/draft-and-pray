import { describe, expect, it } from "vitest";
import { liveStatusOf, parseEspnScoreboard } from "./espn-scoreboard";
import { SCOREBOARD_WEEKS, scoreboardJson } from "./espn-fixtures";
import { PoolSourceError } from "./types";

describe("parseEspnScoreboard", () => {
  it("reads the four recorded rounds: 6 + 4 + 2 + 1 final games", () => {
    const counts = SCOREBOARD_WEEKS.map((w) => parseEspnScoreboard(scoreboardJson(w)).length);
    expect(counts).toEqual([6, 4, 2, 1]);
  });

  it("reads teams, scores, kickoff and winner", () => {
    const games = parseEspnScoreboard(scoreboardJson(1));
    const g = games.find((x) => x.gameId === "401772979")!;
    expect(g).toEqual({
      gameId: "401772979",
      kickoff: "2026-01-10T21:30:00.000Z",
      status: "final",
      home: "CAR",
      away: "LAR",
      homeScore: 31,
      awayScore: 34,
      winner: "LAR",
    });
    const sb = parseEspnScoreboard(scoreboardJson(5))[0]!;
    expect([sb.home, sb.away, sb.winner]).toEqual(["NE", "SEA", "SEA"]);
  });

  const event = (over: Record<string, unknown>) => ({
    events: [
      {
        id: "1",
        date: "2027-01-09T21:30Z",
        status: { type: { name: "STATUS_SCHEDULED", completed: false } },
        competitions: [
          {
            competitors: [
              { homeAway: "home", team: { abbreviation: "AAA" } },
              { homeAway: "away", team: { abbreviation: "BBB" } },
            ],
          },
        ],
        ...over,
      },
    ],
  });

  it("treats a scheduled game without scores as 0-0 and has no winner", () => {
    expect(parseEspnScoreboard(event({}))[0]).toMatchObject({
      status: "scheduled",
      homeScore: 0,
      awayScore: 0,
    });
  });

  it("derives the winner from the score when no winner flag is set, and none for a tie", () => {
    const final = (home: string, away: string) =>
      event({
        status: { type: { name: "STATUS_FINAL", completed: true } },
        competitions: [
          {
            competitors: [
              { homeAway: "home", score: home, team: { abbreviation: "AAA" } },
              { homeAway: "away", score: away, team: { abbreviation: "BBB" } },
            ],
          },
        ],
      });
    expect(parseEspnScoreboard(final("20", "17"))[0]?.winner).toBe("AAA");
    expect(parseEspnScoreboard(final("17", "20"))[0]?.winner).toBe("BBB");
    expect(parseEspnScoreboard(final("17", "17"))[0]?.winner).toBeUndefined();
  });

  it("uses the winner flag of the away team", () => {
    const e = event({
      status: { type: { name: "STATUS_FINAL", completed: true } },
      competitions: [
        {
          competitors: [
            { homeAway: "home", score: 10, winner: false, team: { abbreviation: "AAA" } },
            { homeAway: "away", score: 10, winner: true, team: { abbreviation: "BBB" } },
          ],
        },
      ],
    });
    expect(parseEspnScoreboard(e)[0]?.winner).toBe("BBB");
  });

  it("fails loudly on an unexpected shape, a bad date or unreadable scores", () => {
    expect(() => parseEspnScoreboard({})).toThrow(PoolSourceError);
    expect(() => parseEspnScoreboard({ events: [{ id: "1" }] })).toThrow(/unexpected shape/);
    expect(() => parseEspnScoreboard(event({ date: "not a date" }))).toThrow(/unreadable game/);
    const badScore = event({
      competitions: [
        {
          competitors: [
            { homeAway: "home", score: "x", team: { abbreviation: "AAA" } },
            { homeAway: "away", score: "1", team: { abbreviation: "BBB" } },
          ],
        },
      ],
    });
    expect(() => parseEspnScoreboard(badScore)).toThrow(/unreadable game/);
    const twoHomes = event({
      competitions: [
        {
          competitors: [
            { homeAway: "home", team: { abbreviation: "AAA" } },
            { homeAway: "home", team: { abbreviation: "BBB" } },
          ],
        },
      ],
    });
    expect(() => parseEspnScoreboard(twoHomes)).toThrow(/unreadable game/);
  });
});

describe("liveStatusOf", () => {
  it.each([
    ["STATUS_SCHEDULED", false, "scheduled"],
    ["STATUS_POSTPONED", false, "scheduled"],
    ["STATUS_CANCELED", false, "scheduled"],
    ["STATUS_IN_PROGRESS", false, "in_progress"],
    ["STATUS_HALFTIME", false, "in_progress"],
    ["STATUS_END_PERIOD", false, "in_progress"],
    ["STATUS_DELAYED", false, "in_progress"],
    ["STATUS_SOMETHING_NEW", undefined, "in_progress"],
    ["STATUS_FINAL", true, "final"],
    ["STATUS_FINAL", undefined, "final"],
    ["STATUS_FINAL_OVERTIME", true, "final"],
  ] as const)("%s (completed %s) is %s", (name, completed, expected) => {
    expect(liveStatusOf({ name, completed })).toBe(expected);
  });
});
