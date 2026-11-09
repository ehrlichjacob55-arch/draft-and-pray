import { PutCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyWebsocketEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import {
  CONNECTION_TTL_SECONDS,
  META_SK,
  connPk,
  getDocClient,
  nowSeconds,
  tableName,
} from "../realtime/connections";

type ConnectEvent = APIGatewayProxyWebsocketEventV2 & {
  requestContext: { authorizer?: { userId?: string; principalId?: string } };
};

export const handler = async (event: ConnectEvent): Promise<APIGatewayProxyResultV2> => {
  const { connectionId, authorizer } = event.requestContext;
  // TODO(task 3/7): derive userId from a verified Cognito token passed at connect time.
  const userId = authorizer?.userId ?? authorizer?.principalId ?? "anonymous";
  const now = nowSeconds();
  await getDocClient().send(
    new PutCommand({
      TableName: tableName(),
      Item: {
        pk: connPk(connectionId),
        sk: META_SK,
        userId,
        connectedAt: now,
        expiresAt: now + CONNECTION_TTL_SECONDS,
      },
    }),
  );
  return { statusCode: 200, body: "Connected" };
};
