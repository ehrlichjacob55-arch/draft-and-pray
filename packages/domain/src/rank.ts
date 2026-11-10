/**
 * "Ranked" player order (docs/design/14 §3): overall rank ascending; then unranked D/STs by NFL team
 * seed ascending; then other unranked players by name. Pure; used by the Players list and the
 * commissioner pool review.
 */
export interface RankSortable {
  name: string;
  nflTeam: string;
  position: string;
  rank?: number | null;
}

const NO_SEED = 99;

export function compareByRank(
  a: RankSortable,
  b: RankSortable,
  seedsByTeam: ReadonlyMap<string, number>,
): number {
  const ar = a.rank ?? null;
  const br = b.rank ?? null;
  if (ar !== null && br !== null) {
    if (ar !== br) return ar - br;
  } else if (ar !== null) return -1;
  else if (br !== null) return 1;
  else {
    const aDst = a.position === "DST";
    const bDst = b.position === "DST";
    if (aDst !== bDst) return aDst ? -1 : 1;
    if (aDst) {
      const d = (seedsByTeam.get(a.nflTeam) ?? NO_SEED) - (seedsByTeam.get(b.nflTeam) ?? NO_SEED);
      if (d !== 0) return d;
    }
  }
  return a.name.localeCompare(b.name, "en");
}
