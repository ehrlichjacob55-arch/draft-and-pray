import { describe, expect, it } from "vitest";
import {
  POLL_GAMEDAY_MS,
  POLL_IDLE_MS,
  POLL_LIVE_MS,
  POLL_MIN_MS,
  nextPollDelay,
  type PollGame,
} from "./poll-delay";
import { canonicalStatLineJson } from "./stat-json";
import {
  ROUND_GAME_COUNTS,
  deriveRoundStatus,
  deriveTeamStatuses,
  type LiveGame,
  type LiveRoundStatus,
} from "./team-status";

const field = [
  { abbr: "A1", seed: 1 },
  { abbr: "A2", seed: 2 },
  { abbr: "A3", seed: 3 },
  { abbr: "A4", seed: 4 },
];
const byAbbr = (r: ReturnType<typeof deriveTeamStatuses>) =>
  Object.fromEntries(r.map((t) => [t.abbr, t]));

describe("deriveTeamStatuses", () => {
  it("is empty-safe: the #1 seed has a bye and everyone else is alive before any game", () => {
    expect(deriveTeamStatuses({ teams: field, games: [] })).toEqual([
      { abbr: "A1", status: "bye" },
      { abbr: "A2", status: "alive" },
      { abbr: "A3", status: "alive" },
      { abbr: "A4", status: "alive" },
    ]);
  });

  it("keeps the bye while a Wild Card game is still open, then the #1 seed is alive", () => {
    const wc = (status: LiveGame["status"]): LiveGame[] => [
      { round: 1, home: "A3", away: "A2", status: "final", winner: "A3" },
      { round: 1, home: "A5", away: "A4", status, ...(status === "final" ? { winner: "A5" } : {}) },
    ];
    expect(byAbbr(deriveTeamStatuses({ teams: field, games: wc("in_progress") })).A1?.status).toBe(
      "bye",
    );
    const done = byAbbr(deriveTeamStatuses({ teams: field, games: wc("final") }));
    expect(done.A1?.status).toBe("alive");
    expect(done.A2).toEqual({ abbr: "A2", status: "eliminated", eliminatedInRound: "WC" });
    expect(done.A3?.status).toBe("alive");
    expect(done.A4).toEqual({ abbr: "A4", status: "eliminated", eliminatedInRound: "WC" });
  });

  it("eliminates losers per round and crowns the Super Bowl winner", () => {
    const games: LiveGame[] = [
      { round: 1, home: "A3", away: "A2", status: "final", winner: "A2" },
      { round: 2, home: "A1", away: "A2", status: "final", winner: "A1" },
      { round: 3, home: "A1", away: "B1", status: "final", winner: "B1" },
      { round: 4, home: "B1", away: "C1", status: "final", winner: "C1" },
    ];
    const r = byAbbr(
      deriveTeamStatuses({
        teams: [...field, { abbr: "B1", seed: 2 }, { abbr: "C1", seed: 5 }],
        games,
      }),
    );
    expect(r.A3).toEqual({ abbr: "A3", status: "eliminated", eliminatedInRound: "WC" });
    expect(r.A2).toEqual({ abbr: "A2", status: "eliminated", eliminatedInRound: "DIV" });
    expect(r.A1).toEqual({ abbr: "A1", status: "eliminated", eliminatedInRound: "CONF" });
    expect(r.B1).toEqual({ abbr: "B1", status: "eliminated", eliminatedInRound: "SB" });
    expect(r.C1).toEqual({ abbr: "C1", status: "champion" });
  });

  it("ignores games that are not final or have no winner (a tie)", () => {
    const r = byAbbr(
      deriveTeamStatuses({
        teams: field,
        games: [
          { round: 2, home: "A2", away: "A3", status: "in_progress", winner: "A2" },
          { round: 2, home: "A1", away: "A4", status: "final" },
        ],
      }),
    );
    expect(Object.values(r).filter((t) => t.status === "eliminated")).toEqual([]);
  });

  it("is idempotent", () => {
    const input = {
      teams: field,
      games: [{ round: 1, home: "A3", away: "A2", status: "final", winner: "A3" } as LiveGame],
    };
    expect(deriveTeamStatuses(input)).toEqual(deriveTeamStatuses(input));
  });
});

