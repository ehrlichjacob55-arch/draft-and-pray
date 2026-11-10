/** Autopick choice (docs/design/14 §1). Pure, no I/O. */
import type { Position, Slot } from "./roster";
import { assignSlot, isDraftable, type RemainingPool } from "./slot-eligibility";

export interface AutopickCandidate {
  playerId: string;
  name: string;
  position: Position;
  nflTeam: string;
}

export interface AutopickInput {
  /** Ordered player ids; may contain unavailable or unknown ids. */
  queue: readonly string[];
  /** Undrafted, in-pool players. */
  available: readonly AutopickCandidate[];
  filledSlots: readonly Slot[];
  /** NFL team abbreviation -> playoff seed; a missing team sorts last. */
  nflTeamSeeds: Readonly<Record<string, number>>;
}

/** Order in which open slots are filled when the queue has nothing usable. */
export const POSITION_ORDER: readonly Slot[] = [
  "QB",
  "RB1",
  "RB2",
  "WR1",
  "WR2",
  "TE",
  "FLEX1",
  "FLEX2",
  "K",
  "DST",
];

const slotAccepts = (slot: Slot, position: Position): boolean => {
  switch (slot) {
    case "FLEX1":
    case "FLEX2":
      return position === "RB" || position === "WR" || position === "TE";
    case "RB1":
    case "RB2":
      return position === "RB";
    case "WR1":
    case "WR2":
      return position === "WR";
    default:
      return slot === position;
  }
};

export function chooseAutopick(input: AutopickInput): { playerId: string; slot: Slot } | null {
  const { queue, available, filledSlots, nflTeamSeeds } = input;
  const filled = new Set(filledSlots);
  const remaining: RemainingPool = {};
  for (const p of available) remaining[p.position] = (remaining[p.position] ?? 0) + 1;
  const draftable = (p: AutopickCandidate) => isDraftable(p.position, filled, remaining);
  const result = (p: AutopickCandidate) => ({
    playerId: p.playerId,
    slot: assignSlot(p.position, filled) as Slot,
  });

  const byId = new Map(available.map((p) => [p.playerId, p]));
  for (const id of queue) {
    const p = byId.get(id);
    if (p && draftable(p)) return result(p);
  }

  const seed = (p: AutopickCandidate) => nflTeamSeeds[p.nflTeam] ?? Number.POSITIVE_INFINITY;
  const sorted = [...available].sort(
    (a, b) =>
      seed(a) - seed(b) ||
      a.name.localeCompare(b.name, "en") ||
      a.playerId.localeCompare(b.playerId),
  );
  for (const slot of POSITION_ORDER) {
    if (filled.has(slot)) continue;
    const pick = sorted.find((p) => slotAccepts(slot, p.position) && draftable(p));
    if (pick) return result(pick);
  }
  return null;
}
