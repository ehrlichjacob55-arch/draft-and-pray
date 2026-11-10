/** Snake draft order (docs/design/03 §1). Pure, no I/O. */
import { ROUNDS, TEAM_COUNT, TOTAL_PICKS } from "./roster";

function assertPick(pick: number): void {
  if (!Number.isInteger(pick) || pick < 1 || pick > TOTAL_PICKS)
    throw new RangeError(`Pick must be an integer 1..${TOTAL_PICKS} (got ${pick})`);
}
function assertPosition(position: number): void {
  if (!Number.isInteger(position) || position < 1 || position > TEAM_COUNT)
    throw new RangeError(`Draft position must be an integer 1..${TEAM_COUNT} (got ${position})`);
}

/** 1..10. */
export function roundOf(pick: number): number {
  assertPick(pick);
  return Math.ceil(pick / TEAM_COUNT);
}

/** 0..8. */
export function indexInRound(pick: number): number {
  assertPick(pick);
  return (pick - 1) % TEAM_COUNT;
}

/** Draft position (1..9) that picks at `pick`. */
export function draftPositionOnClock(pick: number): number {
  const index = indexInRound(pick);
  return roundOf(pick) % 2 === 1 ? index + 1 : TEAM_COUNT - index;
}

/** Team on the clock, given team ids ordered by draft position (index 0 = position 1). */
export function teamOnClock(pick: number, orderByPosition: readonly string[]): string {
  if (orderByPosition.length !== TEAM_COUNT)
    throw new RangeError(`Draft order needs ${TEAM_COUNT} teams (got ${orderByPosition.length})`);
  return orderByPosition[draftPositionOnClock(pick) - 1] as string;
}

/** All 10 overall picks of a draft position, ascending. */
export function picksForPosition(position: number): number[] {
  assertPosition(position);
  const out: number[] = [];
  for (let round = 1; round <= ROUNDS; round++) {
    const index = round % 2 === 1 ? position - 1 : TEAM_COUNT - position;
    out.push((round - 1) * TEAM_COUNT + index + 1);
  }
  return out;
}

/** The first pick of `position` strictly after `afterPick` (0 = from the start), or null. */
export function nextPickFor(position: number, afterPick: number): number | null {
  return picksForPosition(position).find((p) => p > afterPick) ?? null;
}

/**
 * How many picks happen before `position` is on the clock again, counting from `currentPick`:
 * 0 = on the clock now, null = no pick left.
 */
export function picksUntilTurn(position: number, currentPick: number): number | null {
  const next = picksForPosition(position).find((p) => p >= currentPick);
  return next === undefined ? null : next - currentPick;
}
