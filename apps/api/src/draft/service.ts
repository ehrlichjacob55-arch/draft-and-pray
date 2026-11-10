/**
 * Draft orchestration (docs/design/14 §4-5): validation with @dnp/domain, persistence with the
 * @dnp/db transactions, then a best-effort `draft_changed` broadcast. The server is the only thing
 * that advances the draft.
 */
import {
  CLOCK_SECONDS,
  TOTAL_PICKS,
  draftChannel,
  type DraftActionResponse,
  type DraftChangedEvent,
  type DraftSnapshot,
  type LeagueRole,
  type MakePickResponse,
} from "@dnp/contract";
import {
  DomainError,
  TransactionConflictError,
  clearClock,
  getDraft,
  getQueue,
  listNflTeams,
  listPlayers,
  listTeams,
  pauseDraft,
  putQueue,
  queryPrefix,
  recordPick,
  requireDraft,
  resumeDraft,
  seasonPk,
  setAutoDraft,
  setDraftOrder,
  skPrefix,
  startClock,
  startDraft,
  undoLastPick,
  parseItem,
  type Dynamo,
  type DraftItem,
  type GameItem,
  type PickItem,
  type PlayerItem,
  type SeasonMetaItem,
  type TeamItem,
} from "@dnp/db";
import {
  assignSlot,
  chooseAutopick,
  isDraftable,
  roundOf,
  teamOnClock,
  type RemainingPool,
  type Slot,
} from "@dnp/domain";
import { logError } from "../redact";
import type { Publisher } from "../realtime/types";
import { buildSnapshot, startBlockers } from "./snapshot";

export interface Actor {
  userId: string;
  role: LeagueRole;
}

export interface DraftServiceDeps {
  db: Dynamo;
  publisher: Publisher;
  now: () => Date;
}

type ChangeKind = DraftChangedEvent["kind"];

const iso = (d: Date) => d.toISOString();

async function listPicks(db: Dynamo, seasonId: string): Promise<PickItem[]> {
  const raw = await queryPrefix(db, seasonPk(seasonId), skPrefix.picks, { consistentRead: true });
  return raw.map((r) => parseItem(r)).filter((i): i is PickItem => i.type === "Pick");
}

async function listGames(db: Dynamo, seasonId: string): Promise<GameItem[]> {
  const raw = await queryPrefix(db, seasonPk(seasonId), "GAME#");
  return raw.map((r) => parseItem(r)).filter((i): i is GameItem => i.type === "Game");
}

/** Maps a cancelled pick transaction to the doc 14 §4 error codes. */
export function mapPickConflict(err: unknown): unknown {
  if (!(err instanceof TransactionConflictError)) return err;
  const draftReason = err.reasons.find((r) => r.label === "draft_state");
  if (draftReason) {
    const status = draftReason.item?.status;
    return status !== undefined && status !== "in_progress"
      ? new DomainError("draft_not_active", "The draft is not in progress")
      : new DomainError("stale_pick", "That pick is no longer on the clock");
  }
  if (err.has("pick_number")) return new DomainError("stale_pick", "That pick was already made");
  if (err.has("player")) return new DomainError("player_taken", "That player is not available");
  if (err.has("roster_slot")) return new DomainError("slot_filled", "That roster slot is filled");
  return err;
}

interface ChainState {
  players: Map<string, PlayerItem>;
  slotsByTeam: Map<string, Slot[]>;
  seeds: Record<string, number>;
  nextPick: number;
}

