import { draftChannel } from "@dnp/contract";
import { logError } from "../redact";
import type { Publisher } from "../realtime/types";

/** Tells a season's connected clients that scores changed. Best-effort: never throws. */
export type PublishScores = () => Promise<void>;

export function scoresPublisher(
  publisher: Publisher,
  seasonId: string,
  now: () => Date = () => new Date(),
): PublishScores {
  return async () => {
    try {
      await publisher.publish(draftChannel(seasonId), {
        type: "scores_updated",
        seasonId,
        at: now().toISOString(),
      });
    } catch (err) {
      logError("Scores broadcast failed", err);
    }
  };
}
