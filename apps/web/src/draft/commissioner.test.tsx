import type { ListPlayersResponse, PoolPlayer } from "@dnp/contract";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Api } from "../api";
import { draftData, meMember, renderRoute, TEAM_IDS } from "../test/utils";

afterEach(() => vi.restoreAllMocks());

const action = (over: Record<string, unknown> = {}) => ({
  status: "in_progress" as const,
  version: 9,
  currentPick: 1,
  ...over,
});

const poolPlayer = (id: string, name: string, over: Partial<PoolPlayer> = {}): PoolPlayer => ({
  playerId: id,
  name,
  position: "QB",
  nflTeam: "AAA",
  seed: 1,
  injuryStatus: null,
  depthChartOrder: 1,
  inPool: true,
  manualOverride: false,
  draftedByTeamId: null,
  ...over,
});

const pool = (): ListPlayersResponse => ({
  teams: [
    { abbr: "AAA", name: "Aces", conference: "AFC", seed: 1 },
    { abbr: "BBB", name: "Bees", conference: "NFC", seed: 2 },
  ],
  players: [poolPlayer("p1", "Quinn Quarter"), poolPlayer("p2", "Rory Runner", { inPool: false })],
  lastImport: null,
});

function room(snap: ReturnType<typeof draftData>, api: Partial<Api> = {}) {
  const draft = vi.fn(async () => snap);
  const utils = renderRoute("/draft", {
    api: {
      me: async () => meMember("commissioner"),
      draft,
      listPlayers: async () => pool(),
      ...api,
    },
  });
  return { draft, ...utils };
}

const commish = (over: Parameters<typeof draftData>[0] = {}) =>
  draftData({ myRole: "commissioner", ...over });

/** Opens the (collapsible) controls panel if it is closed. */
async function openControls(user: ReturnType<typeof userEvent.setup>) {
  const summary = await screen.findByText("Commissioner controls");
  const details = summary.closest("details")!;
  if (!details.open) await user.click(summary);
  return details;
}

describe("commissioner: not shown to managers", () => {
  it("managers see no controls", async () => {
    room(draftData(), { me: async () => meMember("manager") });
    await screen.findByTestId("draft-banner");
    expect(screen.queryByText("Commissioner controls")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Make the pick for/)).not.toBeInTheDocument();
  });
});

