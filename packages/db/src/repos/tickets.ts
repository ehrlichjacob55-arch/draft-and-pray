/** Single-use WebSocket tickets (docs/design/14 §6): 32 random bytes, stored by sha256, TTL 60 s. */
import { randomBytes, createHash } from "node:crypto";
import { DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { Dynamo } from "../client";
import type { WsTicketItem } from "../items";
import { wsTicketKey } from "../keys";

export const WS_TICKET_TTL_SECONDS = 60;
const hashTicket = (ticket: string) => createHash("sha256").update(ticket).digest("hex");

export async function createWsTicket(
  db: Dynamo,
  input: { userId: string; now?: Date },
): Promise<string> {
  const ticket = randomBytes(32).toString("base64url");
  const item: WsTicketItem = {
    ...wsTicketKey(hashTicket(ticket)),
    type: "WsTicket",
    userId: input.userId,
    expiresAt: Math.floor((input.now ?? new Date()).getTime() / 1000) + WS_TICKET_TTL_SECONDS,
  };
  await db.doc.send(new PutCommand({ TableName: db.tableName, Item: item }));
  return ticket;
}

/** Atomically consumes a ticket; returns the user id, or undefined when invalid/used/expired. */
export async function consumeWsTicket(
  db: Dynamo,
  ticket: string,
  now: Date = new Date(),
): Promise<string | undefined> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(ticket)) return undefined;
  try {
    const res = await db.doc.send(
      new DeleteCommand({
        TableName: db.tableName,
        Key: wsTicketKey(hashTicket(ticket)),
        ConditionExpression: "attribute_exists(pk) AND expiresAt > :now",
        ExpressionAttributeValues: { ":now": Math.floor(now.getTime() / 1000) },
        ReturnValues: "ALL_OLD",
      }),
    );
    return typeof res.Attributes?.userId === "string" ? res.Attributes.userId : undefined;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return undefined;
    throw err;
  }
}
