import { inject } from "vitest";
import { createDynamo, type Dynamo } from "../client";
import { newId } from "../ids";
import { ensureTable } from "../table";

declare module "vitest" {
  export interface ProvidedContext {
    ddbEndpoint: string;
  }
}

/** Endpoint of the DynamoDB Local started by `@dnp/db/testing/global-setup`. */
export const testEndpoint = (): string => inject("ddbEndpoint");

/** A fresh, uniquely named table on the test DynamoDB Local. */
export async function createTestDynamo(prefix = "test"): Promise<Dynamo> {
  const db = createDynamo({
    tableName: `${prefix}-${newId().toLowerCase()}`,
    endpoint: testEndpoint(),
  });
  await ensureTable(db.raw, db.tableName);
  return db;
}
