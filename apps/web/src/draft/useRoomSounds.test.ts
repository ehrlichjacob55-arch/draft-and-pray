import type { DraftSnapshot } from "@dnp/contract";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { draftData } from "../test/utils";
import { isDraftStart, useRoomSounds } from "./useRoomSounds";

const players = { chime: vi.fn(), fanfare: vi.fn(), alarm: vi.fn() };
beforeEach(() => {
  players.chime.mockClear();
  players.fanfare.mockClear();
  players.alarm.mockClear();
});

const snap = (over: Partial<DraftSnapshot> = {}): DraftSnapshot => ({ ...draftData(), ...over });
const somePick = {
  overallPick: 1,
  round: 1,
  teamId: "t1",
  playerId: "x",
  slot: "QB",
  madeBy: "manager",
  madeAt: "2026-01-01T00:00:00.000Z",
  player: { name: "Someone", position: "QB", nflTeam: "AAA" },
} as DraftSnapshot["picks"][number];
const clockOf = (n: number) => ({
  startedAt: `2026-01-01T00:00:0${n}.000Z`,
  expiresAt: `2026-01-01T00:01:0${n}.000Z`,
  seconds: 60,
  expired: false,
});

type Props = { s: DraftSnapshot; expired: boolean; on: boolean };
const setup = (initial: Props) =>
  renderHook((p: Props) => useRoomSounds(p.s, p.expired, p.on, players), {
    initialProps: initial,
  });

describe("useRoomSounds", () => {
  it("chimes once on entering the room, and not when muted", () => {
    const a = setup({ s: snap(), expired: false, on: true });
    expect(players.chime).toHaveBeenCalledTimes(1);
    a.rerender({ s: snap({ version: 9 }), expired: false, on: true });
    expect(players.chime).toHaveBeenCalledTimes(1);
    players.chime.mockClear();
    setup({ s: snap(), expired: false, on: false });
    expect(players.chime).not.toHaveBeenCalled();
  });

  it("fanfare only on the transition into in_progress, never on first load", () => {
    const loaded = setup({ s: snap({ status: "in_progress" }), expired: false, on: true });
    expect(players.fanfare).not.toHaveBeenCalled();
    loaded.rerender({
      s: snap({ status: "paused", currentPick: 5, picks: [somePick] }),
      expired: false,
      on: true,
    });
    loaded.rerender({
      s: snap({ status: "in_progress", currentPick: 5, picks: [somePick] }),
      expired: false,
      on: true,
    });
    expect(players.fanfare).not.toHaveBeenCalled(); // resume mid-draft is not a start

    const lobby = setup({ s: snap({ status: "scheduled" }), expired: false, on: true });
    lobby.rerender({ s: snap({ status: "in_progress" }), expired: false, on: true });
    expect(players.fanfare).toHaveBeenCalledTimes(1);
  });

  it("is silent when muted but keeps tracking (no replay on unmute)", () => {
    const h = setup({ s: snap({ status: "scheduled" }), expired: false, on: false });
    h.rerender({
      s: snap({ status: "in_progress", clock: clockOf(1) }),
      expired: false,
      on: false,
    });
    h.rerender({ s: snap({ status: "in_progress", clock: clockOf(1) }), expired: true, on: false });
    h.rerender({ s: snap({ status: "in_progress", clock: clockOf(1) }), expired: true, on: true });
    expect(players.chime).not.toHaveBeenCalled();
    expect(players.fanfare).not.toHaveBeenCalled();
    expect(players.alarm).not.toHaveBeenCalled();
  });

  it("alarms once per clock when it expires while here", () => {
    const s = snap({ status: "in_progress", clock: clockOf(1) });
    const h = setup({ s, expired: false, on: true });
    h.rerender({ s, expired: true, on: true });
    h.rerender({ s, expired: true, on: true });
    expect(players.alarm).toHaveBeenCalledTimes(1);
    // A new clock (next pick) alarms again.
    const s2 = snap({ status: "in_progress", clock: clockOf(2) });
    h.rerender({ s: s2, expired: false, on: true });
    h.rerender({ s: s2, expired: true, on: true });
    expect(players.alarm).toHaveBeenCalledTimes(2);
  });

  it("does not alarm for a clock that was already expired on arrival, or without a clock", () => {
    const s = snap({ status: "in_progress", clock: clockOf(1) });
    const h = setup({ s, expired: true, on: true });
    h.rerender({ s: { ...s, version: 3 }, expired: true, on: true });
    expect(players.alarm).not.toHaveBeenCalled();
    h.rerender({ s: snap({ status: "in_progress", clock: null }), expired: false, on: true });
    h.rerender({ s: snap({ status: "in_progress", clock: null }), expired: true, on: true });
    expect(players.alarm).not.toHaveBeenCalled();
  });
});

describe("isDraftStart", () => {
  it("covers scheduled, lobby and paused-before-the-first-pick", () => {
    const run = snap({ status: "in_progress" });
    expect(isDraftStart(snap({ status: "scheduled" }), run)).toBe(true);
    expect(isDraftStart(snap({ status: "lobby" }), run)).toBe(true);
    expect(isDraftStart(snap({ status: "paused", picks: [] }), run)).toBe(true);
    expect(isDraftStart(snap({ status: "in_progress" }), run)).toBe(false);
    expect(isDraftStart(snap({ status: "scheduled" }), snap({ status: "paused" }))).toBe(false);
  });
});
