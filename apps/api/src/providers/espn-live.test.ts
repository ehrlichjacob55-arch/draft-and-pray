import { describe, expect, it } from "vitest";
import { createEspnLiveSource } from "./espn-live";
import { scoreboardJson, summaryJson } from "./espn-fixtures";
import { PROVIDER_USER_AGENT, type FetchLike } from "./http";
import { PoolSourceError } from "./types";

const field = new Set(["SEA", "NE", "DEN", "LAR"]);

function fakeFetch(handlers: Record<string, () => unknown>) {
  const urls: string[] = [];
  const headers: unknown[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    urls.push(url);
    headers.push(init?.headers ?? {});
    const key = Object.keys(handlers).find((k) => url.includes(k));
    if (!key) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(handlers[key]!()));
  };
  return { fetchImpl, urls, headers };
}
const week = (n: number) => `week=${n}`;

describe("createEspnLiveSource", () => {
  it("fetches weeks 1, 2, 3 and 5 as rounds 1-4 with the descriptive User-Agent", async () => {
    const f = fakeFetch({
      [week(1)]: () => scoreboardJson(1),
      [week(2)]: () => scoreboardJson(2),
      [week(3)]: () => scoreboardJson(3),
      [week(5)]: () => scoreboardJson(5),
    });
    const rounds = await createEspnLiveSource({ fetchImpl: f.fetchImpl }).fetchRoundGames(
      2025,
      field,
    );
    expect(rounds.map((r) => [r.round, r.games.length])).toEqual([
      [1, 6],
      [2, 4],
      [3, 2],
      [4, 1],
    ]);
    expect(f.urls).toHaveLength(4);
    expect(f.urls.every((u) => u.includes("seasontype=3&dates=2025"))).toBe(true);
    expect(JSON.stringify(f.headers[0])).toContain(PROVIDER_USER_AGENT);
  });

  it("uses week 4 as the Super Bowl only when week 5 is empty and week 4 is one game between playoff teams", async () => {
    const sb = scoreboardJson(5) as { events: unknown[] };
    const handlers = (week4: unknown) => ({
      [week(1)]: () => scoreboardJson(1),
      [week(2)]: () => scoreboardJson(2),
      [week(3)]: () => scoreboardJson(3),
      [week(5)]: () => ({ events: [] }),
      [week(4)]: () => week4,
    });
    const source = (w4: unknown) =>
      createEspnLiveSource({ fetchImpl: fakeFetch(handlers(w4)).fetchImpl });
    const used = await source(sb).fetchRoundGames(2025, field);
    expect(used[3]?.games.map((g) => g.gameId)).toEqual(["401772988"]);
    // the Pro Bowl: one game, but not between playoff teams
    const proBowl = JSON.parse(
      JSON.stringify(sb).replaceAll('"SEA"', '"AFC"').replaceAll('"NE"', '"NFC"'),
    );
    expect((await source(proBowl).fetchRoundGames(2025, field))[3]?.games).toEqual([]);
    // several games in week 4
    const two = { events: [...sb.events, ...sb.events] };
    expect((await source(two).fetchRoundGames(2025, field))[3]?.games).toEqual([]);
    // nothing in week 4 either
    expect((await source({ events: [] }).fetchRoundGames(2025, field))[3]?.games).toEqual([]);
  });

  it("fails with a safe message when a scoreboard cannot be read", async () => {
    const f = fakeFetch({ [week(1)]: () => ({ nope: true }) });
    await expect(
      createEspnLiveSource({ fetchImpl: f.fetchImpl }).fetchRoundGames(2025, field),
    ).rejects.toThrow(PoolSourceError);
  });

  it("fetches and parses one game summary", async () => {
    const f = fakeFetch({ "summary?event=401772979": () => summaryJson("401772979") });
    const s = await createEspnLiveSource({ fetchImpl: f.fetchImpl }).fetchSummary("401772979");
    expect([s.home.abbr, s.away.abbr]).toEqual(["CAR", "LAR"]);
    await expect(
      createEspnLiveSource({ fetchImpl: f.fetchImpl }).fetchSummary("1"),
    ).rejects.toThrow(/HTTP 404/);
  });
});
