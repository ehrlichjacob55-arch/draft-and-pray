import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Api } from "../api";
import type { PositionName, SlotName } from "@dnp/contract";
import { defaultPlayers, draftData, meMember, player, renderRoute } from "../test/utils";

afterEach(() => vi.restoreAllMocks());

function room(snap: ReturnType<typeof draftData>, api: Partial<Api> = {}) {
  const draft = vi.fn(async () => snap);
  const utils = renderRoute("/draft", {
    api: { me: async () => meMember("manager"), draft, ...api },
  });
  return { draft, ...utils };
}

const drafted = (slot: SlotName, id: string, name: string, position: PositionName = "QB") => ({
  slot,
  id,
  pick: {
    overallPick: 1,
    round: 1,
    teamId: "t1",
    playerId: id,
    slot,
    madeBy: "manager" as const,
    madeAt: "2026-01-01T00:00:00.000Z",
    player: { name, position, nflTeam: "AAA" },
  },
});

describe("draft room states", () => {
  it("shows the lobby with the order unset and start blockers in plain words", async () => {
    room(
      draftData({
        status: "scheduled",
        round: null,
        order: [],
        onClockTeamId: null,
        currentPick: 1,
        teams: [
          { teamId: "t1", name: "Gridiron Gang", joined: true },
          { teamId: "t2", name: "Pray Hard", joined: false },
        ],
        startBlockers: [
          "teams_incomplete",
          "managers_not_joined",
          "order_incomplete",
          "pool_empty",
        ],
      }),
    );
    const lobby = await screen.findByTestId("draft-lobby");
    expect(lobby).toHaveTextContent("Waiting for the commissioner to start the draft");
    expect(screen.getByTestId("order-not-set")).toBeInTheDocument();
    expect(within(lobby).getByText("Not joined yet")).toBeInTheDocument();
    const blockers = screen.getByTestId("start-blockers");
    expect(blockers).toHaveTextContent("All 9 teams need to be added.");
    expect(blockers).toHaveTextContent("Every team needs a manager who has joined.");
    expect(blockers).toHaveTextContent("draft order");
    expect(blockers).toHaveTextContent("player pool is empty");
    expect(screen.queryByText("Commissioner controls")).not.toBeInTheDocument();
  });

  it("lists teams in draft order in the lobby once set", async () => {
    room(draftData({ status: "scheduled", onClockTeamId: null }));
    const lobby = await screen.findByTestId("draft-lobby");
    const items = within(within(lobby).getByRole("list", { name: "Teams" })).getAllByRole(
      "listitem",
    );
    expect(items).toHaveLength(9);
    expect(items[0]).toHaveTextContent("1.Gridiron Gang");
    expect(items[1]).toHaveTextContent("2.Pray Hard");
  });

  it("my turn: banner calls it out and Draft is enabled for eligible players", async () => {
    room(draftData());
    const banner = await screen.findByTestId("draft-banner");
    expect(banner).toHaveTextContent("Round 1 · Pick 1 of 90");
    expect(banner).toHaveTextContent("On the clock: Gridiron Gang");
    expect(banner).toHaveTextContent("Your pick!");
    expect(screen.getByRole("button", { name: "Draft Quinn Quarter" })).toBeEnabled();
  });

  it("not my turn: shows picks-until and disables Draft", async () => {
    room(draftData({ currentPick: 2, onClockTeamId: "t2" }));
    expect(await screen.findByTestId("banner-until")).toHaveTextContent("You pick in 16 (pick 18)");
    expect(screen.getByRole("button", { name: "Draft Quinn Quarter" })).toBeDisabled();
  });

  it("paused: shows the paused banner and disables Draft", async () => {
    room(draftData({ status: "paused" }));
    expect(await screen.findByTestId("banner-paused")).toHaveTextContent("paused");
    expect(screen.getByRole("button", { name: "Draft Quinn Quarter" })).toBeDisabled();
  });

  it("shows a running clock and a red 'Time expired' when it runs out", async () => {
    const clock = {
      startedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:01:30.000Z",
      seconds: 90,
      expired: false,
    };
    const { unmount } = room(draftData({ clock, serverNow: "2026-01-01T00:00:00.000Z" }));
    expect(await screen.findByTestId("banner-countdown")).toHaveTextContent(/^1:[23]\d$|^1:30$/);
    unmount();
    room(draftData({ clock: { ...clock, expired: true }, serverNow: "2026-01-01T00:01:31.000Z" }));
    const expired = await screen.findByTestId("banner-countdown");
    expect(expired).toHaveTextContent("Time expired");
    expect(expired).toHaveClass("text-error");
  });

  it("complete: shows 'Draft complete' with the board and rosters, no players list", async () => {
    room(draftData({ status: "complete", currentPick: 91, round: null, onClockTeamId: null }));
    expect(await screen.findByTestId("draft-complete")).toHaveTextContent("Draft complete");
    expect(screen.getByTestId("board")).toBeInTheDocument();
    expect(screen.getByTestId("roster")).toBeInTheDocument();
    expect(screen.queryByTestId("players")).not.toBeInTheDocument();
    expect(screen.queryByTestId("board-cell-91")).not.toBeInTheDocument();
  });

  it("shows an error with retry when the snapshot cannot load", async () => {
    const draft = vi.fn().mockRejectedValueOnce(new ApiError(0, "network_error", "x"));
    draft.mockResolvedValue(draftData());
    const user = userEvent.setup();
    renderRoute("/draft", { api: { me: async () => meMember(), draft } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the server");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("draft-banner")).toBeInTheDocument();
  });

  it("never shows email addresses to a manager", async () => {
    room(draftData({ picks: [], myQueue: ["p1"] }));
    await screen.findByTestId("draft-banner");
    expect(screen.getByRole("main").textContent).not.toMatch(/\S+@\S+/);
  });
});

describe("confirmation sheet and pick errors", () => {
  const pickResponse = {
    status: "in_progress" as const,
    version: 2,
    currentPick: 2,
    autoPicked: 0,
    pick: {
      overallPick: 1,
      round: 1,
      teamId: "t1",
      playerId: "p1",
      slot: "QB" as const,
      madeBy: "manager" as const,
    },
  };

  it("asks 'Draft {name} → {slot}?' and posts the pick with expectedPick", async () => {
    const makePick = vi.fn(async () => pickResponse);
    const { draft } = room(draftData(), { makePick });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Draft Rory Runner" }));
    const dialog = screen.getByRole("dialog", { name: "Confirm pick" });
    expect(within(dialog).getByTestId("confirm-message")).toHaveTextContent(
      "Draft Rory Runner → RB1?",
    );
    expect(makePick).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Confirm pick" }));
    expect(makePick).toHaveBeenCalledWith("s2026", { playerId: "p2", expectedPick: 1 });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(draft.mock.calls.length).toBeGreaterThanOrEqual(2); // refetched
  });

  it("Cancel closes the sheet without picking", async () => {
    const makePick = vi.fn();
    room(draftData(), { makePick });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Draft Quinn Quarter" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(makePick).not.toHaveBeenCalled();
  });

  it("stale_pick: refreshes the board and says the draft moved on", async () => {
    const makePick = vi.fn().mockRejectedValue(new ApiError(409, "stale_pick", "stale"));
    const { draft } = room(draftData(), { makePick });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Draft Quinn Quarter" }));
    await user.click(screen.getByRole("button", { name: "Confirm pick" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("draft moved on");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(draft.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ["player_taken", "just drafted by another team"],
    ["not_your_turn", "not your turn"],
    ["not_eligible", "does not fit an open spot"],
    ["slot_filled", "already filled"],
    ["draft_not_active", "not running"],
  ] as const)("%s shows a friendly message in the sheet", async (code, text) => {
    const makePick = vi.fn().mockRejectedValue(new ApiError(409, code, "raw"));
    room(draftData(), { makePick });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Draft Quinn Quarter" }));
    await user.click(screen.getByRole("button", { name: "Confirm pick" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(text);
  });
});

describe("players list", () => {
  it("filters by search, position and NFL team", async () => {
    room(draftData());
    const user = userEvent.setup();
    const list = async () =>
      within(await screen.findByRole("list", { name: "Available players" })).queryAllByRole(
        "listitem",
      );
    expect(await list()).toHaveLength(14);

    await user.type(screen.getByLabelText("Search players"), "rory");
    expect(await list()).toHaveLength(1);
    expect(screen.getByTestId("player-p2")).toHaveTextContent("Q");
    await user.clear(screen.getByLabelText("Search players"));

    await user.selectOptions(screen.getByLabelText("Position"), "K");
    expect(await list()).toHaveLength(2);
    await user.selectOptions(screen.getByLabelText("Position"), "");

    await user.selectOptions(screen.getByLabelText("NFL team"), "BBB");
    expect(await list()).toHaveLength(2);
    await user.type(screen.getByLabelText("Search players"), "zzz");
    expect(screen.getByTestId("players-empty")).toHaveTextContent("No players match");
  });

  const rankedRoom = () => {
    const by = (id: string) => defaultPlayers().find((p) => p.playerId === id)!;
    const available = [
      { ...by("p1"), rank: 40 }, // QB AAA
      { ...by("p2"), rank: 3 }, // RB BBB
      { ...by("p3"), rank: 12 }, // WR BBB
      { ...by("p4"), rank: 1 }, // TE CCC
      { ...by("p5"), rank: null }, // K CCC (unranked)
      { ...by("p6"), rank: null }, // DST AAA (unranked)
      player("p7", "Quentin Backup", "QB", { nflTeam: "DDD", seed: 4, rank: 7 }),
    ];
    return draftData({ available });
  };
  const names = async () =>
    within(await screen.findByRole("list", { name: "Available players" }))
      .getAllByRole("listitem")
      .map((li) =>
        within(li)
          .getByRole("button", { name: /^Draft / })
          .getAttribute("aria-label"),
      );

  it("orders by overall rank regardless of position, unranked D/ST then others last, and shows ranks", async () => {
    room(rankedRoom());
    await userEvent.setup().click(await screen.findByLabelText("Hide ineligible"));
    await screen.findByTestId("player-p4");
    expect(await names()).toEqual([
      "Draft Tim Tightend",
      "Draft Rory Runner",
      "Draft Quentin Backup",
      "Draft Wes Wideout",
      "Draft Quinn Quarter",
      "Draft AAA Defense",
      "Draft Kai Kicker",
    ]);
    expect(screen.getByTestId("rank-p4")).toHaveTextContent("#1");
    expect(screen.getByTestId("rank-p3")).toHaveTextContent("#12");
    expect(screen.getByTestId("rank-p5")).toHaveTextContent("—");
  });

  it("combines position and NFL team filters with search, keeping rank order", async () => {
    room(rankedRoom());
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText("Hide ineligible"));
    await screen.findByTestId("player-p4");
    await user.selectOptions(screen.getByLabelText("NFL team"), "BBB");
    expect(await names()).toEqual(["Draft Rory Runner", "Draft Wes Wideout"]);
    await user.selectOptions(screen.getByLabelText("Position"), "WR");
    expect(await names()).toEqual(["Draft Wes Wideout"]);
    await user.selectOptions(screen.getByLabelText("Position"), "");
    await user.type(screen.getByLabelText("Search players"), "rory");
    expect(await names()).toEqual(["Draft Rory Runner"]);
    await user.selectOptions(screen.getByLabelText("NFL team"), "AAA");
    expect(screen.getByTestId("players-empty")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Search players"));
    await user.selectOptions(screen.getByLabelText("Position"), "QB");
    expect(await names()).toEqual(["Draft Quinn Quarter"]);
  });

  it("shows seed, injury tag and opponent", async () => {
    room(draftData());
    expect(await screen.findByTestId("player-p3")).toHaveTextContent("BBB (#2) · vs CCC");
    expect(screen.getByTestId("player-p2")).toHaveTextContent("Q");
  });

  it("hides ineligible players by default (QB already filled) and can show them disabled", async () => {
    const qb = drafted("QB", "x1", "Old Quarterback");
    room(
      draftData({
        rosters: { ...draftData().rosters, t1: { ...draftData().rosters.t1!, QB: "x1" } },
        picks: [qb.pick],
      }),
    );
    const user = userEvent.setup();
    await screen.findByTestId("player-p2");
    expect(screen.queryByTestId("player-p1")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Hide ineligible")).toBeChecked();

    await user.click(screen.getByLabelText("Hide ineligible"));
    expect(screen.getByTestId("player-p1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Draft Quinn Quarter" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Draft Rory Runner" })).toBeEnabled();
  });
});

describe("queue", () => {
  const withQueue = () => draftData({ myQueue: ["p1", "p2", "p3"], autoDraftTeamIds: [] });

  it("lists the queue and saves reorders", async () => {
    const saveQueue = vi.fn(async (_s: string, ids: string[]) => ({ playerIds: ids }));
    room(withQueue(), { saveQueue });
    const user = userEvent.setup();
    const q = await screen.findByRole("list", { name: "My queue" });
    expect(
      within(q)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      expect.stringContaining("Quinn Quarter"),
      expect.stringContaining("Rory Runner"),
      expect.stringContaining("Wes Wideout"),
    ]);
    await user.click(within(q).getByRole("button", { name: "Move Rory Runner up" }));
    expect(saveQueue).toHaveBeenLastCalledWith("s2026", ["p2", "p1", "p3"]);
    // optimistic: the list already shows the new order
    expect(
      within(screen.getByRole("list", { name: "My queue" })).getAllByRole("listitem")[0],
    ).toHaveTextContent("Rory Runner");
  });

  it("removes and adds players to the queue", async () => {
    const saveQueue = vi.fn(async (_s: string, ids: string[]) => ({ playerIds: ids }));
    room(withQueue(), { saveQueue });
    const user = userEvent.setup();
    const q = await screen.findByRole("list", { name: "My queue" });
    await user.click(within(q).getByRole("button", { name: "Remove Quinn Quarter from queue" }));
    expect(saveQueue).toHaveBeenLastCalledWith("s2026", ["p2", "p3"]);
    await user.click(screen.getByRole("button", { name: "Add Tim Tightend to queue" }));
    expect(saveQueue).toHaveBeenLastCalledWith("s2026", ["p2", "p3", "p4"]);
  });

  it("toggles auto-draft with an explanation", async () => {
    const setAutoDraft = vi.fn(async () => ({
      status: "in_progress" as const,
      version: 3,
      currentPick: 1,
      enabled: true,
      autoPicked: 0,
    }));
    room(draftData(), { setAutoDraft });
    const user = userEvent.setup();
    const box = await screen.findByLabelText(/Auto-draft my team/);
    expect(box).not.toBeChecked();
    expect(screen.getByTestId("queue")).toHaveTextContent("otherwise by position order");
    await user.click(box);
    expect(setAutoDraft).toHaveBeenCalledWith("s2026", true);
  });

  it("shows an empty state", async () => {
    room(draftData());
    expect(await screen.findByTestId("queue-empty")).toBeInTheDocument();
  });
});

describe("board and roster", () => {
  it("renders a 10x9 snake grid with picks, the current pick and auto badges", async () => {
    const p1 = drafted("QB", "p1", "Quinn Quarter").pick;
    room(
      draftData({
        currentPick: 2,
        onClockTeamId: "t2",
        picks: [p1],
        autoDraftTeamIds: ["t3"],
        available: draftData().available.filter((p) => p.playerId !== "p1"),
      }),
    );
    const board = await screen.findByTestId("board");
    expect(within(board).getAllByRole("columnheader")).toHaveLength(10); // Rd + 9 teams
    expect(board.querySelectorAll("tbody tr")).toHaveLength(10);
    expect(within(board).getByTestId("board-cell-1")).toHaveTextContent("Quinn Quarter");
    expect(within(board).getByTestId("board-cell-2")).toHaveAttribute("aria-current", "true");
    expect(within(board).getByTestId("board-cell-1")).not.toHaveAttribute("aria-current");
    expect(within(board).getByTestId("auto-badge-t3")).toHaveTextContent("Auto");
    expect(within(board).queryByTestId("auto-badge-t1")).not.toBeInTheDocument();
    // Snake: round 2 starts with position 9, so pick 10 is in the LAST team column, pick 18 in the first.
    const row2 = board.querySelectorAll("tbody tr")[1]!;
    expect(row2.children[1]).toBe(within(board).getByTestId("board-cell-18"));
    expect(row2.children[9]).toBe(within(board).getByTestId("board-cell-10"));
  });

  it("colour-codes picks by position", async () => {
    const p = drafted("QB", "p1", "Quinn Quarter").pick;
    room(draftData({ picks: [p] }));
    expect(await screen.findByTestId("board-cell-1")).toHaveClass("bg-rose-500/20");
  });

  it("shows my roster slots and can view other teams by name", async () => {
    const d = drafted("QB", "p1", "Quinn Quarter");
    const base = draftData();
    room(
      draftData({
        picks: [d.pick],
        rosters: { ...base.rosters, t1: { ...base.rosters.t1!, QB: "p1" } },
      }),
    );
    const user = userEvent.setup();
    const roster = await screen.findByTestId("roster");
    expect(within(roster).getByTestId("roster-owner")).toHaveTextContent("Your roster");
    expect(within(roster).getByTestId("slot-QB")).toHaveTextContent("Quinn Quarter");
    expect(within(roster).getByTestId("slot-RB1")).toHaveTextContent("Open");
    expect(within(roster).getAllByRole("listitem")).toHaveLength(10);
    await user.selectOptions(within(roster).getByRole("combobox"), "t2");
    expect(within(roster).getByTestId("roster-owner")).toHaveTextContent("Pray Hard roster");
    expect(within(roster).getByTestId("slot-QB")).toHaveTextContent("Open");
  });

  it("phone tabs switch the visible panel", async () => {
    room(draftData());
    const user = userEvent.setup();
    await screen.findByRole("tablist", { name: "Draft sections" });
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Players",
      "Queue",
      "Roster",
      "Board",
    ]);
    const hidden = (id: string) => document.getElementById(id)!.classList.contains("hidden");
    expect(hidden("panel-players")).toBe(false);
    expect(hidden("panel-board")).toBe(true);
    await user.click(screen.getByRole("tab", { name: "Board" }));
    expect(hidden("panel-board")).toBe(false);
    expect(hidden("panel-players")).toBe(true);
  });
});
