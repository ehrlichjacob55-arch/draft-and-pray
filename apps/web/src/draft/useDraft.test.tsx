import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiContext } from "../api";
import { draftData, fakeApi } from "../test/utils";
import { installMockWebSocket, MockWebSocket } from "../test/ws";
import { useDraft } from "./useDraft";

function setup(snapshots: ReturnType<typeof draftData>[]) {
  let i = 0;
  const draft = vi.fn(async () => snapshots[Math.min(i++, snapshots.length - 1)]!);
  const realtimeTicket = vi.fn(async () => ({ ticket: "t", wsUrl: "ws://x.test:1" }));
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiContext.Provider value={fakeApi({ draft, realtimeTicket })}>{children}</ApiContext.Provider>
  );
  const hook = renderHook(() => useDraft("s1"), { wrapper });
  return { ...hook, draft, realtimeTicket };
}

const flush = () => act(async () => vi.advanceTimersByTimeAsync(0));
const connect = async () => {
  await flush();
  act(() => {
    MockWebSocket.last().open();
    MockWebSocket.last().message({ type: "subscribed", channel: "draft:s1" });
  });
  await flush();
};

beforeEach(() => {
  vi.useFakeTimers();
  installMockWebSocket();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useDraft", () => {
  it("loads the snapshot, then refetches on connect", async () => {
    const { result, draft } = setup([draftData({ version: 1 }), draftData({ version: 2 })]);
    await flush();
    expect(result.current.status).toBe("ready");
    expect(result.current.snapshot?.version).toBe(1);
    await connect();
    expect(draft).toHaveBeenCalledTimes(2);
    expect(result.current.connection).toBe("connected");
    expect(result.current.snapshot?.version).toBe(2);
  });

  it("refetches only when an event's version is newer than the local one", async () => {
    const { result, draft } = setup([
      draftData({ version: 5 }),
      draftData({ version: 5 }),
      draftData({ version: 6, currentPick: 2 }),
    ]);
    await connect(); // initial fetch + refetch on subscribe
    expect(draft).toHaveBeenCalledTimes(2);

    act(() => MockWebSocket.last().message({ type: "draft_changed", version: 5, kind: "pick" }));
    await flush();
    act(() => MockWebSocket.last().message({ type: "draft_changed", version: 4, kind: "pick" }));
    await flush();
    expect(draft).toHaveBeenCalledTimes(2);

    act(() => MockWebSocket.last().message({ type: "draft_changed", version: 6, kind: "pick" }));
    await flush();
    expect(draft).toHaveBeenCalledTimes(3);
    expect(result.current.snapshot?.currentPick).toBe(2);
  });

  it("polls every 5 s while disconnected, and stops when connected", async () => {
    const { draft } = setup([draftData()]);
    await flush();
    expect(draft).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(draft).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(draft).toHaveBeenCalledTimes(3);

    await connect(); // +1 refetch on subscribe
    const after = draft.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(draft).toHaveBeenCalledTimes(after);

    // Socket drops: polling resumes.
    act(() => MockWebSocket.last().drop());
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(draft.mock.calls.length).toBeGreaterThan(after);
  });

  it("counts the clock down using the server's time, and flags expiry", async () => {
    vi.setSystemTime(new Date("2030-06-01T12:00:00.000Z")); // client clock far from the server's
    const clock = {
      startedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:01:30.000Z",
      seconds: 90,
      expired: false,
    };
    const { result } = setup([draftData({ clock, serverNow: "2026-01-01T00:00:00.000Z" })]);
    await connect(); // connected: no polling, so the baseline stays put
    expect(result.current.clockRemaining).toBe(90_000);
    expect(result.current.clockExpired).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(result.current.clockRemaining).toBe(60_000);
    await act(async () => vi.advanceTimersByTimeAsync(61_000));
    expect(result.current.clockExpired).toBe(true);
  });

  it("is expired when the server says so", async () => {
    const clock = {
      startedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:01:30.000Z",
      seconds: 90,
      expired: true,
    };
    const { result } = setup([draftData({ clock, serverNow: "2026-01-01T00:01:31.000Z" })]);
    await flush();
    expect(result.current.clockExpired).toBe(true);
    expect(result.current.clockRemaining).toBeLessThan(0);
  });
});
