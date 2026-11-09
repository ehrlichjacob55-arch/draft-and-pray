import { DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyWebsocketEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { z } from "zod";
import {
  CONNECTION_TTL_SECONDS,
  chanPk,
  chanSk,
  connPk,
  connSk,
  getDocClient,
  nowSeconds,
  tableName,
} from "../realtime/connections";

const messageSchema = z.object({
  action: z.enum(["subscribe", "unsubscribe"]),
  channel: z.string().min(1).max(200),
});

export const handler = async (
  event: APIGatewayProxyWebsocketEventV2,
): Promise<APIGatewayProxyResultV2> => {
  let parsed: z.infer<typeof messageSchema>;
  try {
    parsed = messageSchema.parse(JSON.parse(event.body ?? ""));
  } catch {
    return { statusCode: 400, body: "Invalid message" };
  }

  const { connectionId } = event.requestContext;
  const { action, channel } = parsed;
  const doc = getDocClient();
  const TableName = tableName();

  if (action === "subscribe") {
    // TODO(task 7): authorize the subscription against the user's league/draft membership.
    const expiresAt = nowSeconds() + CONNECTION_TTL_SECONDS;
    await Promise.all([
      doc.send(
        new PutCommand({
          TableName,
          Item: { pk: chanPk(channel), sk: connSk(connectionId), connectionId, expiresAt },
        }),
      ),
      doc.send(
        new PutCommand({
          TableName,
          Item: { pk: connPk(connectionId), sk: chanSk(channel), channel, expiresAt },
        }),
      ),
    ]);
  } else {
    await Promise.all([
      doc.send(
        new DeleteCommand({ TableName, Key: { pk: chanPk(channel), sk: connSk(connectionId) } }),
      ),
      doc.send(
        new DeleteCommand({ TableName, Key: { pk: connPk(connectionId), sk: chanSk(channel) } }),
      ),
    ]);
  }
  return { statusCode: 200, body: "OK" };
};
