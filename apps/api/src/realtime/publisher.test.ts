import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { BatchWriteCommand, DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { broadcast } from "./publisher";

const ddb = mockClient(DynamoDBDocumentClient);
const apigw = mockClient(ApiGatewayManagementApiClient);

beforeEach(() => {
  ddb.reset();
  apigw.reset();
  process.env.WS_CONNECTIONS_TABLE = "tbl";
  process.env.WS_MANAGEMENT_ENDPOINT = "https://example.execute-api.us-east-1.amazonaws.com/dev";
});

describe("broadcast", () => {
  it("posts to every subscriber and deletes 410 Gone connections", async () => {
    ddb.on(QueryCommand).resolves({
      Items: [
        { pk: "chan#draft:1", sk: "conn#a" },
        { pk: "chan#draft:1", sk: "conn#b" },
      ],
    });
    ddb.on(BatchWriteCommand).resolves({});
    apigw.on(PostToConnectionCommand, { ConnectionId: "a" }).resolves({});
    apigw
      .on(PostToConnectionCommand, { ConnectionId: "b" })
      .rejects(Object.assign(new Error("gone"), { name: "GoneException" }));

    const result = await broadcast("draft:1", { type: "pick" });
    expect(result).toEqual({ sent: 1, stale: 1 });

    const deletes = ddb.commandCalls(BatchWriteCommand);
    expect(deletes).toHaveLength(1);
    const items = deletes[0]!.args[0].input.RequestItems!.tbl!;
    expect(items.map((i) => i.DeleteRequest!.Key)).toEqual([
      { pk: "chan#draft:1", sk: "conn#b" },
      { pk: "conn#b", sk: "chan#draft:1" },
    ]);
  });
});
