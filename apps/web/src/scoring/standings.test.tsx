import { act, screen, within } from "@testing-library/react";
import type { StandingsResponse } from "@dnp/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meMember, renderRoute, seasonData } from "../test/utils";
import { installMockWebSocket, MockWebSocket } from "../test/ws";
import { fmt } from "./StandingsPage";

type Row = StandingsResponse["rows"][number];
const row = (over: Partial<Row> & Pick<Row, "teamId" | "teamName">): Row => ({
  rank: 1,
  tied: false,
  teamAbbr: "ABBR",
  rounds: [
    { round: 1, points: 98.4, provisional: false },
    { round: 2, points: 41.2, provisional: true },
    { round: 3, points: null, provisional: false },
    { round: 4, points: null, provisional: false },
  ],
  total: 139.6,
  playersAlive: 7,
  playersTotal: 10,
  maxGamesRemaining: 12,
  ...over,
});
const standings = (over: Partial<StandingsResponse> = {}): StandingsResponse => ({
  asOf: 2,
  rounds: [
    { round: 1, code: "WC", status: "finalized" },
    { round: 2, code: "DIV", status: "live" },
    { round: 3, code: "CONF", status: "upcoming" },
    { round: 4, code: "SB", status: "upcoming" },
  ],
  rows: [
    row({ teamId: "t1", teamName: "Gridiron Gang" }),
    row({
      teamId: "t2",
      teamName: "Pray Hard",
      rank: 2,
      tied: true,
      total: 134.1,
      playersAlive: 5,
    }),
    row({ teamId: "t3", teamName: "Blitz Club", rank: 2, tied: true, total: 134.1 }),
    row({ teamId: "t4", teamName: "Red Zone", rank: 4, total: 0.5 }),
  ],
  placings: null,
  ...over,
});

function setup(data: StandingsResponse, api: Record<string, unknown> = {}) {
  const fetch = vi.fn(async () => data);
  const r = renderRoute("/standings", {
    api: {
      me: async () => meMember("manager"),
      season: async () => seasonData(),
      standings: fetch,
      realtimeTicket: async () => ({ ticket: "t", wsUrl: "ws://x.test" }),
      ...api,
    },
  });
  return { fetch, ...r };
}

beforeEach(() => installMockWebSocket());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Standings page", () => {
  it("shows the current round in the header and every team's rounds, total and players alive", async () => {
    setup(standings());
    expect(
      await screen.findByRole("heading", { name: "Standings · Divisional Live" }),
    ).toBeInTheDocument();
    const table = within(screen.getByRole("table", { name: "Standings" }));
    expect(table.getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "#",
      "Team",
      "WC",
      "DIV",
      "CONF",
      "SB",
      "Total",
      "Alive",
    ]);
    const first = within(screen.getByTestId("standing-t1"));
    expect(first.getByText("Gridiron Gang")).toBeInTheDocument();
    expect(first.getByText("98.4")).toBeInTheDocument();
    expect(first.getByText("139.6")).toBeInTheDocument();
    expect(first.getByText("7/10")).toBeInTheDocument();
    // rounds without a score are a dash
    expect(first.getAllByText("—")).toHaveLength(2);
  });

  it("marks provisional values with * and explains it in a footnote", async () => {
    setup(standings());
    const first = within(await screen.findByTestId("standing-t1"));
    expect(first.getByText("41.2*")).toBeInTheDocument();
    expect(first.queryByText("98.4*")).not.toBeInTheDocument();
    expect(screen.getByText(/\* provisional/)).toBeInTheDocument();
  });

  it("labels tied ranks T-n and orders as the server did", async () => {
    setup(standings());
    await screen.findByTestId("standing-t1");
    const ranks = screen
      .getAllByTestId(/^standing-/)
      .map((tr) => tr.querySelector("td")?.textContent);
    expect(ranks).toEqual(["1", "T-2", "T-2", "4"]);
    expect(within(screen.getByTestId("standing-t1")).getByText("1")).toBeInTheDocument();
  });

  it("puts each team's rounds under its name for narrow screens", async () => {
    setup(standings());
    const first = within(await screen.findByTestId("standing-t1"));
    expect(first.getByTestId("rounds-inline")).toHaveTextContent(
      "WC 98.4 · DIV 41.2* · CONF — · SB —",
    );
  });

  it("shows medals only once the Super Bowl is finalized", async () => {
    const { unmount } = setup(standings());
    await screen.findByTestId("standing-t1");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    unmount();
    setup(
      standings({
        placings: [
          { place: 1, teamId: "t1" },
          { place: 2, teamId: "t2" },
          { place: 2, teamId: "t3" },
        ],
      }),
    );
    expect(
      await within(await screen.findByTestId("standing-t1")).findByRole("img", { name: "Place 1" }),
    ).toHaveTextContent("🥇");
    expect(
      within(screen.getByTestId("standing-t2")).getByRole("img", { name: "Place 2" }),
    ).toHaveTextContent("🥈");
    expect(
      within(screen.getByTestId("standing-t3")).getByRole("img", { name: "Place 2" }),
    ).toHaveTextContent("🥈");
    expect(within(screen.getByTestId("standing-t4")).queryByRole("img")).not.toBeInTheDocument();
  });

  it("has no footnote when nothing is provisional, and no team links yet", async () => {
    const final = standings({
      rows: [
        row({
          teamId: "t1",
          teamName: "Gridiron Gang",
          rounds: [1, 2, 3, 4].map((round) => ({ round, points: 10, provisional: false })),
        }),
      ],
    });
    setup(final);
    await screen.findByTestId("standing-t1");
    expect(screen.queryByText(/\* provisional/)).not.toBeInTheDocument();
    expect(within(screen.getByRole("table")).queryByRole("link")).not.toBeInTheDocument();
  });

  it("refetches when the season's scores are updated", async () => {
    const { fetch } = setup(standings());
    await screen.findByTestId("standing-t1");
    await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const ws = MockWebSocket.last();
    act(() => {
      ws.open();
      ws.message({ type: "subscribed", channel: "draft:s2026" });
    });
    const afterConnect = fetch.mock.calls.length;
    expect(afterConnect).toBeGreaterThanOrEqual(2); // (re)connecting refetches
    act(() =>
      ws.message({ type: "scores_updated", seasonId: "s2026", at: "2026-01-17T00:00:00Z" }),
    );
    await vi.waitFor(() => expect(fetch.mock.calls.length).toBe(afterConnect + 1));
  });

  it("shows an error with a retry", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(standings());
    setup(standings(), { standings: fetch });
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    act(() => screen.getByRole("button", { name: "Try again" }).click());
    expect(await screen.findByTestId("standing-t1")).toBeInTheDocument();
  });

  it("formats points with at most two decimals", () => {
    expect(fmt(98.4)).toBe("98.4");
    expect(fmt(12)).toBe("12");
    expect(fmt(0.1 + 0.2)).toBe("0.3");
  });
});
