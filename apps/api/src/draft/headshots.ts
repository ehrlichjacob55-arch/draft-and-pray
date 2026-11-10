/**
 * Face-card image URLs for the draft room (docs/design/14 §7). Pure: the source is known from the
 * pool item. Real Sleeper players store Sleeper's numeric `player_id` as `providerPlayerId`; DST
 * rows have none and use the team logo; synthetic/local-seed pools and manually added players have
 * no real image, so they get `null` (the UI shows an initials avatar).
 */
import { toSleeperAbbr } from "../providers/abbreviations";

const SLEEPER_CDN = "https://sleepercdn.com";

/** The 32 NFL teams (ESPN abbreviations); synthetic pools use fictional abbrs like AAA. */
const NFL_ABBRS: ReadonlySet<string> = new Set(
  (
    "ARI ATL BAL BUF CAR CHI CIN CLE DAL DEN DET GB HOU IND JAX KC LAC LAR LV MIA MIN NE NO NYG " +
    "NYJ PHI PIT SEA SF TB TEN WSH"
  ).split(" "),
);

export function headshotUrl(p: {
  position: string;
  nflTeam: string;
  providerPlayerId: string | null;
}): string | null {
  if (p.position === "DST")
    return NFL_ABBRS.has(p.nflTeam)
      ? `${SLEEPER_CDN}/images/team_logos/nfl/${toSleeperAbbr(p.nflTeam).toLowerCase()}.png`
      : null;
  return p.providerPlayerId && /^\d+$/.test(p.providerPlayerId)
    ? `${SLEEPER_CDN}/content/nfl/players/${p.providerPlayerId}.jpg`
    : null;
}
