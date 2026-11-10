import { z } from "zod";
import {
  EVENT_STATS,
  STAT_KEYS,
  isEventStat,
  isStatKey,
  type EventStat,
  type StatKey,
} from "./stat-keys";

/**
 * One player's canonical stats for one game: integer counts per key, plus a distance list (yards)
 * for each distance-scored stat. When a distance list is given its length must equal the count;
 * a missing count is filled in from the list.
 */
export interface StatLine {
  counts: Partial<Record<StatKey, number>>;
  events?: Partial<Record<EventStat, number[]>>;
}

export type StatOverrides = Partial<Record<StatKey, number>>;

const count = z.number().int();
const statLineSchema = z
  .object({
    counts: z.partialRecord(z.enum(STAT_KEYS), count),
    events: z
      .partialRecord(z.enum(EVENT_STATS), z.array(z.number().int().min(0).max(120)))
      .optional(),
  })
  .strict()
  .transform((line, ctx): StatLine => {
    const counts = { ...line.counts };
    for (const k of EVENT_STATS) {
      const list = line.events?.[k];
      if (!list) continue;
      if (counts[k] === undefined) counts[k] = list.length;
      else if (counts[k] !== list.length)
        ctx.issues.push({
          code: "custom",
          input: line,
          message: `${k} count is ${counts[k]} but ${list.length} distances are listed`,
        });
    }
    return line.events ? { counts, events: line.events } : { counts };
  });

/** Validates and normalizes a stat line; throws with a readable message. */
export function parseStatLine(input: unknown): StatLine {
  const r = statLineSchema.safeParse(input);
  if (!r.success)
    throw new Error(`Invalid stat line: ${r.error.issues.map((i) => i.message).join("; ")}`);
  return r.data;
}

/**
 * Overrides replace individual stat counts (docs/design/04 §7). Returns the merged line and the
 * overridden keys. Overriding a distance stat (`fg_made`, `fg_missed`) below its recorded list
 * keeps the first N distances; above it is rejected (the extra kicks have no distance).
 */
export function applyOverrides(
  line: StatLine,
  overrides: StatOverrides,
): { statLine: StatLine; overridden: StatKey[] } {
  const counts = { ...line.counts };
  const events = line.events ? { ...line.events } : undefined;
  const overridden: StatKey[] = [];
  for (const [key, value] of Object.entries(overrides)) {
    if (!isStatKey(key)) throw new Error(`Unknown stat key in override: ${key}`);
    if (!Number.isInteger(value)) throw new Error(`Override ${key} must be an integer`);
    counts[key] = value;
    overridden.push(key);
    const list = isEventStat(key) ? events?.[key] : undefined;
    if (events && list) {
      if (value > list.length)
        throw new Error(`Override ${key}=${value} exceeds the ${list.length} recorded distances`);
      events[key as EventStat] = list.slice(0, value);
    }
  }
  return { statLine: events ? { counts, events } : { counts }, overridden };
}
