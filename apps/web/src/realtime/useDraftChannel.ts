import { draftChannel, wsServerMessage, type DraftChangedEvent } from "@dnp/contract";
import { useEffect, useRef, useState } from "react";
import { useApi } from "../api";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface DraftChannelHandlers {
  /** A `draft_changed` event arrived. */
  onEvent: (event: DraftChangedEvent) => void;
  /** The subscription was (re)confirmed: refetch, since events may have been missed. */
  onConnected: () => void;
}

export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;

export function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
}

/**
 * Subscribes to `draft:<seasonId>` over the ticketed WebSocket (docs/design/14 §6). Each (re)connect
 * fetches a fresh single-use ticket; the ticket is never logged or kept. Reconnects with exponential
 * backoff. Returns the connection status.
 */
export function useDraftChannel(
  seasonId: string | null,
  handlers: DraftChannelHandlers,
): ConnectionStatus {
  const api = useApi();
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!seasonId) return;
    const channel = draftChannel(seasonId);
    let cancelled = false;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const scheduleReconnect = () => {
      if (cancelled) return;
      setStatus("disconnected");
      const delay = reconnectDelay(attempt);
      attempt += 1;
      timer = setTimeout(() => void connect(), delay);
    };

    async function connect() {
      if (cancelled) return;
      let ticket: { ticket: string; wsUrl: string };
      try {
        ticket = await api.realtimeTicket();
      } catch {
        scheduleReconnect();
        return;
      }
      if (cancelled) return;
      const sep = ticket.wsUrl.includes("?") ? "&" : "?";
      let ws: WebSocket;
      try {
        ws = new WebSocket(`${ticket.wsUrl}${sep}ticket=${encodeURIComponent(ticket.ticket)}`);
      } catch {
        scheduleReconnect();
        return;
      }
      socket = ws;
      ws.onopen = () => ws.send(JSON.stringify({ action: "subscribe", channel }));
      ws.onmessage = (ev: MessageEvent) => {
        let raw: unknown;
        try {
          raw = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        const msg = wsServerMessage.safeParse(raw);
        if (!msg.success) return;
        switch (msg.data.type) {
          case "subscribed":
            attempt = 0;
            setStatus("connected");
            handlersRef.current.onConnected();
            break;
          case "draft_changed":
            handlersRef.current.onEvent(msg.data);
            break;
          case "error":
            // forbidden / bad_request: drop the socket; the backoff reconnect (and polling) take over.
            ws.close();
            break;
          default:
            break;
        }
      };
      ws.onclose = () => {
        if (socket !== ws) return;
        socket = null;
        scheduleReconnect();
      };
    }

    void connect();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (socket) {
        socket.onclose = null;
        socket.close();
        socket = null;
      }
    };
  }, [api, seasonId]);

  return status;
}
