import type { SnapshotPick } from "@dnp/contract";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Api } from "../api";
import { draftData, meMember, renderRoute, TEAM_IDS } from "../test/utils";

afterEach(() => vi.restoreAllMocks());

const picks = (n: number): SnapshotPick[] =>
  Array.from({ length: n }, (_, i) => ({
    overallPick: i + 1,
    round: Math.floor(i / 9) + 1,
    teamId: TEAM_IDS[i % 9]!,
    playerId: `d${i}`,
    slot: "QB" as const,
    madeBy: "manager" as const,
    madeAt: "2026-01-01T00:00:00.000Z",
    player: { name: `Drafted ${i}`, position: "QB" as const, nflTeam: "KC" },
  }));

const complete = (over: Parameters<typeof draftData>[0] = {}) =>
  draftData({
    status: "complete",
    currentPick: 91,
    round: null,
    onClockTeamId: null,
    clock: null,
    picks: picks(90),
    ...over,
  });

function room(snap: ReturnType<typeof draftData>, role: "commissioner" | "manager") {
  return renderRoute("/draft", {
    api: { me: async () => meMember(role), draft: async () => snap },
  });
}

describe("draft room once all selections are made", () => {
  it("shows Draft complete with no Draft buttons, on-the-clock highlight, strip or clock", async () => {
    room(complete({ clock: null }), "manager");
    expect(await screen.findByTestId("draft-complete")).toHaveTextContent("Draft complete");
    // The Players list stays mounted (hidden), so look through hidden elements too.
    expect(screen.queryAllByRole("button", { name: /^Draft /, hidden: true })).toHaveLength(0);
    expect(screen.queryByTestId("draft-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("banner-countdown")).not.toBeInTheDocument();
    expect(screen.queryByTestId("otc-strip")).not.toBeInTheDocument();
    expect(screen.queryByText(/On the clock/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("board-cell-91")).not.toBeInTheDocument();
    // Members never see the redraft entry point.
    expect(screen.queryByTestId("draft-again")).not.toBeInTheDocument();
    expect(screen.queryByText("Commissioner controls")).not.toBeInTheDocument();
  });

  it("even a stale clock in the payload is not shown once complete", async () => {
    room(
      complete({
        clock: {
          startedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-01-01T00:01:30.000Z",
          seconds: 90,
          expired: false,
        },
      }),
      "manager",
    );
    await screen.findByTestId("draft-complete");
    expect(screen.queryByTestId("banner-countdown")).not.toBeInTheDocument();
    expect(screen.queryByText(/Time expired/)).not.toBeInTheDocument();
  });

  it("the commissioner gets a 'Draft again' link to the Commissioner tab", async () => {
    const { router } = room(complete({ myRole: "commissioner" }), "commissioner");
    const link = await screen.findByTestId("draft-again");
    expect(link).toHaveAttribute("href", "/commissioner");
    await userEvent.setup().click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe("/commissioner"));
  });
});

describe("draft room while the draft is being reset", () => {
  it("shows a read-only notice with no panes or controls", async () => {
    room(
      draftData({ status: "resetting", currentPick: 91, round: null, onClockTeamId: null }),
      "manager",
    );
    expect(await screen.findByTestId("draft-resetting")).toHaveTextContent("Resetting the draft");
    expect(screen.queryByTestId("draft-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("draft-columns")).not.toBeInTheDocument();
  });
});

describe("Commissioner tab: Redraft", () => {
  const season = async () => ({
    season: {
      seasonId: "s2026",
      leagueId: "l1",
      leagueName: "L",
      year: 2026,
      status: "drafting" as const,
    },
    teams: [],
    myTeamId: null,
    myRole: "commissioner" as const,
    maxTeams: 9 as const,
  });
  const page = (api: Partial<Api>) =>
    renderRoute("/commissioner", {
      api: {
        me: async () => meMember("commissioner"),
        season,
        listManagers: async () => [],
        ...api,
      },
    });

  it("explains the action, requires typing REDRAFT, then refreshes into the setup view", async () => {
    let started = true;
    const resetDraft = vi.fn(async () => {
      started = false;
      return { status: "scheduled" as const, version: 12, currentPick: 1, picksCleared: 37 };
    });
    page({
      resetDraft,
      draft: async () =>
        started
          ? draftData({ myRole: "commissioner", status: "paused", picks: picks(37) })
          : draftData({ myRole: "commissioner", status: "scheduled", onClockTeamId: null }),
      listPlayers: async () => ({ teams: [], players: [], lastImport: null }),
    });
    const user = userEvent.setup();
    const section = await screen.findByTestId("draft-setup-section");
    expect(await within(section).findByTestId("redraft-control")).toHaveTextContent(
      "Clears all 37 picks and returns the draft to the lobby. Order, teams, queues and auto-draft settings are kept.",
    );
    await user.click(within(section).getByRole("button", { name: "Redraft" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Redraft now" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByRole("textbox"), "redraft");
    expect(confirm).toBeDisabled(); // case-sensitive
    await user.clear(within(dialog).getByRole("textbox"));
    await user.type(within(dialog).getByRole("textbox"), "REDRAFT");
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(resetDraft).toHaveBeenCalledWith("s2026");
    // After success the setup data is refreshed: order and Start controls reappear.
    expect(await screen.findByRole("button", { name: "Start draft" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("redraft-control")).not.toBeInTheDocument();
  });

  it("cancel and Escape close the dialog without calling the API; errors are shown", async () => {
    const resetDraft = vi.fn().mockRejectedValue(new ApiError(409, "conflict", "x"));
    page({
      resetDraft,
      draft: async () =>
        draftData({
          myRole: "commissioner",
          status: "complete",
          picks: picks(90),
          currentPick: 91,
        }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Redraft" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Redraft" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(resetDraft).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Redraft" }));
    await user.type(within(screen.getByRole("dialog")).getByRole("textbox"), "REDRAFT");
    await user.click(screen.getByRole("button", { name: "Redraft now" }));
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent(
      "changed while you were working",
    );
  });

  it("is not offered before the draft starts", async () => {
    page({
      draft: async () =>
        draftData({ myRole: "commissioner", status: "scheduled", onClockTeamId: null }),
      listPlayers: async () => ({ teams: [], players: [], lastImport: null }),
    });
    await screen.findByRole("button", { name: "Start draft" });
    expect(screen.queryByRole("button", { name: "Redraft" })).not.toBeInTheDocument();
  });

  it("members cannot reach it", async () => {
    renderRoute("/commissioner", { api: { me: async () => meMember("manager") } });
    expect(await screen.findByText(/Only the commissioner/)).toBeInTheDocument();
    expect(screen.queryByTestId("redraft-control")).not.toBeInTheDocument();
  });
});
