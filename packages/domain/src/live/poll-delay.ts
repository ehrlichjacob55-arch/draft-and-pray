import type { LiveGameStatus, LiveRoundStatus } from "./team-status";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A game is in progress. */
export const POLL_LIVE_MS = 2 * MINUTE;
/** A kickoff this close counts as "about to start". */
export const POLL_SOON_WINDOW_MS = 15 * MINUTE;
/** Never poll sooner than this (also the scheduler's own tick). */
export const POLL_MIN_MS = 2 * MINUTE;
/** A game later today (or kicked off but not final). */
export const POLL_GAMEDAY_MS = 15 * MINUTE;
/** "Later the same day" means kickoff within this window. */
export const POLL_GAMEDAY_WINDOW_MS = 12 * HOUR;
/** Between rounds (stat corrections), before the playoffs, or any quiet time. */
export const POLL_IDLE_MS = 6 * HOUR;

export interface PollGame {
  round: number;
  status: LiveGameStatus;
  /** ISO timestamp. */
  kickoff: string;
}

/**
 * docs/design/04 §3 "Ingestion schedule": milliseconds until the next provider poll, or null when
 * polling is off (the Super Bowl is final and every round is finalized).
 */
export function nextPollDelay(input: {
  now: Date;
  games: readonly PollGame[];
  rounds: readonly { round: number; status: LiveRoundStatus }[];
}): number | null {
  const { now, games, rounds } = input;
  if (games.some((g) => g.status === "in_progress")) return POLL_LIVE_MS;

  const upcoming = games.filter((g) => g.status === "scheduled");
  const untilKickoff = upcoming.map((g) => Date.parse(g.kickoff) - now.getTime());
  const soon = untilKickoff.filter((ms) => ms > 0 && ms <= POLL_SOON_WINDOW_MS);
  if (soon.length > 0) return Math.max(Math.min(...soon), POLL_MIN_MS);
  // Kicked off but the provider still says scheduled, or kicking off later today.
  if (untilKickoff.some((ms) => ms <= POLL_GAMEDAY_WINDOW_MS)) return POLL_GAMEDAY_MS;

  const superBowl = games.filter((g) => g.round === 4);
  const allFinalized = [1, 2, 3, 4].every(
    (n) => rounds.find((r) => r.round === n)?.status === "finalized",
  );
  if (allFinalized && superBowl.length > 0 && superBowl.every((g) => g.status === "final"))
    return null;
  return POLL_IDLE_MS;
}
