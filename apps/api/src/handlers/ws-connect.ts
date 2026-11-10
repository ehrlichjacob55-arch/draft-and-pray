import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { consumeWsTicket, createDynamo, dynamoConfigFromEnv } from "@dnp/db";
import type { APIGatewayProxyWebsocketEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { ticketFromQuery } from "../realtime/channels";
import {
  CONNECTION_TTL_SECONDS,
  META_SK,
  connPk,
  getDocClient,
  nowSeconds,
  tableName,
} from "../realtime/connections";

type ConnectEvent = APIGatewayProxyWebsocketEventV2 & {
  queryStringParameters?: Record<string, string | undefined> | null;
};

let appDb: ReturnType<typeof createDynamo> | undefined;

/**
 * $connect (docs/design/14 §6): the single-use ticket from `POST /realtime/ticket` is consumed with
 * a conditional delete; anything else is rejected with 401. The ticket owner becomes the
 * connection's userId.
 */
export const handler = async (event: ConnectEvent): Promise<APIGatewayProxyResultV2> => {
  const ticket = ticketFromQuery(event.queryStringParameters);
  if (!ticket) return { statusCode: 401, body: "Unauthorized" };
  appDb ??= createDynamo(dynamoConfigFromEnv(process.env));
  const userId = await consumeWsTicket(appDb, ticket);
  if (!userId) return { statusCode: 401, body: "Unauthorized" };

  const now = nowSeconds();
  await getDocClient().send(
    new PutCommand({
      TableName: tableName(),
      Item: {
        pk: connPk(event.requestContext.connectionId),
        sk: META_SK,
        userId,
        connectedAt: now,
        expiresAt: now + CONNECTION_TTL_SECONDS,
      },
    }),
  );
  return { statusCode: 200, body: "Connected" };
};
