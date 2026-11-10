import type { Position } from "../roster";
import type { StatLine } from "./stat-line";

/**
 * Hand-mapped canonical stat lines from a real playoff game: 2025-26 NFL Wild Card, Los Angeles
 * Rams 34, Carolina Panthers 31 (final), played 2026-01-10. Source: ESPN summary endpoint,
 * event id 401772979 (docs/design/12), `boxscore.players[]` and `scoringPlays[]`, fetched
 * 2026-11-10. Field mapping from ESPN to canonical keys in general is Task 9; these few lines
 * were mapped by hand:
 *   - FG distances from scoringPlays text ("Harrison Mevis 46 Yd Field Goal", "... 42 Yd ...").
 *   - DST lines: points allowed = the opponent's final score (every point in this game was an
 *     offensive TD, FG or XP, so nothing defensive/return is counted against anyone); sacks =
 *     opponent QB "SACKS" (1-9 / 2-14 -> 1 and 2 sacks); INTs = `interceptions` categories;
 *     fumble recoveries = `fumbles.REC`. No safeties or blocked kicks in the scoring plays or
 *     box score, so those are 0 (not independently verified).
 *
 * `placeholder` / `league` are the engine's expected points under rulesets/placeholder.v1.json and
 * rulesets/league.v1.json, each with the hand calculation (whole units, so 304 yds / 25 = 12).
 */
export interface GoldenPlayer {
  name: string;
  position: Position;
  stats: StatLine;
  placeholder: number;
  league: number;
}

export const GOLDEN_GAME = { provider: "espn", eventId: "401772979", date: "2026-01-10" } as const;

export const GOLDEN_PLAYERS: GoldenPlayer[] = [
  {
    // Passing 304 yds, 3 TD, 1 INT; 2 rushes for 0 yds.
    name: "Matthew Stafford (LAR QB)",
    position: "QB",
    stats: { counts: { pass_yds: 304, pass_td: 3, pass_int: 1, rush_yds: 0 } },
    // placeholder: 304/25 = 12 (12.16, whole units) + 3 TD * 4 = 12 - 1 INT * 2 = 22
    placeholder: 22,
    // league: 304/30 = 10 (10.13) + 3 TD * 6 = 18 - 1 INT * 1 = 27
    league: 27,
  },
  {
    // Passing 264 yds, 1 TD, 1 INT; rushing 3 for 24 yds and 1 TD.
    name: "Bryce Young (CAR QB)",
    position: "QB",
    stats: { counts: { pass_yds: 264, pass_td: 1, pass_int: 1, rush_yds: 24, rush_td: 1 } },
    // placeholder: 264/25 = 10 + 1 TD * 4 = 4 - 1 INT * 2 + 24/10 = 2 + 1 rush TD * 6 = 6 -> 10+4-2+2+6 = 20
    placeholder: 20,
    // league: 264/30 = 8 (8.8) + 1 TD * 6 - 1 INT * 1 + 24/10 = 2 + 6 -> 8+6-1+2+6 = 21
    league: 21,
  },
  {
    // Rushing 3 for 14 yds, 1 TD; receiving 10 rec, 111 yds, 1 TD.
    name: "Puka Nacua (LAR WR)",
    position: "WR",
    stats: { counts: { rush_yds: 14, rush_td: 1, rec: 10, rec_yds: 111, rec_td: 1 } },
    // placeholder: rush 14/10 = 1 + rush TD 6 + rec 10 * 0 + 111/10 = 11 + rec TD 6 = 24
    placeholder: 24,
    // league: no PPR, otherwise the same: 1 + 6 + 0 + 11 + 6 = 24
    league: 24,
  },
  {
    // Rushing 13 for 46 yds, 2 TD; receiving 2 rec, 13 yds.
    name: "Chuba Hubbard (CAR RB)",
    position: "RB",
    stats: { counts: { rush_yds: 46, rush_td: 2, rec: 2, rec_yds: 13 } },
    // placeholder: 46/10 = 4 + 2 TD * 6 = 12 + 13/10 = 1 -> 17 (no 100-yd bonus)
    placeholder: 17,
    // league: same, 4 + 12 + 1 = 17
    league: 17,
  },
  {
    // Rushing 1 for 4 yds; 1 fumble, 1 lost.
    name: "Trevor Etienne (CAR RB)",
    position: "RB",
    stats: { counts: { rush_yds: 4, fum_lost: 1 } },
    // placeholder: 4/10 = 0 - 1 fumble lost * 2 = -2
    placeholder: -2,
    // league: 0 - 1 * 1 = -1
    league: -1,
  },
  {
    // Receiving 2 rec, 34 yds, 1 TD (the 19-yard TD from Stafford).
    name: "Colby Parkinson (LAR TE)",
    position: "TE",
    stats: { counts: { rec: 2, rec_yds: 34, rec_td: 1 } },
    // placeholder: rec 0 + 34/10 = 3 + 6 = 9
    placeholder: 9,
    // league: 3 + 6 = 9
    league: 9,
  },
  {
    // FG 2/2 (42 and 46 yds), XP 4/4.
    name: "Harrison Mevis (LAR K)",
    position: "K",
    stats: { counts: { fg_made: 2, xp_made: 4 }, events: { fg_made: [42, 46] } },
    // placeholder: two FG in the 40-49 band 2 * 4 = 8 + 4 XP * 1 = 12
    placeholder: 12,
    // league: same bands: 8 + 4 = 12
    league: 12,
  },
  {
    // LAR defense vs CAR: allowed 31, 2 sacks (Fiske, Ford), 1 INT (Durant), 1 fumble recovery (Reeder).
    name: "LAR DST",
    position: "DST",
    stats: { counts: { def_pts_allowed: 31, def_sack: 2, def_int: 1, def_fum_rec: 1 } },
    // placeholder: 28+ band -4; 2 sacks * 1 = 2; 1 INT * 2 = 2; fumble recoveries unscored -> -4+2+2 = 0
    placeholder: 0,
    // league: 28-34 band 0; 2 sacks 2 + 1 INT 1 + 1 fumble recovery 1 = 4
    league: 4,
  },
  {
    // CAR defense vs LAR: allowed 34, 1 sack (Gipson), 1 INT (Jackson), 0 fumble recoveries.
    name: "CAR DST",
    position: "DST",
    stats: { counts: { def_pts_allowed: 34, def_sack: 1, def_int: 1, def_fum_rec: 0 } },
    // placeholder: 28+ band -4; 1 sack 1; 1 INT 2 -> -1
    placeholder: -1,
    // league: 28-34 band 0 (34 is the top of that band); 1 + 1 = 2
    league: 2,
  },
];
