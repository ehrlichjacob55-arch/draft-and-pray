import {
  CreateTableCommand,
  DescribeTableCommand,
  ResourceInUseException,
  ResourceNotFoundException,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
  type CreateTableCommandInput,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";

/** TTL attribute (epoch seconds); no item type uses it right now. */
export const TTL_ATTRIBUTE = "expiresAt";
export const GSI1 = "gsi1";

/**
 * The single application table (docs/design/09 §4, 10 §1). Terraform mirrors this definition:
 * keep them in sync.
 */
export function tableDefinition(tableName: string): CreateTableCommandInput {
  return {
    TableName: tableName,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "S" },
      { AttributeName: "gsi1pk", AttributeType: "S" },
      { AttributeName: "gsi1sk", AttributeType: "S" },
    ],
    KeySchema: [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: GSI1,
        KeySchema: [
          { AttributeName: "gsi1pk", KeyType: "HASH" },
          { AttributeName: "gsi1sk", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  };
}

/** Creates the table if missing, waits until ACTIVE, and enables TTL on `expiresAt`. Idempotent. */
export async function ensureTable(client: DynamoDBClient, tableName: string): Promise<void> {
  let exists = true;
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
    exists = false;
  }
  if (!exists) {
    try {
      await client.send(new CreateTableCommand(tableDefinition(tableName)));
    } catch (err) {
      if (!(err instanceof ResourceInUseException)) throw err;
    }
  }
  await waitUntilTableExists({ client, maxWaitTime: 60 }, { TableName: tableName });
  try {
    await client.send(
      new UpdateTimeToLiveCommand({
        TableName: tableName,
        TimeToLiveSpecification: { AttributeName: TTL_ATTRIBUTE, Enabled: true },
      }),
    );
  } catch {
    // DynamoDB Local may not support TTL, and re-enabling an enabled TTL errors; both are fine.
  }
}
