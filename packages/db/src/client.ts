import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export interface DynamoConfig {
  tableName: string;
  region?: string;
  endpoint?: string;
}

export type Doc = DynamoDBDocumentClient;

export interface Dynamo {
  doc: DynamoDBDocumentClient;
  raw: DynamoDBClient;
  tableName: string;
}

export function createDynamo({ tableName, region, endpoint }: DynamoConfig): Dynamo {
  const raw = new DynamoDBClient({
    region: region ?? "us-east-1",
    ...(endpoint
      ? { endpoint, credentials: { accessKeyId: "local", secretAccessKey: "local" } }
      : {}),
  });
  const doc = DynamoDBDocumentClient.from(raw, {
    marshallOptions: { removeUndefinedValues: true },
  });
  return { doc, raw, tableName };
}

export function dynamoConfigFromEnv(
  env: Record<string, string | undefined>,
  defaults: { tableName?: string } = {},
): DynamoConfig {
  const tableName = env.APP_TABLE || defaults.tableName;
  if (!tableName) throw new Error("APP_TABLE is not set");
  return {
    tableName,
    region: env.AWS_REGION || "us-east-1",
    endpoint: env.DYNAMODB_ENDPOINT || undefined,
  };
}
