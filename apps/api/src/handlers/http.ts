import { handle } from "hono/aws-lambda";
import { getApp } from "../runtime";

type LambdaHandler = ReturnType<typeof handle>;

let h: LambdaHandler | undefined;

// Equivalent to `handle(app)` (HTTP API v2 payload), but the app/db are created lazily once per container.
export const handler: LambdaHandler = async (event, context) => {
  h ??= handle(await getApp());
  return h(event, context);
};
