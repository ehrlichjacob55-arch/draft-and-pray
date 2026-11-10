import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { wsClientMessage, type WsServerMessage } from "@dnp/contract";
import { createDynamo, dynamoConfigFromEnv } from "@dnp/db";
import type { APIGatewayProxyWebsocketEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { canSubscribe } from "../realtime/channels";
import {
  CONNECTION_TTL_SECONDS,
  META_SK,
  chanPk,
  chanSk,
  connPk,
  connSk,
  getDocClient,
  nowSeconds,
  tableName,
} from "../realtime/connections";

let appDb: ReturnType<typeof createDynamo> | undefined;

async function reply(event: APIGatewayProxyWebsocketEventV2, msg: WsServerMessage) {
  const { domainName, stage, connectionId } = event.requestContext;
  try {
    const client = new ApiGatewayManagementApiClient({
      endpoint: `https://${domainName}/${stage}`,
    });
    await client.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: new TextEncoder().encode(JSON.stringify(msg)),
      }),
    );
  } catch (err) {
    console.error("Could not reply to the connection", err);
  }
}

export const handler = async (
  event: APIGatewayProxyWebsocketEventV2,
): Promise<APIGatewayProxyResultV2> => {
  let parsed;
  try {
    parsed = wsClientMessage.parse(JSON.parse(event.body ?? ""));
  } catch {
    await reply(event, { type: "error", code: "bad_request" });
    return { statusCode: 400, body: "Invalid message" };
  }

  const { connectionId } = event.requestContext;
  const { action, channel } = parsed;
  const doc = getDocClient();
  const TableName = tableName();

  if (action === "subscribe") {
    // Membership of the league that owns the channel (docs/design/14 §6).
    const conn = await doc.send(
      new GetCommand({ TableName, Key: { pk: connPk(connectionId), sk: META_SK } }),
    );
    const userId = typeof conn.Item?.userId === "string" ? conn.Item.userId : undefined;
    appDb ??= createDynamo(dynamoConfigFromEnv(process.env));
    if (!userId || !(await canSubscribe(appDb, userId, channel))) {
      await reply(event, { type: "error", code: "forbidden" });
      return { statusCode: 403, body: "Forbidden" };
    }
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
    await reply(event, { type: "subscribed", channel });
  } else {
    await Promise.all([
      doc.send(
        new DeleteCommand({ TableName, Key: { pk: chanPk(channel), sk: connSk(connectionId) } }),
      ),
      doc.send(
        new DeleteCommand({ TableName, Key: { pk: connPk(connectionId), sk: chanSk(channel) } }),
      ),
    ]);
    await reply(event, { type: "unsubscribed", channel });
  }
  return { statusCode: 200, body: "OK" };
};
