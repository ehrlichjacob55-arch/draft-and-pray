/** Slot assignment and eligibility (docs/design/03 §3). Pure, no I/O. */
import { POSITIONS, SLOT_PREFERENCE, type Position, type Slot } from "./roster";

export type RemainingPool = Partial<Record<Position, number>>;

/** The most specific open slot for `position`, or null when none is open. */
export function assignSlot(position: Position, filledSlots: Iterable<Slot>): Slot | null {
  const filled = new Set(filledSlots);
  return SLOT_PREFERENCE[position].find((s) => !filled.has(s)) ?? null;
}

/** Positions that still have an open slot. */
export function eligiblePositions(filledSlots: Iterable<Slot>): Position[] {
  const filled = [...filledSlots];
  return POSITIONS.filter((p) => assignSlot(p, filled) !== null);
}

const FLEX_POSITIONS: readonly Position[] = ["RB", "WR", "TE"];
const BASE_SLOTS: Record<Position, readonly Slot[]> = {
  QB: ["QB"],
  RB: ["RB1", "RB2"],
  WR: ["WR1", "WR2"],
  TE: ["TE"],
  K: ["K"],
  DST: ["DST"],
};
const FLEX_SLOTS: readonly Slot[] = ["FLEX1", "FLEX2"];

/** Can the open slots still all be filled from `supply`? (FLEX is the only flexible slot.) */
function canFillOpenSlots(filled: ReadonlySet<Slot>, supply: RemainingPool): boolean {
  let flexSupply = 0;
  for (const p of POSITIONS) {
    const open = BASE_SLOTS[p].filter((s) => !filled.has(s)).length;
    const have = supply[p] ?? 0;
    if (have < open) return false;
    if (FLEX_POSITIONS.includes(p)) flexSupply += have - open;
  }
  return flexSupply >= FLEX_SLOTS.filter((s) => !filled.has(s)).length;
}

/**
 * True when `position` fits an open slot AND, after taking one such player out of
 * `remainingPoolByPosition` (which includes the candidate), the team can still fill every
 * remaining slot (dead-end guard, 03 §3).
 */
export function isDraftable(
  position: Position,
  filledSlots: Iterable<Slot>,
  remainingPoolByPosition: RemainingPool,
): boolean {
  const filled = new Set(filledSlots);
  const slot = assignSlot(position, filled);
  if (slot === null) return false;
  const supply = remainingPoolByPosition[position] ?? 0;
  if (supply < 1) return false;
  filled.add(slot);
  return canFillOpenSlots(filled, { ...remainingPoolByPosition, [position]: supply - 1 });
}
