import {
  ApiGatewayManagementApiClient,
  GoneException,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { BatchWriteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { chanPk, connPk, chanSk, getDocClient, tableName } from "./connections";

let mgmt: ApiGatewayManagementApiClient | undefined;
function getMgmtClient(): ApiGatewayManagementApiClient {
  const endpoint = process.env.WS_MANAGEMENT_ENDPOINT;
  if (!endpoint) throw new Error("WS_MANAGEMENT_ENDPOINT is not set");
  mgmt ??= new ApiGatewayManagementApiClient({ endpoint });
  return mgmt;
}

function isGone(err: unknown): boolean {
  if (err instanceof GoneException) return true;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "GoneException" || e?.$metadata?.httpStatusCode === 410;
}

/** Sends `event` to every connection subscribed to `channel`, pruning stale (410) connections. */
export async function broadcast(
  channel: string,
  event: unknown,
): Promise<{ sent: number; stale: number }> {
  const doc = getDocClient();
  const TableName = tableName();
  const subs: { sk: string }[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await doc.send(
      new QueryCommand({
        TableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": chanPk(channel) },
        ExclusiveStartKey: lastKey,
      }),
    );
    subs.push(...((res.Items ?? []) as { sk: string }[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  const data = new TextEncoder().encode(JSON.stringify(event));
  const client = getMgmtClient();
  const stale: string[] = [];
  let sent = 0;

  await Promise.all(
    subs.map(async ({ sk }) => {
      const connectionId = sk.replace(/^conn#/, "");
      try {
        await client.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: data }));
        sent++;
      } catch (err) {
        if (isGone(err)) stale.push(connectionId);
        else console.error("PostToConnection failed", connectionId, err);
      }
    }),
  );

  for (let i = 0; i < stale.length; i += 12) {
    const keys = stale.slice(i, i + 12).flatMap((id) => [
      { pk: chanPk(channel), sk: `conn#${id}` },
      { pk: connPk(id), sk: chanSk(channel) },
    ]);
    await doc.send(
      new BatchWriteCommand({
        RequestItems: { [TableName]: keys.map((Key) => ({ DeleteRequest: { Key } })) },
      }),
    );
  }
  return { sent, stale: stale.length };
}
