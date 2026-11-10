/**
 * Live draft + player pool + realtime contract (docs/design/14). Member-facing payloads contain
 * team names only: no person names, emails or user ids (docs/design/13 §6).
 */
import { z } from "zod";

export const TOTAL_PICKS = 90;
export const TEAM_COUNT = 9;
export const CLOCK_SECONDS = 90;
export const QUEUE_MAX = 100;

export const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"] as const;
export const position = z.enum(POSITIONS);
export type PositionName = z.infer<typeof position>;

export const SLOTS = [
  "QB",
  "RB1",
  "RB2",
  "WR1",
  "WR2",
  "TE",
  "FLEX1",
  "FLEX2",
  "DST",
  "K",
] as const;
export const slotName = z.enum(SLOTS);
export type SlotName = z.infer<typeof slotName>;

export const draftStatus = z.enum(["scheduled", "lobby", "in_progress", "paused", "complete"]);
export type DraftStatus = z.infer<typeof draftStatus>;
export const madeBy = z.enum(["manager", "autopick", "commissioner"]);
export type MadeBy = z.infer<typeof madeBy>;

/** Why a draft cannot start yet (`draft_not_ready` reasons). */
export const START_BLOCKERS = [
  "teams_incomplete",
  "managers_not_joined",
  "order_incomplete",
  "pool_empty",
] as const;
export const startBlocker = z.enum(START_BLOCKERS);
export type StartBlocker = z.infer<typeof startBlocker>;

// ---- Player pool ----
export const poolPlayer = z.object({
  playerId: z.string(),
  name: z.string(),
  position,
  nflTeam: z.string(),
  seed: z.number().int().nullable(),
  injuryStatus: z.string().nullable(),
  depthChartOrder: z.number().int().nullable(),
  inPool: z.boolean(),
  /** Set by the commissioner (PATCH/POST); survives re-imports. */
  manualOverride: z.boolean(),
  draftedByTeamId: z.string().nullable(),
});
export type PoolPlayer = z.infer<typeof poolPlayer>;

export const nflTeamView = z.object({
  abbr: z.string(),
  name: z.string(),
  conference: z.enum(["AFC", "NFC"]),
  seed: z.number().int(),
});
export type NflTeamView = z.infer<typeof nflTeamView>;

/** GET /seasons/:id/players (member). */
export const listPlayersResponse = z.object({
  teams: z.array(nflTeamView),
  players: z.array(poolPlayer),
  lastImport: z
    .object({
      importedAt: z.string(),
      source: z.string(),
      seasonYear: z.number().int(),
      counts: z.record(z.string(), z.number()),
    })
    .nullable(),
});
export type ListPlayersResponse = z.infer<typeof listPlayersResponse>;

/** PATCH /seasons/:id/players/:playerId (commissioner). */
export const updatePlayerRequest = z.object({ inPool: z.boolean() });
export type UpdatePlayerRequest = z.input<typeof updatePlayerRequest>;
export const updatePlayerResponse = poolPlayer;

/** POST /seasons/:id/players (commissioner): manual add, e.g. a late call-up. */
export const addPlayerRequest = z.object({
  name: z.string().trim().min(1).max(80),
  position: position.exclude(["DST"]),
  nflTeam: z.string().trim().min(2).max(4).toUpperCase(),
  injuryStatus: z.string().trim().max(40).nullable().optional(),
});
export type AddPlayerRequest = z.input<typeof addPlayerRequest>;
export const addPlayerResponse = poolPlayer;

/** POST /seasons/:id/pool/import (commissioner). */
export const importPoolRequest = z.object({
  seasonYear: z.number().int().min(2000).max(2100),
});
export type ImportPoolRequest = z.input<typeof importPoolRequest>;
export const importPoolResponse = z.object({
  source: z.string(),
  seasonYear: z.number().int(),
  importedAt: z.string(),
  counts: z.object({
    teams: z.number().int(),
    players: z.number().int(),
    added: z.number().int(),
    updated: z.number().int(),
    removed: z.number().int(),
  }),
});
export type ImportPoolResponse = z.infer<typeof importPoolResponse>;

// ---- Draft snapshot ----
export const snapshotPick = z.object({
  overallPick: z.number().int(),
  round: z.number().int(),
  teamId: z.string(),
  playerId: z.string(),
  slot: slotName,
  madeBy,
  madeAt: z.string(),
  player: z.object({ name: z.string(), position, nflTeam: z.string() }),
});
export type SnapshotPick = z.infer<typeof snapshotPick>;

export const availablePlayer = z.object({
  playerId: z.string(),
  name: z.string(),
  position,
  nflTeam: z.string(),
  seed: z.number().int().nullable(),
  injuryStatus: z.string().nullable(),
  depthChartOrder: z.number().int().nullable(),
  /** NFL team the player faces in the Wild Card round, when known. */
  opponent: z.string().nullable(),
});
export type AvailablePlayer = z.infer<typeof availablePlayer>;

export const draftClock = z.object({
  startedAt: z.string(),
  expiresAt: z.string(),
  seconds: z.number().int(),
  /** Computed by the server at request time; clients also compare `expiresAt` locally. */
  expired: z.boolean(),
});
export type DraftClock = z.infer<typeof draftClock>;

