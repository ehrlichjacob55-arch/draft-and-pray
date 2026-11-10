/**
 * Local development realtime (docs/design/14 §6): the same ticket + subscribe + broadcast protocol
 * as the AWS WebSocket API, served by the `ws` package on its own port. Handshakes without a
 * valid single-use ticket are rejected with 401, like `ws-connect` does in AWS.
 */
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { wsClientMessage, type DraftChangedEvent, type WsServerMessage } from "@dnp/contract";
import { consumeWsTicket, type Dynamo } from "@dnp/db";
import { WebSocketServer, type WebSocket } from "ws";
import { logError } from "../redact";
import { canSubscribe } from "./channels";
import type { Publisher } from "./types";

export interface LocalRealtime extends Publisher {
  readonly port: number;
  close(): Promise<void>;
}

export function startLocalRealtime(opts: {
  db: Dynamo;
  port: number;
  now?: () => Date;
}): Promise<LocalRealtime> {
  const { db } = opts;
  const clock = opts.now ?? (() => new Date());
  const users = new WeakMap<IncomingMessage, string>();
  const channels = new Map<string, Set<WebSocket>>();

  const wss = new WebSocketServer({
    port: opts.port,
    verifyClient: (info, done) => {
      const ticket = new URL(info.req.url ?? "/", "http://localhost").searchParams.get("ticket");
      if (!ticket) return done(false, 401, "Unauthorized");
      consumeWsTicket(db, ticket, clock())
        .then((userId) => {
          if (!userId) return done(false, 401, "Unauthorized");
          users.set(info.req, userId);
          done(true);
        })
        .catch(() => done(false, 500, "Error"));
    },
  });

  const send = (ws: WebSocket, msg: WsServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  wss.on("connection", (ws, req) => {
    const userId = users.get(req) as string;
    const mine = new Set<string>();
    ws.on("message", (data) => {
      void (async () => {
        let msg;
        try {
          msg = wsClientMessage.parse(JSON.parse(String(data)));
        } catch {
          return send(ws, { type: "error", code: "bad_request" });
        }
        if (msg.action === "unsubscribe") {
          channels.get(msg.channel)?.delete(ws);
          mine.delete(msg.channel);
          return send(ws, { type: "unsubscribed", channel: msg.channel });
        }
        try {
          if (!(await canSubscribe(db, userId, msg.channel)))
            return send(ws, { type: "error", code: "forbidden" });
        } catch (err) {
          logError("Subscribe check failed", err);
          return send(ws, { type: "error", code: "forbidden" });
        }
        const set = channels.get(msg.channel) ?? new Set<WebSocket>();
        set.add(ws);
        channels.set(msg.channel, set);
        mine.add(msg.channel);
        send(ws, { type: "subscribed", channel: msg.channel });
      })();
    });
    ws.on("close", () => {
      for (const ch of mine) channels.get(ch)?.delete(ws);
    });
  });

  return new Promise((resolve, reject) => {
    wss.once("error", reject);
    wss.once("listening", () =>
      resolve({
        port: (wss.address() as AddressInfo).port,
        async publish(channel: string, event: DraftChangedEvent) {
          for (const ws of channels.get(channel) ?? []) send(ws, event);
        },
        close: () =>
          new Promise<void>((res) => {
            for (const c of wss.clients) c.terminate();
            wss.close(() => res());
          }),
      }),
    );
  });
}
