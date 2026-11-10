import type { DraftChangedEvent } from "@dnp/contract";

/** Sends an event to every connection subscribed to `channel`. Implementations may throw. */
export interface Publisher {
  publish(channel: string, event: DraftChangedEvent): Promise<unknown>;
}

export const noopPublisher: Publisher = { publish: async () => undefined };
