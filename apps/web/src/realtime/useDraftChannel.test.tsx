import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiContext } from "../api";
import { fakeApi } from "../test/utils";
import { installMockWebSocket, MockWebSocket } from "../test/ws";
import { reconnectDelay, useDraftChannel } from "./useDraftChannel";

function setup(realtimeTicket = vi.fn(async () => ({ ticket: "tkt/1", wsUrl: "ws://x.test:1" }))) {
  const handlers = { onEvent: vi.fn(), onConnected: vi.fn() };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiContext.Provider value={fakeApi({ realtimeTicket })}>{children}</ApiContext.Provider>
  );
  const hook = renderHook(() => useDraftChannel("s1", handlers), { wrapper });
  return { ...hook, handlers, realtimeTicket };
}

const flush = () => act(async () => vi.advanceTimersByTimeAsync(0));

beforeEach(() => {
  vi.useFakeTimers();
  installMockWebSocket();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useDraftChannel", () => {
  it("gets a ticket, connects with it, subscribes, and reports connected", async () => {
    const log = vi.spyOn(console, "log");
    const { result, handlers, realtimeTicket } = setup();
    expect(result.current).toBe("connecting");
    await flush();
    expect(realtimeTicket).toHaveBeenCalledTimes(1);
    const ws = MockWebSocket.last();
    expect(ws.url).toBe("ws://x.test:1?ticket=tkt%2F1");

    act(() => ws.open());
    expect(JSON.parse(ws.sent[0]!)).toEqual({ action: "subscribe", channel: "draft:s1" });
    expect(result.current).toBe("connecting");

    act(() => ws.message({ type: "subscribed", channel: "draft:s1" }));
    expect(result.current).toBe("connected");
    expect(handlers.onConnected).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it("forwards draft_changed events and ignores junk", async () => {
    const { handlers } = setup();
    await flush();
    const ws = MockWebSocket.last();
    act(() => {
      ws.open();
      ws.message({ type: "draft_changed", version: 7, kind: "pick" });
      ws.onmessage?.({ data: "not json" });
      ws.message({ type: "nonsense" });
    });
    expect(handlers.onEvent).toHaveBeenCalledTimes(1);
    expect(handlers.onEvent).toHaveBeenCalledWith({
      type: "draft_changed",
      version: 7,
      kind: "pick",
    });
  });

  it("reconnects with exponential backoff and a fresh ticket each time", async () => {
    const { result, realtimeTicket } = setup();
    await flush();
    act(() => {
      MockWebSocket.last().open();
      MockWebSocket.last().message({ type: "subscribed", channel: "draft:s1" });
    });
    act(() => MockWebSocket.last().drop());
    expect(result.current).toBe("disconnected");

    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(realtimeTicket).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(realtimeTicket).toHaveBeenCalledTimes(2);
    expect(MockWebSocket.instances).toHaveLength(2);

    // A second drop before a successful subscribe doubles the delay.
    act(() => MockWebSocket.last().drop());
    await act(async () => vi.advanceTimersByTimeAsync(1999));
    expect(realtimeTicket).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(realtimeTicket).toHaveBeenCalledTimes(3);

    act(() => MockWebSocket.last().message({ type: "subscribed", channel: "draft:s1" }));
    expect(result.current).toBe("connected");
  });

  it("retries when the ticket request fails", async () => {
    const realtimeTicket = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue({ ticket: "t", wsUrl: "ws://x.test:1" });
    const { result } = setup(realtimeTicket);
    await flush();
    expect(result.current).toBe("disconnected");
    expect(MockWebSocket.instances).toHaveLength(0);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("closes the socket on unmount and does not reconnect", async () => {
    const { unmount, realtimeTicket } = setup();
    await flush();
    const ws = MockWebSocket.last();
    unmount();
    expect(ws.closed).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(realtimeTicket).toHaveBeenCalledTimes(1);
  });

  it("caps the backoff at 30 s", () => {
    expect(reconnectDelay(0)).toBe(1000);
    expect(reconnectDelay(3)).toBe(8000);
    expect(reconnectDelay(10)).toBe(30_000);
  });
});