export const draftSnapshot = z.object({
  seasonId: z.string(),
  /** Monotonic: every pick, undo, status, clock, order and auto-draft change increments it. */
  version: z.number().int(),
  status: draftStatus,
  totalPicks: z.literal(TOTAL_PICKS),
  /** 1..90; 91 once the draft is complete. */
  currentPick: z.number().int(),
  round: z.number().int().nullable(),
  /** Team names only. Empty until the commissioner sets the order. */
  order: z.array(z.object({ position: z.number().int(), teamId: z.string(), name: z.string() })),
  teams: z.array(z.object({ teamId: z.string(), name: z.string(), joined: z.boolean() })),
  onClockTeamId: z.string().nullable(),
  clock: draftClock.nullable(),
  serverNow: z.string(),
  picks: z.array(snapshotPick),
  /** teamId -> slot -> playerId (null = open). */
  rosters: z.record(z.string(), z.record(slotName, z.string().nullable())),
  available: z.array(availablePlayer),
  myTeamId: z.string().nullable(),
  myRole: z.enum(["commissioner", "manager"]),
  /** Only the caller's own queue, with drafted players removed. */
  myQueue: z.array(z.string()),
  myAutoDraft: z.boolean(),
  /** Teams with auto-draft on (no queue contents). */
  autoDraftTeamIds: z.array(z.string()),
  /** Unmet start preconditions (empty = can start). */
  startBlockers: z.array(startBlocker),
});
export type DraftSnapshot = z.infer<typeof draftSnapshot>;

// ---- Commands ----
/** PUT /seasons/:id/draft/order */
export const setOrderRequest = z.object({ order: z.array(z.string()).length(TEAM_COUNT) });
export type SetOrderRequest = z.input<typeof setOrderRequest>;

/** Result of start / pause / resume / clock / order / undo / auto-draft. */
export const draftActionResponse = z.object({
  status: draftStatus,
  version: z.number().int(),
  currentPick: z.number().int(),
});
export type DraftActionResponse = z.infer<typeof draftActionResponse>;

/** POST /seasons/:id/draft/clock (the clock is always CLOCK_SECONDS). */
export const startClockRequest = z.object({ expectedPick: z.number().int().optional() });
export type StartClockRequest = z.input<typeof startClockRequest>;

/** POST /seasons/:id/draft/picks */
export const makePickRequest = z.object({
  playerId: z.string().min(1),
  expectedPick: z.number().int().min(1).max(TOTAL_PICKS),
  /** Commissioner only; must be the on-clock team. */
  teamId: z.string().optional(),
});
export type MakePickRequest = z.input<typeof makePickRequest>;
export const makePickResponse = draftActionResponse.extend({
  pick: snapshotPick.omit({ player: true, madeAt: true }),
  /** Picks made by the auto-draft chain that followed. */
  autoPicked: z.number().int(),
});
export type MakePickResponse = z.infer<typeof makePickResponse>;

/** POST /seasons/:id/draft/autopick */
export const autopickRequest = z.object({ expectedPick: z.number().int().min(1).max(TOTAL_PICKS) });
export type AutopickRequest = z.input<typeof autopickRequest>;

/** GET/PUT /seasons/:id/draft/queue */
export const queueRequest = z.object({
  playerIds: z.array(z.string().min(1)).max(QUEUE_MAX),
});
export type QueueRequest = z.input<typeof queueRequest>;
export const queueResponse = z.object({ playerIds: z.array(z.string()) });
export type QueueResponse = z.infer<typeof queueResponse>;

/** PUT /seasons/:id/draft/auto-draft */
export const autoDraftRequest = z.object({ enabled: z.boolean() });
export type AutoDraftRequest = z.input<typeof autoDraftRequest>;
export const autoDraftResponse = draftActionResponse.extend({
  enabled: z.boolean(),
  autoPicked: z.number().int(),
});
export type AutoDraftResponse = z.infer<typeof autoDraftResponse>;

// ---- Realtime (docs/design/14 §6) ----
/** POST /realtime/ticket */
export const realtimeTicketResponse = z.object({ ticket: z.string(), wsUrl: z.string() });
export type RealtimeTicketResponse = z.infer<typeof realtimeTicketResponse>;

export const draftChannel = (seasonId: string) => `draft:${seasonId}`;
export const parseDraftChannel = (channel: string): string | null =>
  /^draft:[A-Za-z0-9_-]{1,64}$/.test(channel) ? channel.slice("draft:".length) : null;

export const DRAFT_CHANGE_KINDS = ["pick", "undo", "status", "clock", "order"] as const;
export const draftChangedEvent = z.object({
  type: z.literal("draft_changed"),
  version: z.number().int(),
  kind: z.enum(DRAFT_CHANGE_KINDS),
  pick: snapshotPick.omit({ player: true, madeAt: true }).optional(),
});
export type DraftChangedEvent = z.infer<typeof draftChangedEvent>;

/** Client -> server over the socket. */
export const wsClientMessage = z.object({
  action: z.enum(["subscribe", "unsubscribe"]),
  channel: z.string().min(1).max(200),
});
export type WsClientMessage = z.infer<typeof wsClientMessage>;

/** Server -> client acks/errors (events use draftChangedEvent). */
export const wsServerMessage = z.discriminatedUnion("type", [
  draftChangedEvent,
  z.object({ type: z.literal("subscribed"), channel: z.string() }),
  z.object({ type: z.literal("unsubscribed"), channel: z.string() }),
  z.object({ type: z.literal("error"), code: z.enum(["forbidden", "bad_request"]) }),
]);
export type WsServerMessage = z.infer<typeof wsServerMessage>;
