import { BatchWriteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyWebsocketEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { chanPk, connPk, connSk, getDocClient, tableName } from "../realtime/connections";

type Key = { pk: string; sk: string };

async function batchDelete(keys: Key[]): Promise<void> {
  const doc = getDocClient();
  const TableName = tableName();
  for (let i = 0; i < keys.length; i += 25) {
    const chunk = keys.slice(i, i + 25);
    await doc.send(
      new BatchWriteCommand({
        RequestItems: { [TableName]: chunk.map((Key) => ({ DeleteRequest: { Key } })) },
      }),
    );
  }
}

export const handler = async (
  event: APIGatewayProxyWebsocketEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const { connectionId } = event.requestContext;
  const doc = getDocClient();
  const pk = connPk(connectionId);

  const items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await doc.send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": pk },
        ExclusiveStartKey: lastKey,
      }),
    );
    items.push(...(res.Items ?? []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  const keys: Key[] = [];
  for (const item of items) {
    keys.push({ pk, sk: String(item.sk) });
    if (typeof item.channel === "string") {
      keys.push({ pk: chanPk(item.channel), sk: connSk(connectionId) });
    }
  }
  await batchDelete(keys);
  return { statusCode: 200, body: "Disconnected" };
};
