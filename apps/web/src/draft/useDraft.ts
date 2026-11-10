import type { DraftChangedEvent, DraftSnapshot } from "@dnp/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../api";
import { useDraftChannel, type ConnectionStatus } from "../realtime/useDraftChannel";
import { clockRemainingMs } from "./clock";

export const POLL_MS = 5000;

export interface DraftData {
  status: "loading" | "error" | "ready";
  snapshot: DraftSnapshot | null;
  error: unknown;
  connection: ConnectionStatus;
  refetch: () => Promise<void>;
  /** Pick clock ms remaining (skew-corrected), null when no clock is running. */
  clockRemaining: number | null;
  clockExpired: boolean;
}

/**
 * Draft snapshot + realtime. Refetches when an event's version is newer than ours and on every
 * (re)connect; polls every 5 s while the socket is not connected.
 */
export function useDraft(seasonId: string): DraftData {
  const api = useApi();
  const [state, setState] = useState<{
    snapshot: DraftSnapshot | null;
    receivedAt: number;
    error: unknown;
  }>({ snapshot: null, receivedAt: 0, error: null });
  const versionRef = useRef(-1);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refetch = useCallback(async () => {
    try {
      const snapshot = await api.draft(seasonId);
      if (!aliveRef.current || snapshot.version < versionRef.current) return;
      versionRef.current = snapshot.version;
      setState({ snapshot, receivedAt: Date.now(), error: null });
    } catch (error) {
      if (aliveRef.current) setState((prev) => ({ ...prev, error }));
    }
  }, [api, seasonId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const connection = useDraftChannel(seasonId, {
    onEvent: (e: DraftChangedEvent) => {
      if (e.version > versionRef.current) void refetch();
    },
    onConnected: () => void refetch(),
  });

  useEffect(() => {
    if (connection === "connected") return;
    const id = setInterval(() => void refetch(), POLL_MS);
    return () => clearInterval(id);
  }, [connection, refetch]);

  // Ticking "now" only while a clock is running.
  const clock = state.snapshot?.clock ?? null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!clock) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [clock]);

  const { snapshot } = state;
  const clockRemaining =
    snapshot && clock
      ? clockRemainingMs(
          clock.expiresAt,
          snapshot.serverNow,
          state.receivedAt,
          Math.max(now, state.receivedAt),
        )
      : null;
  return {
    status: snapshot ? "ready" : state.error ? "error" : "loading",
    snapshot,
    error: state.error,
    connection,
    refetch,
    clockRemaining,
    clockExpired: !!clock && (clock.expired || (clockRemaining ?? 1) <= 0),
  };
}
