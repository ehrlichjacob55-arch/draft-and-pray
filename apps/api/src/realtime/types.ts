import type { DraftChangedEvent, ScoresUpdatedEvent } from "@dnp/contract";

/** What goes out on a season's realtime channel. */
export type ChannelEvent = DraftChangedEvent | ScoresUpdatedEvent;

/** Sends an event to every connection subscribed to `channel`. Implementations may throw. */
export interface Publisher {
  publish(channel: string, event: ChannelEvent): Promise<unknown>;
}

export const noopPublisher: Publisher = { publish: async () => undefined };
