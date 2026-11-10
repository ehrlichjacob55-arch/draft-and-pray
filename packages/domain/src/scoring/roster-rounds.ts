import type { Slot } from "../roster";

/**
 * A slot's occupant from a round on (docs/design/10: `ROSTER#<team>#<slot>#<fromRound>`). The
 * draft creates one entry per slot with fromRound 1; a commissioner roster exception adds another
 * for the same slot with a later fromRound, so one slot can hold different players in different
 * rounds.
 */
export interface RosterAssignment {
  slot: Slot;
  playerId: string;
  /** 1 = Wild Card ... 4 = Super Bowl. */
  fromRound: number;
}

/** Player ids occupying the team's slots in `round`: per slot, the latest entry with fromRound <= round. */
export function rosterPlayersForRound(
  assignments: readonly RosterAssignment[],
  round: number,
): string[] {
  const bySlot = new Map<Slot, RosterAssignment>();
  for (const a of assignments) {
    if (a.fromRound > round) continue;
    const cur = bySlot.get(a.slot);
    if (!cur || a.fromRound > cur.fromRound) bySlot.set(a.slot, a);
  }
  return [...bySlot.values()].map((a) => a.playerId);
}
