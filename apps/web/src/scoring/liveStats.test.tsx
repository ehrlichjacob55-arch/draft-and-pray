import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { IngestResponse } from "@dnp/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import { draftData, idleIngest, meMember, renderRoute, seasonData } from "../test/utils";
import { gameLine, relativePast, relativeTime } from "./LiveStatsSection";

const game = (over: Partial<IngestResponse["rounds"][number]["games"][number]> = {}) => ({
  gameId: "g1",
  home: "CAR",
  away: "LAR",
  homeScore: 31,
  awayScore: 34,
  status: "final" as const,
  kickoff: "2026-01-10T21:30:00.000Z",
  ...over,
});

const live = (over: Partial<IngestResponse> = {}): IngestResponse => ({
  ...idleIngest,
  enabled: true,
  nextPollAt: new Date(Date.now() + 120_000).toISOString(),
  lastRunAt: new Date(Date.now() - 300_000).toISOString(),
  lastSuccessAt: new Date(Date.now() - 300_000).toISOString(),
  rounds: [
    {
      round: 1,
      code: "WC",
      status: "live",
      overrideCount: 0,
      finalizedAt: null,
      providerChangedAt: null,
      games: [
        game(),
        game({
          gameId: "g2",
          home: "CHI",
          away: "GB",
          status: "in_progress",
          homeScore: 10,
          awayScore: 7,
        }),
      ],
    },
    {
      round: 2,
      code: "DIV",
      status: "upcoming",
      overrideCount: 0,
      finalizedAt: null,
      providerChangedAt: null,
      games: [
        game({
          gameId: "g3",
          home: "DEN",
          away: "BUF",
          status: "scheduled",
          homeScore: 0,
          awayScore: 0,
        }),
      ],
    },
    {
      round: 3,
      code: "CONF",
      status: "upcoming",
      overrideCount: 0,
      finalizedAt: null,
      providerChangedAt: null,
      games: [],
    },
  ],
  ...over,
});

function setup(initial: IngestResponse, api: Record<string, unknown> = {}) {
  const user = userEvent.setup();
  const ingest = vi.fn(async () => initial);
  const r = renderRoute("/commissioner", {
    api: {
      me: async () => meMember("commissioner"),
      season: async () => seasonData({ myRole: "commissioner" }),
      draft: async () => draftData({ myRole: "commissioner" }),
      listManagers: async () => [],
      scoring: async () => ({ seasonId: "s2026", active: null, versions: [] }),
      ingest,
      ...api,
    },
  });
  return { user, ingest, ...r };
}
const card = async () => within(await screen.findByTestId("live-stats-section"));

afterEach(() => vi.restoreAllMocks());

