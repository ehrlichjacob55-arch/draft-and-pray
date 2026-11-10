import type { AvailablePlayer, DraftSnapshot, SnapshotPick } from "@dnp/contract";
import { act, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../api";
import { draftData, meMember, player, renderRoute } from "../test/utils";
import { ALERT_TITLE, useTurnAlert } from "./turnAlert";

// Room sounds have their own tests (useRoomSounds.test.ts); keep them out of the beep counts here.
vi.mock("./sounds", () => ({ playChime: vi.fn(), playFanfare: vi.fn(), playAlarm: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  document.title = "";
});

const QB = (over: Record<string, number>) => ({
  gp: 17,
  pass_cmp: 300,
  pass_att: 450,
  pass_yd: 3000,
  pass_td: 20,
  pass_int: 5,
  rush_yd: 100,
  rush_td: 1,
  ...over,
});

/** Default players plus stats, and three more QBs for sort tests. */
function statSnapshot(over: Partial<DraftSnapshot> = {}): DraftSnapshot {
  const base = draftData();
  const stats: Record<string, AvailablePlayer["stats"]> = {
    p1: QB({ pass_yd: 4500, pass_td: 30 }),
    p2: { gp: 16, rush_att: 250, rush_yd: 1200, rush_td: 9, rec: 40, rec_yd: 300, rec_td: 2 },
    p3: { gp: 17, rec_tgt: 150, rec: 100, rec_yd: 1300, rec_td: 8, rush_yd: 10 },
    p4: null,
    p5: { gp: 17, fgm: 30, fga: 35, fgm_50p: 4, xpm: 40, xpa: 41 },
    p6: { gp: 17, sack: 50, int: 15, fum_rec: 9, def_td: 2, def_st_td: 1, pts_allow: 330 },
    p7: QB({ pass_yd: 3000 }),
  };
  const ranks: Record<string, number | null> = { p1: 20, p7: 7, p2: 3, p3: 12, p4: 1 };
  const available = [
    ...base.available.map((p) => ({
      ...p,
      stats: stats[p.playerId] ?? null,
      rank: ranks[p.playerId] ?? null,
    })),
    player("p15", "Quincy Third", "QB", {
      nflTeam: "DDD",
      seed: 4,
      rank: 40,
      stats: QB({ pass_yd: 3800 }),
    }),
    player("p16", "Quade Nostats", "QB", { nflTeam: "DDD", seed: 4, rank: 1, stats: null }),
  ];
  return draftData({ available, statsSeason: 2025, ...over });
}

function room(
  snap: DraftSnapshot,
  api: Partial<Api> = {},
  role: "commissioner" | "manager" = "manager",
) {
  const draft = vi.fn(async () => snap);
  const utils = renderRoute("/draft", { api: { me: async () => meMember(role), draft, ...api } });
  return { draft, ...utils };
}

/** Pretend to be a phone: `(min-width: 768px)` does not match. */
function phone() {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

const sections = (root: HTMLElement) =>
  [...root.querySelectorAll("section")].map((s) => s.getAttribute("aria-label"));
const headers = async () =>
  within(await screen.findByRole("table", { name: "Available players" }))
    .getAllByRole("columnheader")
    .map((h) => h.textContent!.replace(/[▲▼]/g, "").trim());
const drafts = async () => {
  await screen.findByRole("table", { name: "Available players" });
  return screen
    .getAllByRole("button", { name: /^Draft / })
    .map((b) => b.getAttribute("aria-label")!.slice(6));
};

describe("desktop layout", () => {
  it("renders the roster, the players list, and the right pane", async () => {
    room(statSnapshot());
    const columns = await screen.findByTestId("draft-columns");
    expect(within(within(columns).getByTestId("col-left")).getByTestId("roster")).toBeVisible();
    const center = within(columns).getByTestId("col-center");
    expect(within(center).getByTestId("players")).toBeVisible();
    expect(within(center).queryByTestId("board")).not.toBeInTheDocument();
    expect(within(center).getByTestId("stats-note")).toHaveTextContent(
      "Stats: 2025 regular season",
    );
    expect(sections(within(columns).getByTestId("col-right"))).toEqual([
      "Queue",
      "Drafted players",
    ]);
    // The on-the-clock strip sits between the banner and the columns, not in the right pane.
    expect(screen.getByTestId("otc-strip").compareDocumentPosition(columns)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // Phone tabs are not rendered on desktop.
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("toggles between Players and Board with a keyboard-accessible button", async () => {
    room(statSnapshot());
    const user = userEvent.setup();
    const toggle = await screen.findByRole("button", { name: "Players ⇄ Board" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("board")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Players" })).not.toBeInTheDocument();
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("board")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Players" })).toBeVisible();
  });

  it("keeps the player filters when switching to the board and back", async () => {
    room(statSnapshot());
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Search players"), "rory");
    const toggle = screen.getByRole("button", { name: "Players ⇄ Board" });
    await user.click(toggle);
    await user.click(toggle);
    expect(screen.getByLabelText("Search players")).toHaveValue("rory");
  });

  it("defaults the center to the board once the draft is complete (and can still switch)", async () => {
    room(statSnapshot({ status: "complete", currentPick: 91, round: null, onClockTeamId: null }));
    expect(await screen.findByTestId("board")).toBeVisible();
    expect(screen.getByRole("button", { name: "Players ⇄ Board" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByTestId("otc-strip")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Players ⇄ Board" }));
    expect(screen.getByRole("region", { name: "Players" })).toBeVisible();
  });
});

describe("players list columns", () => {
  const FIXED = ["Rank", "Player", "Pos", "Team"];
  const cases: [string, string[]][] = [
    ["", ["GP", "Pass Yd", "Pass TD", "Rush Yd", "Rush TD", "Rec", "Rec Yd", "Rec TD"]],
    ["QB", ["GP", "Cmp/Att", "Pass Yd", "Pass TD", "INT", "Rush Yd", "Rush TD"]],
    ["RB", ["GP", "Rush Att", "Rush Yd", "Rush TD", "Rec", "Rec Yd", "Rec TD"]],
    ["WR", ["GP", "Tgt", "Rec", "Rec Yd", "Rec TD", "Rush Yd"]],
    ["TE", ["GP", "Tgt", "Rec", "Rec Yd", "Rec TD", "Rush Yd"]],
    ["K", ["GP", "FGM/FGA", "FG 50+", "XPM/XPA"]],
    ["DST", ["GP", "Sacks", "INT", "Fum Rec", "Def TD", "ST TD", "Pts Allowed"]],
  ];
  it.each(cases)("position %j shows exactly its stat columns", async (pos, stat) => {
    room(statSnapshot());
    if (pos) await userEvent.setup().selectOptions(await screen.findByLabelText("Position"), pos);
    expect(await headers()).toEqual([...FIXED, ...stat, "Actions"]);
  });

  const cell = (id: string, col: string) => screen.getByTestId(`stat-${id}-${col}`);

  it("shows values, composite columns, '—' for null stats and blanks where N/A (All)", async () => {
    room(statSnapshot());
    const user = userEvent.setup();
    await screen.findByTestId("player-p1");
    expect(cell("p1", "pass_yd")).toHaveTextContent("4500");
    expect(cell("p1", "rec")).toHaveTextContent(/^$/); // a QB has no receptions column
    expect(cell("p6", "gp")).toHaveTextContent("17"); // DST has GP
    expect(cell("p6", "pass_yd")).toHaveTextContent(/^$/);
    expect(cell("p4", "gp")).toHaveTextContent("—"); // TE with no stats entry
    expect(cell("p4", "rec_yd")).toHaveTextContent("—");

    await user.selectOptions(screen.getByLabelText("Position"), "QB");
    expect(cell("p1", "cmp_att")).toHaveTextContent("300/450");
    await user.selectOptions(screen.getByLabelText("Position"), "K");
    expect(cell("p5", "fg")).toHaveTextContent("30/35");
    expect(cell("p5", "xp")).toHaveTextContent("40/41");
    await user.selectOptions(screen.getByLabelText("Position"), "DST");
    expect(cell("p6", "pts_allow")).toHaveTextContent("330");
    await user.selectOptions(screen.getByLabelText("Position"), "TE");
    expect(cell("p4", "rec_td")).toHaveTextContent("—");
  });
});

describe("players list sorting and filters", () => {
  it("sorts a stat column desc, then asc, then back to rank; null stats stay last", async () => {
    room(statSnapshot());
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("Position"), "QB");
    // rank: p16 (1), p7 (7), p1 (20), p15 (40)
    expect(await drafts()).toEqual([
      "Quade Nostats",
      "Quentin Backup",
      "Quinn Quarter",
      "Quincy Third",
    ]);
    const header = () => screen.getByRole("button", { name: /^Pass Yd/ });
    await user.click(header());
    expect(header().closest("th")).toHaveAttribute("aria-sort", "descending");
    expect(await drafts()).toEqual([
      "Quinn Quarter",
      "Quincy Third",
      "Quentin Backup",
      "Quade Nostats",
    ]);
    await user.click(header());
    expect(header().closest("th")).toHaveAttribute("aria-sort", "ascending");
    expect(await drafts()).toEqual([
      "Quentin Backup",
      "Quincy Third",
      "Quinn Quarter",
      "Quade Nostats",
    ]);
    await user.click(header());
    expect(header().closest("th")).toHaveAttribute("aria-sort", "none");
    expect(await drafts()).toEqual([
      "Quade Nostats",
      "Quentin Backup",
      "Quinn Quarter",
      "Quincy Third",
    ]);
  });

  it("the rank column toggles best-first and worst-first", async () => {
    room(statSnapshot());
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("Position"), "QB");
    await user.click(screen.getByRole("button", { name: /^Rank/ }));
    expect(await drafts()).toEqual([
      "Quincy Third",
      "Quinn Quarter",
      "Quentin Backup",
      "Quade Nostats",
    ]);
    await user.click(screen.getByRole("button", { name: /^Rank/ }));
    expect((await drafts())[0]).toBe("Quade Nostats");
  });

  it("drops a sort whose column the new position filter does not have", async () => {
    room(statSnapshot());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^Pass Yd/ }));
    expect(screen.getByRole("button", { name: /^Pass Yd/ })).toHaveTextContent("▼");
    await user.selectOptions(screen.getByLabelText("Position"), "K");
    expect(document.querySelector("[aria-sort='descending']")).toBeNull();
  });

  it("combines search, position, NFL team and hide-ineligible with a stat sort", async () => {
    const base = statSnapshot();
    room(
      statSnapshot({
        rosters: { ...base.rosters, t1: { ...base.rosters.t1!, QB: "x1" } }, // my QB slot is filled
      }),
    );
    const user = userEvent.setup();
    await screen.findByTestId("player-p2");
    expect(screen.queryByTestId("player-p1")).not.toBeInTheDocument(); // QBs ineligible
    await user.click(screen.getByLabelText("Hide ineligible"));
    await user.selectOptions(screen.getByLabelText("Position"), "QB");
    await user.selectOptions(screen.getByLabelText("NFL team"), "DDD");
    await user.click(screen.getByRole("button", { name: /^Pass Yd/ }));
    expect(await drafts()).toEqual(["Quincy Third", "Quentin Backup", "Quade Nostats"]);
    await user.type(screen.getByLabelText("Search players"), "quin");
    expect(await drafts()).toEqual(["Quincy Third"]);
    await user.click(screen.getByLabelText("Hide ineligible")); // back on: no QB fits
    expect(screen.getByTestId("players-empty")).toBeInTheDocument();
  });

  it("shows queue and draft actions per row", async () => {
    const saveQueue = vi.fn(async (_s: string, ids: string[]) => ({ playerIds: ids }));
    room(statSnapshot(), { saveQueue });
    const user = userEvent.setup();
    const row = await screen.findByTestId("player-p2");
    await user.click(within(row).getByRole("button", { name: "Add Rory Runner to queue" }));
    expect(saveQueue).toHaveBeenCalledWith("s2026", ["p2"]);
    expect(within(row).getByRole("button", { name: "Draft Rory Runner" })).toBeEnabled();
  });
});

describe("right pane and roster switching", () => {
  const pick = (n: number, teamId: string, playerId: string, name: string): SnapshotPick => ({
    overallPick: n,
    round: 1,
    teamId,
    playerId,
    slot: "QB",
    madeBy: "manager",
    madeAt: "2026-01-01T00:00:00.000Z",
    player: { name, position: "QB", nflTeam: "AAA" },
  });

  it("orders my queue, then drafted players oldest first (#pick, R, ABBR, player, pos, NFL team)", async () => {
    const picks = [pick(1, "t1", "x1", "First Guy"), pick(2, "t2", "x2", "Second Guy")];
    room(statSnapshot({ picks, currentPick: 8, onClockTeamId: "t8", myQueue: ["p2"] }));
    const right = await screen.findByTestId("col-right");
    expect(sections(right)).toEqual(["Queue", "Drafted players"]);
    expect(within(right).queryByTestId("on-the-clock")).not.toBeInTheDocument();
    expect(within(right).getByRole("list", { name: "My queue" })).toHaveTextContent("Rory Runner");
    const rows = within(within(right).getByRole("list", { name: "Picks" })).getAllByRole(
      "listitem",
    );
    expect(rows[1]).toHaveTextContent("#2");
    expect(rows[1]).toHaveTextContent("R1");
    expect(rows[1]).toHaveTextContent("PRAY");
    expect(rows[1]).not.toHaveTextContent("Pray Hard");
    expect(rows[1]).toHaveTextContent("Second Guy");
    expect(rows[1]).toHaveTextContent("QB");
    expect(rows[1]).toHaveTextContent("AAA");
    expect(rows[0]).toHaveTextContent("#1");
  });

  it("clicking a pick switches the left roster to that team", async () => {
    const picks = [pick(1, "t3", "x1", "First Guy")];
    room(statSnapshot({ picks, currentPick: 2, onClockTeamId: "t2" }));
    const user = userEvent.setup();
    const roster = await screen.findByTestId("roster");
    expect(within(roster).getByTestId("roster-owner")).toHaveTextContent("Your roster");
    await user.click(screen.getByRole("button", { name: /Show Blitz Club roster/ }));
    expect(within(roster).getByTestId("roster-owner")).toHaveTextContent("Blitz Club roster");
    expect(within(roster).getByRole("combobox", { name: "Team" })).toHaveValue("t3");
    await user.selectOptions(within(roster).getByRole("combobox", { name: "Team" }), "t1");
    expect(within(roster).getByTestId("roster-owner")).toHaveTextContent("Your roster");
  });

  it("a commissioner without a team starts on the on-clock team's roster", async () => {
    room(
      statSnapshot({ myTeamId: null, myRole: "commissioner", currentPick: 3, onClockTeamId: "t3" }),
      {},
      "commissioner",
    );
    const roster = await screen.findByTestId("roster");
    expect(within(roster).getByTestId("roster-owner")).toHaveTextContent("Blitz Club roster");
    expect(screen.getByText("Only teams have a queue.")).toBeInTheDocument();
  });

  it("puts the commissioner panel in a collapsible bar and keeps it working", async () => {
    room(statSnapshot({ myRole: "commissioner" }), {}, "commissioner");
    const bar = await screen.findByTestId("commissioner-bar");
    expect(bar.tagName).toBe("DETAILS");
    expect(bar).not.toHaveAttribute("open");
    expect(bar.nextElementSibling).toBe(screen.getByTestId("draft-columns"));
    // Strip, then the commissioner bar, then the columns.
    expect(bar.previousElementSibling).toBe(screen.getByTestId("otc-strip"));
  });
});

describe("player detail panel", () => {
  it("opens from the name with the full stat line, schedule and actions; Esc closes and returns focus", async () => {
    const saveQueue = vi.fn(async (_s: string, ids: string[]) => ({ playerIds: ids }));
    room(statSnapshot(), { saveQueue });
    const user = userEvent.setup();
    const opener = await screen.findByRole("button", { name: "Details for Wes Wideout" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: /Player details: Wes Wideout/ });
    expect(dialog).toHaveTextContent("BBB (#2 seed)");
    expect(dialog).toHaveTextContent("Wild Card vs CCC");
    expect(within(dialog).getByTestId("detail-info")).toHaveTextContent("#12");
    expect(within(dialog).getByTestId("detail-info")).toHaveTextContent("Healthy");
    expect(within(dialog).getByTestId("detail-stats")).toHaveTextContent("Tgt150");
    expect(within(dialog).getByTestId("detail-stats")).toHaveTextContent("Rec Yd1300");
    expect(within(dialog).getByRole("button", { name: "Close player details" })).toHaveFocus();

    await user.click(within(dialog).getByRole("button", { name: "★ Queue" }));
    expect(saveQueue).toHaveBeenCalledWith("s2026", ["p3"]);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("shows BYE for the top seed, injury status and '—' when there are no stats; close button works", async () => {
    room(statSnapshot());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Details for Tim Tightend" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByTestId("detail-stats")).toHaveTextContent("Tgt—");
    await user.click(within(dialog).getByRole("button", { name: "Close player details" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Details for Quinn Quarter" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("BYE");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Details for Rory Runner" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Q");
    expect(within(screen.getByRole("dialog")).getByTestId("detail-info")).toHaveTextContent(
      "Injury" + "Q",
    );
  });

  it("keeps Tab focus inside the panel", async () => {
    room(statSnapshot());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Details for Wes Wideout" }));
    const dialog = screen.getByRole("dialog");
    const buttons = within(dialog).getAllByRole("button");
    buttons[buttons.length - 1]!.focus();
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("Draft from the panel submits immediately; disabled when not my turn", async () => {
    const user = userEvent.setup();
    const { unmount } = room(statSnapshot());
    await user.click(await screen.findByRole("button", { name: "Details for Wes Wideout" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Draft" }));
    expect(screen.queryByRole("dialog", { name: "Confirm pick" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /Player details/ })).not.toBeInTheDocument();
    unmount();

    room(statSnapshot({ currentPick: 2, onClockTeamId: "t2" }));
    await user.click(await screen.findByRole("button", { name: "Details for Wes Wideout" }));
    expect(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Draft" }),
    ).toBeDisabled();
  });
});

describe("phone layout", () => {
  beforeEach(phone);

  it("shows the five tabs and one pane at a time", async () => {
    room(statSnapshot({ myQueue: ["p2"], picks: [] }));
    const user = userEvent.setup();
    const tabs = await screen.findByRole("tablist", { name: "Draft sections" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["Players", "Board", "Roster", "Queue", "Picks"]);
    expect(screen.queryByTestId("draft-columns")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Players ⇄ Board" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Players" })).toBeVisible();

    await user.click(screen.getByRole("tab", { name: "Board" }));
    expect(screen.getByTestId("board")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Players" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Roster" }));
    expect(screen.getByTestId("roster")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Queue" }));
    expect(screen.getByRole("list", { name: "My queue" })).toBeVisible();
    expect(screen.queryByTestId("on-the-clock")).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Picks" }));
    expect(screen.getByTestId("picks-empty")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Players" }));
    expect(screen.getByRole("region", { name: "Players" })).toBeVisible();
  });

  it("uses compact rows with headline stats and opens the detail sheet", async () => {
    room(statSnapshot());
    const user = userEvent.setup();
    const list = await screen.findByRole("list", { name: "Available players" });
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(within(list).getByTestId("player-p1")).toHaveTextContent("Pass Yd 4500");
    expect(within(list).getByTestId("player-p1")).toHaveTextContent("Pass TD 30");
    expect(within(list).getByTestId("player-p2")).toHaveTextContent("Rush Yd 1200");
    expect(within(list).getByTestId("player-p4")).toHaveTextContent("Rec —");
    await user.click(within(list).getByRole("button", { name: "Details for Rory Runner" }));
    expect(screen.getByRole("dialog", { name: /Player details/ })).toBeVisible();
  });

  it("clicking a pick jumps to the roster tab for that team", async () => {
    const picks: SnapshotPick[] = [
      {
        overallPick: 1,
        round: 1,
        teamId: "t2",
        playerId: "x1",
        slot: "QB",
        madeBy: "manager",
        madeAt: "2026-01-01T00:00:00.000Z",
        player: { name: "First Guy", position: "QB", nflTeam: "AAA" },
      },
    ];
    room(statSnapshot({ picks, currentPick: 2, onClockTeamId: "t2" }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Picks" }));
    await user.click(screen.getByRole("button", { name: /Show Pray Hard roster/ }));
    expect(screen.getByTestId("roster-owner")).toHaveTextContent("Pray Hard roster");
  });

  it("sorts by a stat through the phone sort control", async () => {
    room(statSnapshot());
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("Position"), "QB");
    await user.selectOptions(screen.getByLabelText("Sort by"), "pass_yd:desc");
    const names = screen
      .getAllByRole("button", { name: /^Draft / })
      .map((b) => b.getAttribute("aria-label"));
    expect(names[0]).toBe("Draft Quinn Quarter");
  });
});

describe("your-turn alert", () => {
  const snap = (over: Partial<DraftSnapshot>) => draftData({ myTeamId: "t9", ...over });
  const notMine = snap({ currentPick: 8, onClockTeamId: "t8" });
  const mine = snap({
    currentPick: 9,
    onClockTeamId: "t9",
    picks: [
      {
        overallPick: 8,
        round: 1,
        teamId: "t8",
        playerId: "x",
        slot: "QB",
        madeBy: "manager",
        madeAt: "2026-01-01T00:00:00.000Z",
        player: { name: "Someone", position: "QB", nflTeam: "AAA" },
      },
    ],
  });

  let focused = false;
  const vibrate = vi.fn();
  const beeps = vi.fn();
  beforeEach(() => {
    focused = false;
    document.title = "Draft & Pray";
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    vibrate.mockClear();
    beeps.mockClear();
    Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true });
    class FakeAudio {
      currentTime = 0;
      destination = {};
      constructor() {
        beeps();
      }
      createOscillator() {
        return { frequency: { value: 0 }, connect() {}, start() {}, stop() {}, type: "" };
      }
      createGain() {
        return { gain: { value: 0 }, connect() {} };
      }
      close() {}
    }
    vi.stubGlobal("AudioContext", FakeAudio);
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, "vibrate");
  });

  it("flashes the title when my team comes on the clock, until the window is focused", () => {
    const { rerender } = renderHook(({ s }) => useTurnAlert(s), { initialProps: { s: notMine } });
    expect(document.title).toBe("Draft & Pray");
    rerender({ s: mine });
    expect(document.title).toBe(ALERT_TITLE);
    expect(vibrate).toHaveBeenCalled();
    focused = true;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(document.title).toBe("Draft & Pray");
  });

  it("also stops when my turn ends", () => {
    const { rerender } = renderHook(({ s }) => useTurnAlert(s), { initialProps: { s: notMine } });
    rerender({ s: mine });
    expect(document.title).toBe(ALERT_TITLE);
    rerender({ s: snap({ currentPick: 10, onClockTeamId: "t9" }) }); // still mine: no change
    rerender({ s: notMine });
    expect(document.title).toBe("Draft & Pray");
  });

  it("does not alert on first load, or when the page already has focus", () => {
    const first = renderHook(() => useTurnAlert(mine));
    expect(document.title).toBe("Draft & Pray");
    expect(vibrate).not.toHaveBeenCalled();
    first.unmount();
    focused = true;
    const { rerender } = renderHook(({ s }) => useTurnAlert(s), { initialProps: { s: notMine } });
    rerender({ s: mine });
    expect(document.title).toBe("Draft & Pray");
  });

  it("never fires for the viewer's own pick", () => {
    const paused = snap({
      status: "paused",
      currentPick: 10,
      onClockTeamId: "t9",
      picks: [{ ...mine.picks[0]!, overallPick: 9, teamId: "t9" }],
    });
    const { rerender } = renderHook(({ s }) => useTurnAlert(s), { initialProps: { s: paused } });
    rerender({ s: { ...paused, status: "in_progress" } });
    expect(document.title).toBe("Draft & Pray");
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("does nothing for a commissioner without a team", () => {
    const { rerender } = renderHook(({ s }) => useTurnAlert(s), {
      initialProps: { s: { ...notMine, myTeamId: null } },
    });
    rerender({ s: { ...mine, myTeamId: null } });
    expect(document.title).toBe("Draft & Pray");
  });

  it("beeps only when the sound option is on (on by default), and remembers it", () => {
    const { result, rerender } = renderHook(({ s }) => useTurnAlert(s), {
      initialProps: { s: notMine },
    });
    expect(result.current.sound).toBe(true);
    rerender({ s: mine });
    expect(beeps).toHaveBeenCalledTimes(1);
    rerender({ s: notMine });

    act(() => result.current.setSound(false)); // muted: no beep, remembered
    expect(window.localStorage.getItem("dnp.draft.sound")).toBe("0");
    rerender({ s: mine });
    expect(beeps).toHaveBeenCalledTimes(1);
    rerender({ s: notMine });

    const again = renderHook(() => useTurnAlert(notMine));
    expect(again.result.current.sound).toBe(false);
    act(() => again.result.current.setSound(true)); // toggling on plays a sample beep
    expect(beeps).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem("dnp.draft.sound")).toBe("1");
  });

  it("survives unavailable storage and audio", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.stubGlobal("AudioContext", undefined);
    const { result } = renderHook(() => useTurnAlert(notMine));
    expect(result.current.sound).toBe(true);
    expect(() => act(() => result.current.setSound(true))).not.toThrow();
  });

  it("the draft room has a Sound on/off toggle, on by default, that persists", async () => {
    room(statSnapshot());
    const user = userEvent.setup();
    const box = await screen.findByRole("checkbox", { name: "Sound" });
    expect(box).toBeChecked();
    expect(screen.getByText("Sound on")).toBeInTheDocument();
    await user.click(box);
    expect(box).not.toBeChecked();
    expect(screen.getByText("Sound off")).toBeInTheDocument();
    await waitFor(() => expect(window.localStorage.getItem("dnp.draft.sound")).toBe("0"));
  });
});
