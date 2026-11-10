import {
  PostToConnectionCommand,
  ApiGatewayManagementApiClient,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { wsServerMessage, type WsServerMessage } from "@dnp/contract";
import {
  bootstrapLeague,
  consumeWsTicket,
  createWsTicket,
  localSub,
  putIfAbsent,
  leagueMemberKey,
  wsTicketKey,
  type Dynamo,
} from "@dnp/db";
import { createTestDynamo, testEndpoint } from "@dnp/db/testing";
import { createHash } from "node:crypto";
import { canSubscribe } from "./channels";
import { startLocalRealtime, type LocalRealtime } from "./local-hub";

let db: Dynamo;
let wsDb: Dynamo;
vi.mock("./connections", async (orig) => {
  const real = await orig<Record<string, unknown>>();
  return { ...real, getDocClient: () => wsDb.doc, tableName: () => wsDb.tableName };
});

const apigw = mockClient(ApiGatewayManagementApiClient);

let seasonId: string;
let leagueId: string;
const member = "member@local.test";
const stranger = "stranger@local.test";

beforeAll(async () => {
  db = await createTestDynamo("rt-app");
  wsDb = await createTestDynamo("rt-ws");
  const commish = "boss@local.test";
  const r = await bootstrapLeague(db, {
    userId: localSub(commish),
    email: commish,
    leagueName: "RT League",
    year: 2026,
  });
  seasonId = r.seasonId;
  leagueId = r.leagueId;
  await putIfAbsent(db, {
    ...leagueMemberKey(leagueId, localSub(member)),
    type: "LeagueMember",
    leagueId,
    userId: localSub(member),
    role: "manager",
  });
  process.env.APP_TABLE = db.tableName;
  process.env.DYNAMODB_ENDPOINT = testEndpoint();
  process.env.AWS_REGION = "us-east-1";
});

describe("tickets", () => {
  it("are single use, stored hashed, and expire after 60 s", async () => {
    const ticket = await createWsTicket(db, { userId: "u1" });
    const hash = createHash("sha256").update(ticket).digest("hex");
    const stored = await db.doc.send(
      new GetCommand({ TableName: db.tableName, Key: wsTicketKey(hash), ConsistentRead: true }),
    );
    expect(stored.Item?.userId).toBe("u1");
    expect(JSON.stringify(stored.Item)).not.toContain(ticket);
    expect(await consumeWsTicket(db, ticket)).toBe("u1");
    expect(await consumeWsTicket(db, ticket)).toBeUndefined();

    const t0 = new Date("2026-01-01T00:00:00Z");
    const t2 = await createWsTicket(db, { userId: "u2", now: t0 });
    expect(await consumeWsTicket(db, t2, new Date(t0.getTime() + 61_000))).toBeUndefined();
    const t3 = await createWsTicket(db, { userId: "u3", now: t0 });
    expect(await consumeWsTicket(db, t3, new Date(t0.getTime() + 59_000))).toBe("u3");
    expect(await consumeWsTicket(db, "short")).toBeUndefined();
  });
});

describe("channel authorization", () => {
  it("requires membership of the season's league", async () => {
    expect(await canSubscribe(db, localSub(member), `draft:${seasonId}`)).toBe(true);
    expect(await canSubscribe(db, localSub(stranger), `draft:${seasonId}`)).toBe(false);
    expect(await canSubscribe(db, localSub(member), "draft:no-such-season")).toBe(false);
    expect(await canSubscribe(db, localSub(member), "other:thing")).toBe(false);
  });
});

describe("ws-connect and ws-default handlers", () => {
  it("rejects connects without a valid ticket and stores the owner for a valid one", async () => {
    const { handler } = await import("../handlers/ws-connect");
    const ev = (q?: Record<string, string>) =>
      ({ requestContext: { connectionId: "c1" }, queryStringParameters: q }) as never;
    expect((await handler(ev())) as { statusCode: number }).toMatchObject({ statusCode: 401 });
    expect(await handler(ev({ ticket: "x".repeat(43) }))).toMatchObject({ statusCode: 401 });
    const ticket = await createWsTicket(db, { userId: localSub(member) });
    expect(await handler(ev({ ticket }))).toMatchObject({ statusCode: 200 });
    expect(await handler(ev({ ticket }))).toMatchObject({ statusCode: 401 });
    const conn = await wsDb.doc.send(
      new GetCommand({ TableName: wsDb.tableName, Key: { pk: "conn#c1", sk: "meta" } }),
    );
    expect(conn.Item?.userId).toBe(localSub(member));
  });

  it("ws-default checks membership on subscribe and acks", async () => {
    const { handler } = await import("../handlers/ws-default");
    apigw.reset();
    apigw.on(PostToConnectionCommand).resolves({});
    const msg = (connectionId: string, channel: string) =>
      ({
        body: JSON.stringify({ action: "subscribe", channel }),
        requestContext: { connectionId, domainName: "x.execute-api.test", stage: "live" },
      }) as never;
    const sent = () =>
      apigw
        .commandCalls(PostToConnectionCommand)
        .map((c) => JSON.parse(new TextDecoder().decode(c.args[0].input.Data as Uint8Array)));

    // c1 belongs to `member` (stored by the connect test above).
    expect(await handler(msg("c1", `draft:${seasonId}`))).toMatchObject({ statusCode: 200 });
    expect(sent().at(-1)).toEqual({ type: "subscribed", channel: `draft:${seasonId}` });
    const sub = await wsDb.doc.send(
      new GetCommand({
        TableName: wsDb.tableName,
        Key: { pk: `chan#draft:${seasonId}`, sk: "conn#c1" },
      }),
    );
    expect(sub.Item).toBeDefined();

    // A connection owned by a non-member is refused and not stored.
    await wsDb.doc.send(
      new (await import("@aws-sdk/lib-dynamodb")).PutCommand({
        TableName: wsDb.tableName,
        Item: { pk: "conn#c2", sk: "meta", userId: localSub(stranger) },
      }),
    );
    expect(await handler(msg("c2", `draft:${seasonId}`))).toMatchObject({ statusCode: 403 });
    expect(sent().at(-1)).toEqual({ type: "error", code: "forbidden" });
    const none = await wsDb.doc.send(
      new GetCommand({
        TableName: wsDb.tableName,
        Key: { pk: `chan#draft:${seasonId}`, sk: "conn#c2" },
      }),
    );
    expect(none.Item).toBeUndefined();
    expect(
      await handler({ body: "nope", requestContext: { connectionId: "c1" } } as never),
    ).toMatchObject({
      statusCode: 400,
    });
  });
});

describe("local WebSocket server", () => {
  let hub: LocalRealtime;
  beforeAll(async () => {
    hub = await startLocalRealtime({ db, port: 0 });
  });
  afterAll(async () => {
    await hub.close();
  });

  const open = (ticket?: string) =>
    new Promise<{ ws: WebSocket; messages: WsServerMessage[] } | number>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${hub.port}${ticket ? `?ticket=${ticket}` : ""}`);
      const messages: WsServerMessage[] = [];
      ws.on("message", (d) => messages.push(wsServerMessage.parse(JSON.parse(String(d)))));
      ws.on("open", () => resolve({ ws, messages }));
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("error", () => undefined);
    });
  const until = async (fn: () => boolean) => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(fn()).toBe(true);
  };

  it("rejects a missing, bogus or reused ticket with 401", async () => {
    expect(await open()).toBe(401);
    expect(await open("x".repeat(43))).toBe(401);
    const t = await createWsTicket(db, { userId: localSub(member) });
    const ok = await open(t);
    expect(typeof ok).toBe("object");
    (ok as { ws: WebSocket }).ws.close();
    expect(await open(t)).toBe(401);
  });

  it("subscribes members, refuses strangers, and fans out draft_changed", async () => {
    const mem = (await open(await createWsTicket(db, { userId: localSub(member) }))) as {
      ws: WebSocket;
      messages: WsServerMessage[];
    };
    const out = (await open(await createWsTicket(db, { userId: localSub(stranger) }))) as {
      ws: WebSocket;
      messages: WsServerMessage[];
    };
    const channel = `draft:${seasonId}`;
    mem.ws.send(JSON.stringify({ action: "subscribe", channel }));
    out.ws.send(JSON.stringify({ action: "subscribe", channel }));
    out.ws.send("garbage");
    await until(() => mem.messages.length === 1 && out.messages.length === 2);
    expect(mem.messages[0]).toEqual({ type: "subscribed", channel });
    expect(out.messages).toEqual(
      expect.arrayContaining([
        { type: "error", code: "forbidden" },
        { type: "error", code: "bad_request" },
      ]),
    );

    await hub.publish(channel, { type: "draft_changed", version: 7, kind: "status" });
    await until(() => mem.messages.length === 2);
    expect(mem.messages[1]).toEqual({ type: "draft_changed", version: 7, kind: "status" });
    expect(out.messages).toHaveLength(2);

    mem.ws.send(JSON.stringify({ action: "unsubscribe", channel }));
    await until(() => mem.messages.length === 3);
    await hub.publish(channel, { type: "draft_changed", version: 8, kind: "pick" });
    await new Promise((r) => setTimeout(r, 100));
    expect(mem.messages).toHaveLength(3);
    mem.ws.close();
    out.ws.close();
  });
});
