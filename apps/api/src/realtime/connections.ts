import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/** DynamoDB key helpers for the ws connection table (docs/design/09 §4). */
export const connPk = (connectionId: string) => `conn#${connectionId}`;
export const connSk = (connectionId: string) => `conn#${connectionId}`;
export const chanPk = (channel: string) => `chan#${channel}`;
export const chanSk = (channel: string) => `chan#${channel}`;
export const META_SK = "meta";
export const CONNECTION_TTL_SECONDS = 24 * 60 * 60;

let doc: DynamoDBDocumentClient | undefined;
export function getDocClient(): DynamoDBDocumentClient {
  doc ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return doc;
}

export function tableName(): string {
  const name = process.env.WS_CONNECTIONS_TABLE;
  if (!name) throw new Error("WS_CONNECTIONS_TABLE is not set");
  return name;
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);
