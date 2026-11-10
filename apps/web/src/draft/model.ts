import type { AvailablePlayer, DraftSnapshot, PositionName, SlotName } from "@dnp/contract";
import {
  assignSlot,
  isDraftable,
  picksUntilTurn,
  type RemainingPool,
  type Slot,
} from "@dnp/domain";

export const SLOT_ORDER: readonly SlotName[] = [
  "QB",
  "RB1",
  "RB2",
  "WR1",
  "WR2",
  "TE",
  "FLEX1",
  "FLEX2",
  "DST",
  "K",
];

export const POSITION_LIST: readonly PositionName[] = ["QB", "RB", "WR", "TE", "K", "DST"];

/** Position colour coding (works in light and dark: translucent fills). */
export const POSITION_CLASS: Record<PositionName, string> = {
  QB: "bg-rose-500/20 text-rose-900 dark:text-rose-200",
  RB: "bg-emerald-500/20 text-emerald-900 dark:text-emerald-200",
  WR: "bg-sky-500/20 text-sky-900 dark:text-sky-200",
  TE: "bg-amber-500/25 text-amber-900 dark:text-amber-200",
  K: "bg-violet-500/20 text-violet-900 dark:text-violet-200",
  DST: "bg-slate-500/25 text-slate-900 dark:text-slate-200",
};

export const isResetting = (s: DraftSnapshot) => s.status === "resetting";
export const isLive = (s: DraftSnapshot) => s.status === "in_progress" || s.status === "paused";
export const isPreDraft = (s: DraftSnapshot) => s.status === "scheduled" || s.status === "lobby";

export function teamName(s: DraftSnapshot, teamId: string | null): string {
  if (!teamId) return "";
  return (
    s.order.find((o) => o.teamId === teamId)?.name ??
    s.teams.find((t) => t.teamId === teamId)?.name ??
    "Unknown team"
  );
}

export function teamAbbr(s: DraftSnapshot, teamId: string | null): string {
  if (!teamId) return "";
  return (
    s.order.find((o) => o.teamId === teamId)?.abbr ??
    s.teams.find((t) => t.teamId === teamId)?.abbr ??
    "?"
  );
}

export function filledSlotsOf(s: DraftSnapshot, teamId: string | null): Slot[] {
  if (!teamId) return [];
  const roster: Partial<Record<SlotName, string | null>> = s.rosters[teamId] ?? {};
  return SLOT_ORDER.filter((slot) => roster[slot]);
}

export function remainingByPosition(available: AvailablePlayer[]): RemainingPool {
  const pool: RemainingPool = {};
  for (const p of available) pool[p.position] = (pool[p.position] ?? 0) + 1;
  return pool;
}

export interface Eligibility {
  /** True when `player` fits an open slot of the team and does not strand the roster. */
  eligible: (player: AvailablePlayer) => boolean;
  slotFor: (player: AvailablePlayer) => Slot | null;
}

export function eligibilityFor(s: DraftSnapshot, teamId: string | null): Eligibility | null {
  if (!teamId) return null;
  const filled = filledSlotsOf(s, teamId);
  const remaining = remainingByPosition(s.available);
  return {
    eligible: (p) => isDraftable(p.position, filled, remaining),
    slotFor: (p) => assignSlot(p.position, filled),
  };
}

export interface DraftView {
  myPosition: number | null;
  onClockName: string;
  isMyTurn: boolean;
  /** 0 = on the clock now; null = no pick left / not live. */
  picksUntilMyTurn: number | null;
  myNextPick: number | null;
}

export function deriveView(s: DraftSnapshot): DraftView {
  const myPosition = s.order.find((o) => o.teamId === s.myTeamId)?.position ?? null;
  const live = isLive(s);
  const until = live && myPosition !== null ? picksUntilTurn(myPosition, s.currentPick) : null;
  return {
    myPosition,
    onClockName: teamName(s, s.onClockTeamId),
    isMyTurn: s.status === "in_progress" && !!s.myTeamId && s.onClockTeamId === s.myTeamId,
    picksUntilMyTurn: until,
    myNextPick: until === null ? null : s.currentPick + until,
  };
}

/** Overall pick number at (round 1..10, draft position 1..9) for the snake. */
export function pickAt(round: number, position: number): number {
  return (round - 1) * 9 + (round % 2 === 1 ? position : 10 - position);
}

export const START_BLOCKER_TEXT: Record<string, string> = {
  teams_incomplete: "All 9 teams need to be added.",
  managers_not_joined: "Every team needs a manager who has joined.",
  order_incomplete: "The commissioner still needs to set the draft order.",
  pool_empty: "The player pool is empty.",
};
export const blockerText = (code: string) => START_BLOCKER_TEXT[code] ?? code;

/** Team on the clock at overall pick `n` (1..90) in the snake, or null outside the draft. */
export function teamAtPick(
  s: DraftSnapshot,
  n: number,
): { teamId: string; name: string; abbr: string } | null {
  if (n < 1 || n > s.totalPicks || s.order.length === 0) return null;
  const size = s.order.length;
  const round = Math.ceil(n / size);
  const idx = (n - 1) % size;
  const position = round % 2 === 1 ? idx + 1 : size - idx;
  const o = s.order.find((x) => x.position === position);
  return o ? { teamId: o.teamId, name: o.name, abbr: o.abbr } : null;
}
