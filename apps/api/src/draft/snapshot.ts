/**
 * Pure builder for GET /seasons/:id/draft (docs/design/14 §4). Inputs are DB items; the output is
 * member-facing: team names only, no user ids, no emails, and only the caller's own queue.
 */
import {
  SLOTS,
  TOTAL_PICKS,
  type DraftSnapshot,
  type LeagueRole,
  type PoolPlayer,
  type SlotName,
  type StartBlocker,
} from "@dnp/contract";
import type { DraftItem, GameItem, NflTeamItem, PickItem, PlayerItem, Team } from "@dnp/db";
import { roundOf, teamOnClock } from "@dnp/domain";

export interface SnapshotInput {
  seasonId: string;
  draft: DraftItem;
  teams: Team[];
  players: PlayerItem[];
  picks: PickItem[];
  nflTeams: NflTeamItem[];
  games: GameItem[];
  /** The caller's queue (own team only); undefined when none. */
  myQueue?: string[];
  myUserId: string;
  myRole: LeagueRole;
  now: Date;
}

export function startBlockers(
  draft: DraftItem,
  teams: Team[],
  players: PlayerItem[],
): StartBlocker[] {
  const out: StartBlocker[] = [];
  if (teams.length !== 9) out.push("teams_incomplete");
  if (teams.some((t) => t.managerUserId === null)) out.push("managers_not_joined");
  const ids = new Set(teams.map((t) => t.teamId));
  if (
    draft.order.length !== 9 ||
    new Set(draft.order).size !== 9 ||
    draft.order.some((id) => !ids.has(id))
  )
    out.push("order_incomplete");
  if (!players.some((p) => p.inPool && p.draftedByTeamId === undefined)) out.push("pool_empty");
  return out;
}

export function toPoolPlayer(p: PlayerItem, seeds: Map<string, number>): PoolPlayer {
  return {
    playerId: p.playerId,
    name: p.name,
    position: p.position,
    nflTeam: p.nflTeam,
    seed: seeds.get(p.nflTeam) ?? null,
    injuryStatus: p.injuryStatus,
    depthChartOrder: p.depthChartOrder ?? null,
    rank: p.rank ?? null,
    stats: p.stats ?? null,
    statsSeason: p.statsSeason ?? null,
    inPool: p.inPool,
    manualOverride: p.manualOverride === true,
    draftedByTeamId: p.draftedByTeamId ?? null,
  };
}

export function buildSnapshot(input: SnapshotInput): DraftSnapshot {
  const { draft, teams, players, picks, now } = input;
  const seeds = new Map(input.nflTeams.map((t) => [t.abbr, t.seed]));
  const teamName = new Map(teams.map((t) => [t.teamId, t.name]));
  const teamAbbr = new Map(teams.map((t) => [t.teamId, t.abbr]));
  const playerById = new Map(players.map((p) => [p.playerId, p]));
  const sortedPicks = [...picks].sort((a, b) => a.overallPick - b.overallPick);

  const opponents = new Map<string, string>();
  for (const g of input.games)
    if (g.round === 1) {
      opponents.set(g.home, g.away);
      opponents.set(g.away, g.home);
    }

  const drafted = new Set(sortedPicks.map((p) => p.playerId));
  const isAvailable = (p: PlayerItem) =>
    p.inPool && p.draftedByTeamId === undefined && !drafted.has(p.playerId);
  const available = players
    .filter(isAvailable)
    .map((p) => ({
      playerId: p.playerId,
      name: p.name,
      position: p.position,
      nflTeam: p.nflTeam,
      seed: seeds.get(p.nflTeam) ?? null,
      injuryStatus: p.injuryStatus,
      depthChartOrder: p.depthChartOrder ?? null,
      rank: p.rank ?? null,
      stats: p.stats ?? null,
      opponent: opponents.get(p.nflTeam) ?? null,
    }))
    .sort(
      (a, b) =>
        (a.seed ?? 99) - (b.seed ?? 99) ||
        a.name.localeCompare(b.name, "en") ||
        a.playerId.localeCompare(b.playerId),
    );

  const rosters: DraftSnapshot["rosters"] = {};
  for (const t of teams)
    rosters[t.teamId] = Object.fromEntries(SLOTS.map((s) => [s, null])) as Record<
      SlotName,
      string | null
    >;
  for (const p of sortedPicks) {
    const roster = rosters[p.teamId];
    if (roster) roster[p.slot] = p.playerId;
  }

  const complete = draft.status === "complete";
  const hasOrder = draft.order.length === 9;
  const started = draft.status !== "scheduled" && draft.status !== "lobby";
  const onClockTeamId =
    started && !complete && hasOrder && draft.currentPick <= TOTAL_PICKS
      ? teamOnClock(draft.currentPick, draft.order)
      : null;

  const myTeam = teams.find((t) => t.managerUserId === input.myUserId);
  const queue = (input.myQueue ?? []).filter((id) => {
    const p = playerById.get(id);
    return p !== undefined && isAvailable(p);
  });

  const clock =
    draft.clockStartedAt && draft.clockExpiresAt && draft.clockSeconds !== undefined
      ? {
          startedAt: draft.clockStartedAt,
          expiresAt: draft.clockExpiresAt,
          seconds: draft.clockSeconds,
          expired: now.getTime() > Date.parse(draft.clockExpiresAt),
        }
      : null;

  return {
    seasonId: input.seasonId,
    version: draft.version,
    status: draft.status,
    totalPicks: TOTAL_PICKS,
    currentPick: draft.currentPick,
    round:
      draft.currentPick >= 1 && draft.currentPick <= TOTAL_PICKS
        ? roundOf(draft.currentPick)
        : null,
    order: hasOrder
      ? draft.order.map((teamId, i) => ({
          position: i + 1,
          teamId,
          name: teamName.get(teamId) ?? "",
          abbr: teamAbbr.get(teamId) ?? "",
        }))
      : [],
    teams: teams.map((t) => ({
      teamId: t.teamId,
      name: t.name,
      abbr: t.abbr,
      joined: t.managerUserId !== null,
    })),
    onClockTeamId,
    clock: started && !complete ? clock : null,
    serverNow: now.toISOString(),
    picks: sortedPicks.map((p) => {
      const pl = playerById.get(p.playerId);
      return {
        overallPick: p.overallPick,
        round: p.round,
        teamId: p.teamId,
        playerId: p.playerId,
        slot: p.slot,
        madeBy: p.madeBy,
        madeAt: p.madeAt,
        player: {
          name: pl?.name ?? "",
          position: pl?.position ?? "QB",
          nflTeam: pl?.nflTeam ?? "",
        },
      };
    }),
    rosters,
    available,
    statsSeason: players.find((p) => p.statsSeason !== undefined)?.statsSeason ?? null,
    myTeamId: myTeam?.teamId ?? null,
    myRole: input.myRole,
    myQueue: queue,
    myAutoDraft: myTeam ? draft.autoDraft.includes(myTeam.teamId) : false,
    autoDraftTeamIds: draft.autoDraft.filter((id) => teamName.has(id)),
    startBlockers: startBlockers(draft, teams, players),
  };
}
