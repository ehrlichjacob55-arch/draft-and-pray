import { BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { Dynamo } from "../client";

export type WriteRequest = { PutRequest: { Item: object } } | { DeleteRequest: { Key: object } };

const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 8;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const putRequest = (Item: object): WriteRequest => ({
  PutRequest: { Item },
});
export const deleteRequest = (Key: object): WriteRequest => ({
  DeleteRequest: { Key },
});

/**
 * BatchWriteItem in chunks of 25, retrying `UnprocessedItems` with exponential backoff. Not
 * atomic: every request here is an idempotent put/delete of a derived item.
 */
export async function batchWrite(db: Dynamo, requests: WriteRequest[]): Promise<void> {
  for (let i = 0; i < requests.length; i += BATCH_SIZE) {
    let pending: WriteRequest[] = requests.slice(i, i + BATCH_SIZE);
    for (let attempt = 0; pending.length > 0; attempt++) {
      if (attempt >= MAX_ATTEMPTS)
        throw new Error(`BatchWriteItem left ${pending.length} items unprocessed`);
      if (attempt > 0) await sleep(25 * 2 ** attempt);
      const res = await db.doc.send(
        new BatchWriteCommand({ RequestItems: { [db.tableName]: pending } }),
      );
      pending = (res.UnprocessedItems?.[db.tableName] ?? []) as WriteRequest[];
    }
  }
}
