import type { TestProject } from "vitest/node";
import { startDynamoDbLocal } from "../../../../scripts/dynamodb-local.mjs";

/** Vitest globalSetup: one in-memory DynamoDB Local on a random free port per test run. */
export default async function setup(project: TestProject) {
  const { endpoint, stop } = await startDynamoDbLocal({ inMemory: true });
  project.provide("ddbEndpoint", endpoint);
  return async () => {
    await stop();
  };
}
