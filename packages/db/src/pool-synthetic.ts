/**
 * Synthetic, fictional player pool for unit/e2e tests and local/DEV demos (docs/design/14 §3):
 * 14 teams AAA..NNN (seeds 1-7 per conference), ~19 players each, no real people.
 */
import type { PoolPlayerInput, PoolTeamInput } from "./repos/pool";

const TEAM_NAMES = [
  "Alpha Aardvarks",
  "Bravo Badgers",
  "Charlie Condors",
  "Delta Dingoes",
  "Echo Eagles",
  "Foxtrot Falcons",
  "Golf Gophers",
  "Hotel Herons",
  "India Ibex",
  "Juliet Jaguars",
  "Kilo Koalas",
  "Lima Lynx",
  "Mike Marmots",
  "November Newts",
];
const FIRST_NAMES = [
  "Avery",
  "Blake",
  "Casey",
  "Drew",
  "Emery",
  "Finley",
  "Gray",
  "Harper",
  "Indy",
  "Jules",
  "Kai",
  "Lane",
  "Morgan",
  "Noel",
];
const COUNTS = { QB: 3, RB: 5, WR: 7, TE: 3, K: 1 } as const;
const WORD = {
  QB: "Quarterback",
  RB: "Runner",
  WR: "Receiver",
  TE: "Tightend",
  K: "Kicker",
} as const;

export function syntheticPool(): { teams: PoolTeamInput[]; players: PoolPlayerInput[] } {
  const teams: PoolTeamInput[] = [];
  const players: PoolPlayerInput[] = [];
  TEAM_NAMES.forEach((name, i) => {
    const abbr = String.fromCharCode(65 + i).repeat(3);
    teams.push({ abbr, name, conference: i < 7 ? "AFC" : "NFC", seed: (i % 7) + 1 });
    for (const [position, n] of Object.entries(COUNTS) as [keyof typeof COUNTS, number][])
      for (let k = 1; k <= n; k++)
        players.push({
          providerPlayerId: `syn:${abbr}-${position}-${k}`,
          name: `${FIRST_NAMES[i]} ${WORD[position]} ${k}`,
          position,
          nflTeam: abbr,
          injuryStatus: null,
          depthChartOrder: k,
        });
  });
  return { teams, players };
}