describe("deriveRoundStatus", () => {
  const s = (...statuses: LiveGame["status"][]) => statuses.map((status) => ({ status }));
  const cases: [LiveGame["status"][], LiveRoundStatus, LiveRoundStatus][] = [
    [[], "upcoming", "upcoming"],
    [["scheduled", "scheduled"], "upcoming", "upcoming"],
    [["scheduled", "in_progress"], "upcoming", "live"],
    [["final", "scheduled"], "upcoming", "live"],
    [["final", "final"], "live", "final"],
    [["final", "final"], "final", "final"],
    [["in_progress"], "final", "live"],
  ];
  it.each(cases)("%j from %s is %s", (games, current, expected) => {
    expect(deriveRoundStatus(s(...games), current)).toBe(expected);
  });
  it("is not final while games of the round are still unlisted", () => {
    expect(deriveRoundStatus(s("final", "final"), "live", 4)).toBe("live");
    expect(deriveRoundStatus(s("final", "final", "final", "final"), "live", 4)).toBe("final");
    expect(deriveRoundStatus(s("scheduled"), "upcoming", 4)).toBe("upcoming");
    expect(ROUND_GAME_COUNTS).toEqual([6, 4, 2, 1]);
  });
  it("never touches a finalized round", () => {
    expect(deriveRoundStatus(s("in_progress"), "finalized")).toBe("finalized");
  });
});

describe("nextPollDelay", () => {
  const now = new Date("2027-01-10T12:00:00Z");
  const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();
  const game = (status: PollGame["status"], kickoffMin: number, round = 1): PollGame => ({
    round,
    status,
    kickoff: at(kickoffMin),
  });
  const rounds = (status: LiveRoundStatus) => [1, 2, 3, 4].map((round) => ({ round, status }));
  const delay = (games: PollGame[], r = rounds("upcoming")) =>
    nextPollDelay({ now, games, rounds: r });

  it("polls every 2 minutes while a game is in progress", () => {
    expect(delay([game("in_progress", -60), game("scheduled", 600)])).toBe(POLL_LIVE_MS);
  });
  it("waits until a kickoff within 15 minutes, but never less than 2 minutes", () => {
    expect(delay([game("scheduled", 10)])).toBe(10 * 60_000);
    expect(delay([game("scheduled", 15), game("scheduled", 40)])).toBe(15 * 60_000);
    expect(delay([game("scheduled", 1)])).toBe(POLL_MIN_MS);
  });
  it("polls every 15 minutes on game day: later today, or kicked off but not final", () => {
    expect(delay([game("scheduled", 16)])).toBe(POLL_GAMEDAY_MS);
    expect(delay([game("scheduled", 12 * 60)])).toBe(POLL_GAMEDAY_MS);
    expect(delay([game("scheduled", -5)])).toBe(POLL_GAMEDAY_MS);
  });
  it("polls every 6 hours between rounds, before the playoffs and with no schedule", () => {
    expect(delay([game("scheduled", 12 * 60 + 1)])).toBe(POLL_IDLE_MS);
    expect(delay([game("final", -600)], rounds("final"))).toBe(POLL_IDLE_MS);
    expect(delay([])).toBe(POLL_IDLE_MS);
  });
  it("turns off once the Super Bowl is final and every round is finalized", () => {
    const sb = game("final", -600, 4);
    expect(delay([game("final", -9000), sb], rounds("finalized"))).toBeNull();
    // final but not yet finalized: stat corrections still possible
    expect(delay([sb], rounds("final"))).toBe(POLL_IDLE_MS);
    // a round is missing from the list
    expect(delay([sb], [{ round: 4, status: "finalized" }])).toBe(POLL_IDLE_MS);
    // no Super Bowl game known
    expect(delay([game("final", -600, 3)], rounds("finalized"))).toBe(POLL_IDLE_MS);
    // a Super Bowl game that is not final
    expect(delay([game("scheduled", 60 * 24, 4)], rounds("finalized"))).toBe(POLL_IDLE_MS);
  });
});

describe("canonicalStatLineJson", () => {
  it("is independent of key order", () => {
    const a = canonicalStatLineJson({
      counts: { rush_yds: 4, rush_td: 1 },
      events: { fg_made: [40], fg_missed: [50] },
    });
    const b = canonicalStatLineJson({
      counts: { rush_td: 1, rush_yds: 4 },
      events: { fg_missed: [50], fg_made: [40] },
    });
    expect(a).toBe(b);
    expect(canonicalStatLineJson({ counts: { rush_yds: 1 } })).toBe('{"counts":{"rush_yds":1}}');
  });
  it("sorts keys in both directions", () => {
    expect(canonicalStatLineJson({ counts: { rec: 1, pass_td: 2, rec_yds: 3 } })).toBe(
      '{"counts":{"pass_td":2,"rec":1,"rec_yds":3}}',
    );
  });
});
