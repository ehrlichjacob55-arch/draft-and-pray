import { broadcast } from "./publisher";
import type { Publisher } from "./types";

/** Publishes through API Gateway WebSocket connections (connection table + management API). */
export const awsPublisher: Publisher = {
  publish: (channel, event) => broadcast(channel, event),
};