export function createDraftService({ db, publisher, now }: DraftServiceDeps) {
  const emit = async (
    seasonId: string,
    kind: ChangeKind,
    pick?: DraftChangedEvent["pick"],
    version?: number,
  ): Promise<void> => {
    try {
      const v = version ?? (await getDraft(db, seasonId))?.version ?? 0;
      await publisher.publish(draftChannel(seasonId), {
        type: "draft_changed",
        version: v,
        kind,
        ...(pick ? { pick } : {}),
      });
    } catch (err) {
      logError("Draft broadcast failed", err);
    }
  };

  const result = async (seasonId: string): Promise<DraftActionResponse> => {
    const d = await requireDraft(db, seasonId);
    return { status: d.status, version: d.version, currentPick: d.currentPick };
  };

  const loadTeams = (seasonId: string) => listTeams(db, seasonId);

  // ---- Snapshot ----
  async function snapshot(season: SeasonMetaItem, actor: Actor): Promise<DraftSnapshot> {
    const draft = await requireDraft(db, season.seasonId);
    const [teams, players, picks, nflTeams, games] = await Promise.all([
      loadTeams(season.seasonId),
      listPlayers(db, season.seasonId),
      listPicks(db, season.seasonId),
      listNflTeams(db, season.seasonId),
      listGames(db, season.seasonId),
    ]);
    const mine = teams.find((t) => t.managerUserId === actor.userId);
    const queue = mine ? await getQueue(db, season.seasonId, mine.teamId) : undefined;
    return buildSnapshot({
      seasonId: season.seasonId,
      draft,
      teams,
      players,
      picks,
      nflTeams,
      games,
      myQueue: queue?.playerIds,
      myUserId: actor.userId,
      myRole: actor.role,
      now: now(),
    });
  }

  // ---- Lifecycle ----
  async function setOrder(season: SeasonMetaItem, actor: Actor, order: string[]) {
    const teams = await loadTeams(season.seasonId);
    const ids = new Set(teams.map((t) => t.teamId));
    if (teams.length !== 9 || order.length !== 9 || order.some((id) => !ids.has(id)))
      throw new DomainError("validation_error", "The order must list each of the 9 teams once");
    await setDraftOrder(db, {
      seasonId: season.seasonId,
      order,
      actorUserId: actor.userId,
      now: iso(now()),
    });
    await emit(season.seasonId, "order");
    return result(season.seasonId);
  }

  async function start(season: SeasonMetaItem, actor: Actor) {
    const [draft, teams, players] = await Promise.all([
      requireDraft(db, season.seasonId),
      loadTeams(season.seasonId),
      listPlayers(db, season.seasonId),
    ]);
    if (draft.status !== "scheduled" && draft.status !== "lobby")
      throw new DomainError("draft_wrong_status", "The draft has already started");
    const blockers = startBlockers(draft, teams, players);
    if (blockers.length > 0)
      throw new DomainError("draft_not_ready", "The draft cannot start yet", blockers);
    await startDraft(db, {
      seasonId: season.seasonId,
      leagueId: season.leagueId,
      year: season.year,
      actorUserId: actor.userId,
      now: iso(now()),
    });
    await emit(season.seasonId, "status");
    await runAutoDraftChain(season);
    return result(season.seasonId);
  }

  async function pause(season: SeasonMetaItem, actor: Actor) {
    await pauseDraft(db, { seasonId: season.seasonId, actorUserId: actor.userId, now: iso(now()) });
    await emit(season.seasonId, "status");
    return result(season.seasonId);
  }

  async function resume(season: SeasonMetaItem, actor: Actor) {
    await resumeDraft(db, {
      seasonId: season.seasonId,
      actorUserId: actor.userId,
      now: iso(now()),
    });
    await emit(season.seasonId, "status");
    await runAutoDraftChain(season);
    return result(season.seasonId);
  }

  async function startPickClock(season: SeasonMetaItem, actor: Actor, expectedPick?: number) {
    const draft = await requireDraft(db, season.seasonId);
    if (draft.status !== "in_progress")
      throw new DomainError("draft_not_active", "The draft is not in progress");
    if (expectedPick !== undefined && expectedPick !== draft.currentPick)
      throw new DomainError("stale_pick", "That pick is no longer on the clock");
    await startClock(db, {
      seasonId: season.seasonId,
      actorUserId: actor.userId,
      now: iso(now()),
      expectedPick: draft.currentPick,
      seconds: CLOCK_SECONDS,
    });
    await emit(season.seasonId, "clock");
    return result(season.seasonId);
  }

  async function clearPickClock(season: SeasonMetaItem, actor: Actor) {
    const draft = await requireDraft(db, season.seasonId);
    if (draft.status === "in_progress" && !draft.clockExpiresAt) return result(season.seasonId);
    await clearClock(db, { seasonId: season.seasonId, actorUserId: actor.userId, now: iso(now()) });
    await emit(season.seasonId, "clock");
    return result(season.seasonId);
  }

  // ---- Picks ----
  function remainingPool(players: Iterable<PlayerItem>): RemainingPool {
    const out: RemainingPool = {};
    for (const p of players)
      if (p.inPool && p.draftedByTeamId === undefined) out[p.position] = (out[p.position] ?? 0) + 1;
    return out;
  }

  const pickEvent = (p: PickItem): NonNullable<DraftChangedEvent["pick"]> => ({
    overallPick: p.overallPick,
    round: p.round,
    teamId: p.teamId,
    playerId: p.playerId,
    slot: p.slot,
    madeBy: p.madeBy,
  });

  async function write(
    season: SeasonMetaItem,
    draft: DraftItem,
    pick: {
      teamId: string;
      playerId: string;
      slot: Slot;
      madeBy: PickItem["madeBy"];
      madeByUserId: string | null;
    },
  ): Promise<PickItem> {
    const n = draft.currentPick;
    try {
      return await recordPick(db, {
        seasonId: season.seasonId,
        expectedPick: n,
        round: roundOf(n),
        nextDeadline: null,
        isFinalPick: n === TOTAL_PICKS,
        now: iso(now()),
        seasonPointer: { leagueId: season.leagueId, year: season.year },
        ...pick,
      });
    } catch (err) {
      throw mapPickConflict(err);
    }
  }

  function requireActiveDraft(draft: DraftItem, expectedPick: number): string {
    if (draft.status !== "in_progress")
      throw new DomainError("draft_not_active", "The draft is not in progress");
    if (expectedPick !== draft.currentPick)
      throw new DomainError("stale_pick", "That pick is no longer on the clock");
    return teamOnClock(draft.currentPick, draft.order);
  }

  async function pick(
    season: SeasonMetaItem,
    actor: Actor,
    body: { playerId: string; expectedPick: number; teamId?: string },
  ): Promise<MakePickResponse> {
    const draft = await requireDraft(db, season.seasonId);
    const onClock = requireActiveDraft(draft, body.expectedPick);
    const teams = await loadTeams(season.seasonId);
    const mine = teams.find((t) => t.managerUserId === actor.userId);
    let madeBy: PickItem["madeBy"];
    if (body.teamId !== undefined && body.teamId !== onClock)
      throw new DomainError("not_your_turn", "That team is not on the clock");
    if (mine?.teamId === onClock) madeBy = "manager";
    else if (actor.role === "commissioner" && body.teamId === onClock) madeBy = "commissioner";
    else throw new DomainError("not_your_turn", "It is not your turn");

    const [players, picks] = await Promise.all([
      listPlayers(db, season.seasonId),
      listPicks(db, season.seasonId),
    ]);
    const player = players.find((p) => p.playerId === body.playerId);
    if (!player) throw new DomainError("not_found", "Player not found");
    if (player.draftedByTeamId !== undefined)
      throw new DomainError("player_taken", "That player has already been drafted");
    if (!player.inPool) throw new DomainError("not_eligible", "That player is not in the pool");
    const filled = picks.filter((p) => p.teamId === onClock).map((p) => p.slot);
    if (!isDraftable(player.position, filled, remainingPool(players)))
      throw new DomainError("not_eligible", "That player does not fit an open roster slot");
    const slot = assignSlot(player.position, filled) as Slot;

    const made = await write(season, draft, {
      teamId: onClock,
      playerId: player.playerId,
      slot,
      madeBy,
      madeByUserId: actor.userId,
    });
    await emit(season.seasonId, "pick", pickEvent(made));
    const autoPicked = await runAutoDraftChain(season);
    const res = await result(season.seasonId);
    return {
      ...res,
      pick: pickEvent(made),
      autoPicked,
    };
  }

  /** Commissioner: autopick for the on-clock team now (`madeBy = autopick`). */
  async function autopick(season: SeasonMetaItem, actor: Actor, expectedPick: number) {
    const draft = await requireDraft(db, season.seasonId);
    const onClock = requireActiveDraft(draft, expectedPick);
    const state = await loadChainState(season.seasonId, draft);
    const made = await autopickOne(season, draft, onClock, state, actor.userId);
    if (!made) throw new DomainError("not_eligible", "No eligible player is available");
    await emit(season.seasonId, "pick", pickEvent(made));
    const autoPicked = await runAutoDraftChain(season);
    const res = await result(season.seasonId);
    return { ...res, pick: pickEvent(made), autoPicked };
  }

  async function loadChainState(seasonId: string, draft: DraftItem): Promise<ChainState> {
    const [players, picks, nflTeams] = await Promise.all([
      listPlayers(db, seasonId),
      listPicks(db, seasonId),
      listNflTeams(db, seasonId),
    ]);
    const slotsByTeam = new Map<string, Slot[]>();
    for (const p of picks)
      slotsByTeam.set(p.teamId, [...(slotsByTeam.get(p.teamId) ?? []), p.slot]);
    return {
      players: new Map(players.map((p) => [p.playerId, p])),
      slotsByTeam,
      seeds: Object.fromEntries(nflTeams.map((t) => [t.abbr, t.seed])),
      nextPick: draft.currentPick,
    };
  }

  async function autopickOne(
    season: SeasonMetaItem,
    draft: DraftItem,
    teamId: string,
    state: ChainState,
    actorUserId: string | null,
  ): Promise<PickItem | null> {
    const queue = (await getQueue(db, season.seasonId, teamId))?.playerIds ?? [];
    const available = [...state.players.values()].filter(
      (p) => p.inPool && p.draftedByTeamId === undefined,
    );
    const choice = chooseAutopick({
      queue,
      available,
      filledSlots: state.slotsByTeam.get(teamId) ?? [],
      nflTeamSeeds: state.seeds,
    });
    if (!choice) return null;
    const made = await write(season, draft, {
      teamId,
      playerId: choice.playerId,
      slot: choice.slot,
      madeBy: "autopick",
      madeByUserId: actorUserId,
    });
    const p = state.players.get(choice.playerId) as PlayerItem;
    state.players.set(p.playerId, {
      ...p,
      draftedByTeamId: teamId,
      draftedAtPick: made.overallPick,
    });
    state.slotsByTeam.set(teamId, [...(state.slotsByTeam.get(teamId) ?? []), choice.slot]);
    state.nextPick = made.overallPick + 1;
    return made;
  }

  /**
   * §5: while the next on-clock team has auto-draft on and the draft is in progress, autopick for
   * it (at most 90 picks per request). Each pick is its own transaction, so a concurrent manual
   * pick ends the chain with a clean conflict. Returns the number of picks made.
   */
  async function runAutoDraftChain(season: SeasonMetaItem): Promise<number> {
    let state: ChainState | undefined;
    let count = 0;
    let pending: PickItem | undefined;
    const emits: Promise<void>[] = [];
    // Broadcast each pick with the version read right after it was written.
    const flush = (version: number | undefined) => {
      if (!pending) return;
      emits.push(emit(season.seasonId, "pick", pickEvent(pending), version));
      pending = undefined;
    };
    for (let i = 0; i <= TOTAL_PICKS; i++) {
      const draft = await getDraft(db, season.seasonId);
      flush(draft?.version);
      if (!draft || draft.status !== "in_progress" || draft.currentPick > TOTAL_PICKS) break;
      const teamId = teamOnClock(draft.currentPick, draft.order);
      if (!draft.autoDraft.includes(teamId)) break;
      state ??= await loadChainState(season.seasonId, draft);
      if (state.nextPick !== draft.currentPick) break; // someone else advanced the draft
      try {
        pending = (await autopickOne(season, draft, teamId, state, null)) ?? undefined;
      } catch (err) {
        if (err instanceof DomainError) break;
        throw err;
      }
      if (!pending) break;
      count++;
    }
    await Promise.allSettled(emits);
    return count;
  }

  async function undo(season: SeasonMetaItem, actor: Actor) {
    const draft = await requireDraft(db, season.seasonId);
    if (draft.status === "scheduled" || draft.status === "lobby" || draft.currentPick <= 1)
      throw new DomainError("nothing_to_undo", "There is no pick to undo");
    try {
      await undoLastPick(db, {
        seasonId: season.seasonId,
        currentPick: draft.currentPick,
        actorUserId: actor.userId,
        newDeadline: null,
        now: iso(now()),
        seasonPointer: { leagueId: season.leagueId, year: season.year },
      });
    } catch (err) {
      if (err instanceof TransactionConflictError)
        throw new DomainError("stale_pick", "The draft changed; try again");
      throw err;
    }
    await emit(season.seasonId, "undo");
    return result(season.seasonId);
  }

  // ---- Per-team settings ----
  async function ownTeam(season: SeasonMetaItem, actor: Actor): Promise<TeamItem> {
    const team = (await loadTeams(season.seasonId)).find((t) => t.managerUserId === actor.userId);
    if (!team) throw new DomainError("forbidden", "You do not have a team in this season");
    return team;
  }

  async function readQueue(season: SeasonMetaItem, actor: Actor): Promise<string[]> {
    const team = await ownTeam(season, actor);
    const [queue, players] = await Promise.all([
      getQueue(db, season.seasonId, team.teamId),
      listPlayers(db, season.seasonId),
    ]);
    const open = new Set(
      players.filter((p) => p.inPool && p.draftedByTeamId === undefined).map((p) => p.playerId),
    );
    return (queue?.playerIds ?? []).filter((id) => open.has(id));
  }

  async function writeQueue(season: SeasonMetaItem, actor: Actor, playerIds: string[]) {
    const team = await ownTeam(season, actor);
    const players = await listPlayers(db, season.seasonId);
    const known = new Set(players.map((p) => p.playerId));
    const unique = [...new Set(playerIds)];
    if (unique.some((id) => !known.has(id)))
      throw new DomainError("validation_error", "Unknown player in the queue");
    await putQueue(db, {
      seasonId: season.seasonId,
      teamId: team.teamId,
      playerIds: unique,
      now: iso(now()),
    });
    return readQueue(season, actor);
  }

  async function setAuto(season: SeasonMetaItem, actor: Actor, enabled: boolean) {
    const team = await ownTeam(season, actor);
    await setAutoDraft(db, {
      seasonId: season.seasonId,
      teamId: team.teamId,
      enabled,
      actorUserId: actor.userId,
      now: iso(now()),
    });
    await emit(season.seasonId, "status");
    const autoPicked = enabled ? await runAutoDraftChain(season) : 0;
    return { ...(await result(season.seasonId)), enabled, autoPicked };
  }

  return {
    snapshot,
    setOrder,
    start,
    pause,
    resume,
    startPickClock,
    clearPickClock,
    pick,
    autopick,
    undo,
    readQueue,
    writeQueue,
    setAuto,
    emit,
  };
}

export type DraftService = ReturnType<typeof createDraftService>;