describe("commissioner: before the draft", () => {
  const scheduled = (over: Parameters<typeof draftData>[0] = {}) =>
    commish({ status: "scheduled", round: null, onClockTeamId: null, ...over });

  it("imports the playoff field (year defaults to 2025) and shows counts", async () => {
    const importPool = vi.fn(async () => ({
      source: "espn+sleeper",
      seasonYear: 2025,
      importedAt: "2026-01-01T00:00:00.000Z",
      counts: { teams: 14, players: 480, added: 480, updated: 0, removed: 0 },
    }));
    room(scheduled(), { importPool });
    const user = userEvent.setup();
    await openControls(user);
    const form = await screen.findByRole("form", { name: "Import playoff field" });
    expect(within(form).getByLabelText("NFL season year")).toHaveValue("2025");
    await user.click(within(form).getByRole("button", { name: "Import playoff field" }));
    expect(importPool).toHaveBeenCalledWith("s2026", 2025);
    expect(await screen.findByTestId("import-result")).toHaveTextContent(
      "Imported 480 players from 14 teams (480 added, 0 updated, 0 removed)",
    );
  });

  it("shows a friendly message when the import source fails", async () => {
    const importPool = vi.fn().mockRejectedValue(new ApiError(502, "pool_import_failed", "x"));
    room(scheduled(), { importPool });
    const user = userEvent.setup();
    await openControls(user);
    await user.click(await screen.findByRole("button", { name: "Import playoff field" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("data source could not be reached");
  });

  it("reviews the pool: search, include/exclude, and add a player", async () => {
    const setPlayerInPool = vi.fn(async (_s: string, id: string, inPool: boolean) =>
      poolPlayer(id, "x", { inPool }),
    );
    const addPlayer = vi.fn(async (_s: string, body: { name: string }) =>
      poolPlayer("p9", body.name),
    );
    room(scheduled(), { setPlayerInPool, addPlayer });
    const user = userEvent.setup();
    await openControls(user);
    const review = await screen.findByTestId("pool-review");
    expect(await within(review).findByTestId("pool-count")).toHaveTextContent("1 of 2 included");

    await user.click(within(review).getByLabelText("Include Quinn Quarter"));
    expect(setPlayerInPool).toHaveBeenCalledWith("s2026", "p1", false);
    await user.click(within(review).getByLabelText("Include Rory Runner"));
    expect(setPlayerInPool).toHaveBeenCalledWith("s2026", "p2", true);

    await user.type(within(review).getByLabelText("Search pool"), "rory");
    expect(within(review).getAllByRole("listitem")).toHaveLength(1);

    const add = within(review).getByRole("form", { name: "Add player" });
    await user.type(within(add).getByLabelText("Player name"), "Late Callup");
    await user.selectOptions(within(add).getByLabelText("New player position"), "WR");
    await user.selectOptions(within(add).getByLabelText("New player NFL team"), "BBB");
    await user.click(within(add).getByRole("button", { name: "Add player" }));
    expect(addPlayer).toHaveBeenCalledWith("s2026", {
      name: "Late Callup",
      position: "WR",
      nflTeam: "BBB",
    });
  });

  it("arranges and saves the draft order", async () => {
    const setDraftOrder = vi.fn(async () => action({ status: "scheduled" }));
    room(scheduled(), { setDraftOrder });
    const user = userEvent.setup();
    await openControls(user);
    const editor = await screen.findByTestId("order-editor");
    const save = within(editor).getByRole("button", { name: "Save order" });
    expect(save).toBeDisabled(); // unchanged
    await user.click(within(editor).getByRole("button", { name: "Move Gridiron Gang down" }));
    await user.click(save);
    expect(setDraftOrder).toHaveBeenCalledWith("s2026", ["t2", "t1", ...TEAM_IDS.slice(2)]);
    expect(await within(editor).findByText("Order saved.")).toBeInTheDocument();
  });

  it("Start succeeds", async () => {
    const startDraft = vi.fn(async () => action());
    const { draft } = room(scheduled(), { startDraft });
    const user = userEvent.setup();
    await openControls(user);
    await user.click(await screen.findByRole("button", { name: "Start draft" }));
    expect(startDraft).toHaveBeenCalledWith("s2026");
    await waitFor(() => expect(draft.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("Start shows every reason when the draft is not ready", async () => {
    const startDraft = vi
      .fn()
      .mockRejectedValue(
        new ApiError(409, "draft_not_ready", "not ready", ["order_incomplete", "pool_empty"]),
      );
    room(scheduled({ startBlockers: ["order_incomplete", "pool_empty"] }), { startDraft });
    const user = userEvent.setup();
    await openControls(user);
    const control = await screen.findByTestId("start-control");
    await user.click(within(control).getByRole("button", { name: "Start draft" }));
    const alert = await within(control).findByRole("alert");
    expect(alert).toHaveTextContent("The draft cannot start yet");
    expect(alert).toHaveTextContent("set the draft order");
    expect(alert).toHaveTextContent("player pool is empty");
  });
});

describe("commissioner: live draft", () => {
  it("pauses and resumes", async () => {
    const pauseDraft = vi.fn(async () => action({ status: "paused" }));
    const resumeDraft = vi.fn(async () => action());
    const { unmount } = room(commish(), { pauseDraft });
    const user = userEvent.setup();
    await openControls(user);
    await user.click(await screen.findByRole("button", { name: "Pause draft" }));
    expect(pauseDraft).toHaveBeenCalledWith("s2026");
    unmount();

    room(commish({ status: "paused" }), { resumeDraft });
    await openControls(user);
    await user.click(await screen.findByRole("button", { name: "Resume draft" }));
    expect(resumeDraft).toHaveBeenCalledWith("s2026");
  });

  it("starts and clears the 90 s clock", async () => {
    const startClock = vi.fn(async () => action());
    const clearClock = vi.fn(async () => action());
    const { unmount } = room(commish(), { startClock });
    const user = userEvent.setup();
    await openControls(user);
    await user.click(await screen.findByRole("button", { name: "Start 90 s clock" }));
    expect(startClock).toHaveBeenCalledWith("s2026", 1);
    unmount();

    const clock = {
      startedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:01:30.000Z",
      seconds: 90,
      expired: false,
    };
    room(commish({ clock }), { clearClock });
    await openControls(user);
    expect(screen.queryByRole("button", { name: "Start 90 s clock" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Clear clock" }));
    expect(clearClock).toHaveBeenCalledWith("s2026");
  });

  it("autopicks for the on-clock team", async () => {
    const autopick = vi.fn(async () => action({ currentPick: 3 }));
    room(commish({ currentPick: 2, onClockTeamId: "t2" }), { autopick });
    const user = userEvent.setup();
    await openControls(user);
    await user.click(await screen.findByRole("button", { name: "Autopick for Pray Hard" }));
    expect(autopick).toHaveBeenCalledWith("s2026", 2);
  });

  it("makes the pick for the on-clock team through the players list (commissioner mode)", async () => {
    const makePick = vi.fn(async () => ({
      ...action({ currentPick: 3 }),
      autoPicked: 0,
      pick: {
        overallPick: 2,
        round: 1,
        teamId: "t2",
        playerId: "p1",
        slot: "QB" as const,
        madeBy: "commissioner" as const,
      },
    }));
    room(commish({ currentPick: 2, onClockTeamId: "t2" }), { makePick });
    const user = userEvent.setup();
    // Not my turn: Draft is disabled until commissioner mode is on.
    expect(await screen.findByRole("button", { name: "Draft Quinn Quarter" })).toBeDisabled();
    await openControls(user);
    await user.click(screen.getByLabelText(/Make the pick for Pray Hard/));
    await user.click(screen.getByRole("button", { name: "Draft Quinn Quarter" }));
    expect(screen.getByTestId("confirm-message")).toHaveTextContent(
      "Draft Quinn Quarter → QB for Pray Hard?",
    );
    await user.click(screen.getByRole("button", { name: "Confirm pick" }));
    expect(makePick).toHaveBeenCalledWith("s2026", {
      playerId: "p1",
      expectedPick: 2,
      teamId: "t2",
    });
  });

  it("undoes the last pick only after confirming", async () => {
    const undoPick = vi.fn(async () => action());
    const pick = {
      overallPick: 1,
      round: 1,
      teamId: "t1",
      playerId: "p1",
      slot: "QB" as const,
      madeBy: "manager" as const,
      madeAt: "2026-01-01T00:00:00.000Z",
      player: { name: "Quinn Quarter", position: "QB" as const, nflTeam: "AAA" },
    };
    room(commish({ currentPick: 2, onClockTeamId: "t2", picks: [pick] }), { undoPick });
    const user = userEvent.setup();
    await openControls(user);
    await user.click(await screen.findByRole("button", { name: "Undo last pick" }));
    expect(undoPick).not.toHaveBeenCalled();
    const confirm = screen.getByRole("group", { name: "Confirm undo" });
    expect(confirm).toHaveTextContent("Undo pick 1 (Quinn Quarter)?");
    await user.click(within(confirm).getByRole("button", { name: "Confirm undo" }));
    expect(undoPick).toHaveBeenCalledWith("s2026");
  });

  it("can undo after the draft is complete", async () => {
    const pick = {
      overallPick: 90,
      round: 10,
      teamId: "t1",
      playerId: "p1",
      slot: "K" as const,
      madeBy: "manager" as const,
      madeAt: "2026-01-01T00:00:00.000Z",
      player: { name: "Kai Kicker", position: "K" as const, nflTeam: "AAA" },
    };
    room(
      commish({
        status: "complete",
        currentPick: 91,
        round: null,
        onClockTeamId: null,
        picks: [pick],
      }),
    );
    const user = userEvent.setup();
    await openControls(user);
    expect(await screen.findByRole("button", { name: "Undo last pick" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause draft" })).not.toBeInTheDocument();
  });

  it("shows pool include/exclude while paused", async () => {
    room(commish({ status: "paused" }));
    const user = userEvent.setup();
    await openControls(user);
    await user.click(await screen.findByText("Player pool (while paused)"));
    expect(await screen.findByLabelText("Include Quinn Quarter")).toBeInTheDocument();
  });

  it("surfaces an action error", async () => {
    const pauseDraft = vi.fn().mockRejectedValue(new ApiError(409, "draft_wrong_status", "x"));
    room(commish(), { pauseDraft });
    const user = userEvent.setup();
    await openControls(user);
    await user.click(await screen.findByRole("button", { name: "Pause draft" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "not available in the draft's current state",
    );
  });
});

describe("Commissioner page: Draft setup section", () => {
  it("shows the setup tools while the draft has not started", async () => {
    renderRoute("/commissioner", {
      api: {
        me: async () => meMember("commissioner"),
        season: async () => ({
          season: {
            seasonId: "s2026",
            leagueId: "l1",
            leagueName: "L",
            year: 2026,
            status: "setup" as const,
          },
          teams: [],
          myTeamId: null,
          myRole: "commissioner" as const,
          maxTeams: 9 as const,
        }),
        listManagers: async () => [],
        draft: async () => commish({ status: "scheduled", round: null, onClockTeamId: null }),
        listPlayers: async () => pool(),
      },
    });
    const section = await screen.findByTestId("draft-setup-section");
    expect(
      await within(section).findByRole("form", { name: "Import playoff field" }),
    ).toBeInTheDocument();
    expect(within(section).getByTestId("order-editor")).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Start draft" })).toBeInTheDocument();
  });
});

describe("League home Draft card", () => {
  const home = (snap: ReturnType<typeof draftData>) =>
    renderRoute("/", {
      api: {
        me: async () => meMember("manager"),
        season: async () => ({
          season: {
            seasonId: "s2026",
            leagueId: "l1",
            leagueName: "L",
            year: 2026,
            status: "drafting" as const,
          },
          teams: [{ teamId: "t1", name: "Gridiron Gang", isMine: true }],
          myTeamId: "t1",
          myRole: "manager" as const,
          maxTeams: 9 as const,
        }),
        draft: async () => snap,
      },
    });

  it("shows lobby / live / complete status and links to the draft room", async () => {
    const { unmount } = home(draftData({ status: "scheduled" }));
    expect(await screen.findByTestId("draft-card-status")).toHaveTextContent("Lobby");
    expect(
      within(screen.getByTestId("draft-card")).getByRole("link", { name: "Draft room" }),
    ).toHaveAttribute("href", "/draft");
    unmount();

    const live = home(draftData({ currentPick: 5, onClockTeamId: "t5" }));
    expect(await screen.findByTestId("draft-card-status")).toHaveTextContent(
      "Pick 5 — Red Zone on the clock",
    );
    live.unmount();

    home(draftData({ status: "complete", currentPick: 91 }));
    expect(await screen.findByTestId("draft-card-status")).toHaveTextContent("Draft complete");
  });
});
