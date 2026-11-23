/**
 * The scheduled poller (docs/design/09 §6, 04 §3): the scheduler ticks every 2 minutes and each
 * season's registry item says whether it is due, so the cadence (2 min live ... 6 h idle) lives in
 * data (`nextPollAt`), not in the schedule.
 */
import { listIngestRegistry, type Dynamo } from "@dnp/db";
import type { LiveSource } from "../providers";
import type { Publisher } from "../realtime/types";
import { logError } from "../redact";
import { runIngest } from "./ingest";
import { scoresPublisher } from "./publish";

/**
 * A season is due when `nextPollAt` falls within this much of now: the 2-minute tick would
 * otherwise often miss a 2-minute delay by a few seconds and wait a whole extra tick.
 */
export const DUE_SLACK_MS = 30_000;

export interface JobSummary {
  due: number;
  ran: number;
  failed: number;
  busy: number;
}

export async function runDueIngests(deps: {
  db: Dynamo;
  now: () => Date;
  source: LiveSource;
  publisher: Publisher;
  log?: (line: string) => void;
}): Promise<JobSummary> {
  const { db, now, source, publisher } = deps;
  const log = deps.log ?? ((line: string) => console.log(line));
  const registry = await listIngestRegistry(db);
  const due = registry.filter(
    (r) =>
      r.enabled &&
      r.nextPollAt !== null &&
      Date.parse(r.nextPollAt) <= now().getTime() + DUE_SLACK_MS,
  );
  const summary: JobSummary = { due: due.length, ran: 0, failed: 0, busy: 0 };
  for (const entry of due) {
    try {
      const r = await runIngest({
        db,
        seasonId: entry.seasonId,
        now: now(),
        source,
        publish: scoresPublisher(publisher, entry.seasonId, now),
      });
      if (r.busy) {
        summary.busy++;
        log(`ingest ${entry.seasonId}: skipped, another run holds the lease`);
        continue;
      }
      summary.ran++;
      const s = r.summary!;
      log(
        `ingest ${entry.seasonId}: games=${s.games} statLines=${s.statLines} changed=${s.changedStatLines} points=${s.pointsWritten} teamScores=${s.teamScoresWritten} warnings=${r.warnings.length} next=${r.nextPollAt ?? "off"}`,
      );
    } catch (err) {
      summary.failed++;
      logError(`ingest ${entry.seasonId} failed`, err);
    }
  }
  return summary;
}