describe("Live stats card", () => {
  it("shows an untouched season as off and never updated", async () => {
    setup(idleIngest);
    const c = await card();
    expect(await c.findByText("Live stats are off")).toBeInTheDocument();
    expect(c.getByText("Not updated yet")).toBeInTheDocument();
    expect(c.getByRole("button", { name: "Turn on" })).toBeEnabled();
    expect(c.getByRole("button", { name: "Refresh now" })).toBeEnabled();
    expect(c.getByText(/No games yet/)).toBeInTheDocument();
  });

  it("shows on, last updated, next check, and every round with its games", async () => {
    setup(live());
    const c = await card();
    expect(await c.findByText("Live stats are on")).toBeInTheDocument();
    expect(c.getByTestId("live-stats-status")).toHaveTextContent("Last updated 5 min ago");
    expect(c.getByTestId("live-stats-status")).toHaveTextContent("Next check in 2 min");
    expect(c.getByRole("button", { name: "Turn off" })).toBeInTheDocument();
    const wc = within(c.getByTestId("live-round-WC"));
    expect(wc.getByText("Wild Card")).toBeInTheDocument();
    expect(wc.getByText("Live")).toBeInTheDocument();
    expect(wc.getByText("LAR 34 @ CAR 31 · Final")).toBeInTheDocument();
    expect(wc.getByText("GB 7 @ CHI 10 · Live")).toBeInTheDocument();
    const div = within(c.getByTestId("live-round-DIV"));
    expect(div.getByText("Upcoming")).toBeInTheDocument();
    expect(div.getByText(/^BUF @ DEN · /)).toBeInTheDocument();
    expect(
      within(c.getByTestId("live-round-CONF")).getByText("No games listed yet"),
    ).toBeInTheDocument();
  });

  it("says when no more checks are scheduled", async () => {
    setup(live({ nextPollAt: null }));
    expect(await (await card()).findByText(/No more checks scheduled/)).toBeInTheDocument();
  });

  it("turns live stats on and off and shows the response", async () => {
    const setIngest = vi
      .fn()
      .mockResolvedValueOnce(live())
      .mockResolvedValueOnce({ ...idleIngest, enabled: false });
    const { user, ingest } = setup(idleIngest, { setIngest });
    const c = await card();
    await user.click(await c.findByRole("button", { name: "Turn on" }));
    expect(setIngest).toHaveBeenLastCalledWith("s2026", true);
    expect(await c.findByText("Live stats are on")).toBeInTheDocument();
    await user.click(c.getByRole("button", { name: "Turn off" }));
    expect(setIngest).toHaveBeenLastCalledWith("s2026", false);
    expect(await c.findByText("Live stats are off")).toBeInTheDocument();
    expect(ingest).toHaveBeenCalledTimes(1); // the responses are enough, no refetch
  });

  it("refreshes now: disabled while running, then shows the result", async () => {
    let finish: (v: IngestResponse) => void = () => {};
    const runIngest = vi.fn(() => new Promise<IngestResponse>((res) => (finish = res)));
    const { user } = setup(live({ rounds: [] }), { runIngest });
    const c = await card();
    await user.click(await c.findByRole("button", { name: "Refresh now" }));
    expect(runIngest).toHaveBeenCalledWith("s2026");
    expect(c.getByRole("button", { name: "Refreshing…" })).toBeDisabled();
    expect(c.getByRole("button", { name: "Turn off" })).toBeDisabled();
    await act(async () => finish(live()));
    expect(await c.findByRole("button", { name: "Refresh now" })).toBeEnabled();
    expect(c.getByText("LAR 34 @ CAR 31 · Final")).toBeInTheDocument();
  });

  it("shows the last error from a failed update", async () => {
    setup(live({ lastError: "ESPN scoreboard (week 1) could not be reached" }));
    const c = await card();
    expect(await c.findByRole("alert")).toHaveTextContent(
      "The last update did not work: ESPN scoreboard (week 1) could not be reached",
    );
  });

  it("shows a friendly message when an action fails, including a busy update", async () => {
    const runIngest = vi.fn().mockRejectedValue(new ApiError(409, "ingest_busy", "busy"));
    const { user } = setup(live(), { runIngest });
    const c = await card();
    await user.click(await c.findByRole("button", { name: "Refresh now" }));
    expect(await c.findByRole("alert")).toHaveTextContent("A stats update is already running");
    expect(c.getByRole("button", { name: "Refresh now" })).toBeEnabled();
  });

  it("lists a few warnings open and collapses many", async () => {
    const few = Array.from({ length: 3 }, (_, i) => `Warning ${i + 1}`);
    const many = Array.from({ length: 6 }, (_, i) => `Many ${i + 1}`);
    const first = setup(live({ warnings: few }));
    let c = await card();
    const open = await c.findByTestId("live-warnings");
    expect(open).toHaveAttribute("open");
    expect(c.getByText("3 warnings")).toBeInTheDocument();
    first.unmount();
    setup(live({ warnings: many }));
    c = await card();
    const closed = await c.findByTestId("live-warnings");
    expect(closed).not.toHaveAttribute("open");
    expect(c.getByText("6 warnings")).toBeInTheDocument();
    setup(live({ warnings: ["Only one"] }));
    expect((await screen.findAllByText("1 warning")).length).toBeGreaterThan(0);
  });

  it("offers a retry when the state cannot be loaded", async () => {
    const ingest = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(0, "network_error", "x"))
      .mockResolvedValue(live());
    const { user } = setup(idleIngest, { ingest });
    const c = await card();
    expect(await c.findByRole("alert")).toHaveTextContent("Could not reach the server");
    await user.click(c.getByRole("button", { name: "Try again" }));
    expect(await c.findByText("Live stats are on")).toBeInTheDocument();
    await waitFor(() => expect(c.queryByRole("alert")).not.toBeInTheDocument());
  });
});

describe("helpers", () => {
  const now = new Date("2026-01-10T12:00:00Z");
  const at = (ms: number) => new Date(now.getTime() + ms).toISOString();
  it("describes times relative to now", () => {
    expect(relativeTime(at(-10_000), now)).toBe("just now");
    expect(relativeTime(at(10_000), now)).toBe("in a moment");
    expect(relativePast(at(10_000), now)).toBe("just now");
    expect(relativeTime(at(-5 * 60_000), now)).toBe("5 min ago");
    expect(relativeTime(at(2 * 60_000), now)).toBe("in 2 min");
    expect(relativeTime(at(6 * 3600_000), now)).toBe("in 6 h");
    expect(relativeTime(at(-3 * 3600_000), now)).toBe("3 h ago");
    expect(relativeTime(at(3 * 24 * 3600_000), now)).toBe("in 3 days");
  });
  it("formats a game line by status", () => {
    expect(gameLine(game())).toBe("LAR 34 @ CAR 31 · Final");
    expect(gameLine(game({ status: "in_progress" }))).toBe("LAR 34 @ CAR 31 · Live");
    expect(gameLine(game({ status: "scheduled" }))).toMatch(/^LAR @ CAR · /);
  });
});
