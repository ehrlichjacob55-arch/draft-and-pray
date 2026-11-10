import type { Api } from "../api";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { draftData, meMember, renderRoute } from "../test/utils";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function room(snap: ReturnType<typeof draftData>, api: Partial<Api> = {}) {
  const draft = vi.fn(async () => snap);
  return renderRoute("/draft", { api: { me: async () => meMember("manager"), draft, ...api } });
}

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

const clock = {
  startedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-01T00:01:30.000Z",
  seconds: 90,
  expired: false,
};

describe("on-the-clock strip", () => {
  it("shows the current pick and the next 8, with a round divider at the boundary", async () => {
    // Pick 7 (round 1, t7) .. pick 15: picks 10+ are round 2 (snake: t9, t8, t7, t6, t5, t4).
    room(draftData({ currentPick: 7, round: 1, onClockTeamId: "t7", myTeamId: "t2" }));
    const strip = await screen.findByTestId("otc-strip");
    const items = within(strip).getAllByRole("listitem");
    // 9 boxes (the divider is a separator, not a list item)
    expect(items).toHaveLength(9);
    const current = within(strip).getByTestId("otc-current");
    expect(current).toHaveTextContent("#7");
    expect(current).toHaveTextContent("SACK");
    expect(current).toHaveTextContent("Sack Attack");
    expect(within(strip).getByTestId("otc-next-8")).toHaveTextContent(/#8\s*TRIC/);
    expect(within(strip).getByTestId("otc-next-9")).toHaveTextContent(/#9\s*LONG/);
    expect(within(strip).getByTestId("otc-next-10")).toHaveTextContent(/#10\s*LONG/);
    expect(within(strip).getByTestId("otc-next-15")).toHaveTextContent(/#15\s*HAIL/);
    expect(within(strip).queryByTestId("otc-next-16")).not.toBeInTheDocument();
    const dividers = within(strip).getAllByTestId("otc-round-divider");
    expect(dividers).toHaveLength(1);
    expect(dividers[0]).toHaveTextContent("R2");
    // The divider sits between pick 9 and pick 10.
    expect(dividers[0]!.previousElementSibling).toBe(within(strip).getByTestId("otc-next-9"));
    expect(dividers[0]!.nextElementSibling).toBe(within(strip).getByTestId("otc-next-10"));
  });

  it("has no divider within a round and stops after pick 90", async () => {
    const { unmount } = room(draftData({ currentPick: 1, onClockTeamId: "t1" }));
    expect(
      within(await screen.findByTestId("otc-strip")).queryByTestId("otc-round-divider"),
    ).toBeNull();
    unmount();
    // Last picks of the draft: fewer than 9 boxes.
    room(draftData({ currentPick: 88, round: 10, onClockTeamId: "t3" }));
    expect(within(await screen.findByTestId("otc-strip")).getAllByRole("listitem")).toHaveLength(3);
  });

  it("marks my picks, including 'You' on the current box", async () => {
    // I am t1: pick 1 (current), and pick 18 is out of range; use t9 as me for 2 boxes in range.
    room(draftData({ currentPick: 7, onClockTeamId: "t7", myTeamId: "t9" }));
    const strip = await screen.findByTestId("otc-strip");
    expect(within(strip).getByTestId("otc-mine-9")).toHaveTextContent("You");
    expect(within(strip).getByTestId("otc-mine-10")).toHaveTextContent("You");
    expect(within(strip).queryByTestId("otc-mine-8")).not.toBeInTheDocument();
    expect(within(strip).queryByTestId("otc-mine-current")).not.toBeInTheDocument();
  });

  it("current box says You when it is my turn", async () => {
    room(draftData({ currentPick: 1, onClockTeamId: "t1", myTeamId: "t1" }));
    const current = await screen.findByTestId("otc-current");
    expect(within(current).getByTestId("otc-mine-current")).toHaveTextContent("You");
  });

  it("shows the countdown in box 1, then 'Time expired'", async () => {
    const { unmount } = room(draftData({ clock, serverNow: "2026-01-01T00:00:00.000Z" }));
    expect(
      await within(await screen.findByTestId("otc-current")).findByTestId("otc-clock"),
    ).toHaveTextContent(/^1:(30|29)$/);
    unmount();
    room(draftData({ clock: { ...clock, expired: true }, serverNow: "2026-01-01T00:01:31.000Z" }));
    const expired = await screen.findByTestId("otc-clock");
    expect(expired).toHaveTextContent("Time expired");
    expect(expired).toHaveClass("text-error");
  });

  it("shows Paused instead of a countdown while paused", async () => {
    room(draftData({ status: "paused", clock: null }));
    expect(await screen.findByTestId("otc-current")).toHaveTextContent("Paused");
  });

  it("clicking a box switches the left roster to that team", async () => {
    room(draftData({ currentPick: 3, onClockTeamId: "t3" }));
    const user = userEvent.setup();
    const roster = await screen.findByTestId("roster");
    expect(within(roster).getByTestId("roster-owner")).toHaveTextContent("Your roster");
    await user.click(within(screen.getByTestId("otc-next-5")).getByRole("button"));
    expect(within(roster).getByTestId("roster-owner")).toHaveTextContent("Red Zone roster");
    await user.click(within(screen.getByTestId("otc-current")).getByRole("button"));
    expect(within(roster).getByTestId("roster-owner")).toHaveTextContent("Blitz Club roster");
  });

  it("is not shown in the lobby or when complete", async () => {
    const { unmount } = room(
      draftData({ status: "scheduled", round: null, order: [], onClockTeamId: null }),
    );
    await screen.findByText(/Draft room/);
    await screen.findByTestId("lobby").catch(() => undefined);
    expect(screen.queryByTestId("otc-strip")).not.toBeInTheDocument();
    unmount();
    room(draftData({ status: "complete", currentPick: 91, round: null, onClockTeamId: null }));
    await screen.findByTestId("draft-complete");
    expect(screen.queryByTestId("otc-strip")).not.toBeInTheDocument();
  });

  it("on phone, a box click jumps to the roster tab", async () => {
    phone();
    room(draftData({ currentPick: 3, onClockTeamId: "t3" }));
    const user = userEvent.setup();
    await user.click(within(await screen.findByTestId("otc-next-4")).getByRole("button"));
    expect(screen.getByTestId("roster-owner")).toHaveTextContent("Hail Marys roster");
    // Current first, scrolling container.
    const list = within(screen.getByTestId("otc-strip")).getByRole("list");
    expect(list).toHaveClass("overflow-x-auto");
    expect(within(list).getAllByRole("listitem")[0]).toBe(screen.getByTestId("otc-current"));
  });
});

describe("board headers", () => {
  it("show ABBR with the full name as a tooltip and for screen readers", async () => {
    room(draftData());
    await userEvent.setup().click(await screen.findByRole("button", { name: /Players ⇄ Board/ }));
    const board = await screen.findByTestId("board");
    const heads = within(board).getAllByRole("columnheader");
    expect(heads).toHaveLength(10);
    const head = heads[2]!; // Rd, t1, t2
    expect(head).toHaveTextContent("PRAY");
    expect(within(head).getByText("PRAY")).toHaveAttribute("aria-hidden", "true");
    expect(within(head).getByText("Pray Hard")).toHaveClass("sr-only");
    expect(head.querySelector("[title]")).toHaveAttribute("title", "Pray Hard");
    expect(within(board).getByRole("columnheader", { name: "Pray Hard" })).toBe(head);
  });
});
