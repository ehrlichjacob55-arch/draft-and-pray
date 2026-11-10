/** zod schema for every item type in docs/design/10 §2. Every item carries a literal `type`. */
import { PLAYOFF_ROUNDS, POSITIONS, SLOTS } from "@dnp/domain";
import { z } from "zod";

const slot = z.enum(SLOTS);
const position = z.enum(POSITIONS);
const playoffRound = z.enum(PLAYOFF_ROUNDS);
const isoDate = z.string();
const base = { pk: z.string(), sk: z.string() };
const gsi1 = { gsi1pk: z.string().optional(), gsi1sk: z.string().optional() };

// ---- Global partitions ----
export const userItem = z.object({
  ...base,
  ...gsi1,
  type: z.literal("User"),
  userId: z.string(),
  email: z.string(),
  displayName: z.string(),
});
export const leagueItem = z.object({
  ...base,
  type: z.literal("League"),
  leagueId: z.string(),
  name: z.string(),
  createdAt: isoDate,
});
export const leagueMemberItem = z.object({
  ...base,
  ...gsi1,
  type: z.literal("LeagueMember"),
  leagueId: z.string(),
  userId: z.string(),
  role: z.enum(["commissioner", "manager"]),
});
export const seasonStatus = z.enum(["setup", "drafting", "in_progress", "complete"]);
export const seasonPointerItem = z.object({
  ...base,
  type: z.literal("SeasonPointer"),
  leagueId: z.string(),
  year: z.number().int(),
  seasonId: z.string(),
  status: seasonStatus,
});
// ---- Season partition ----
export const seasonMetaItem = z.object({
  ...base,
  type: z.literal("SeasonMeta"),
  seasonId: z.string(),
  leagueId: z.string(),
  year: z.number().int(),
  status: seasonStatus,
  activeRulesetVersion: z.number().int(),
});
export const rulesetItem = z.object({
  ...base,
  type: z.literal("Ruleset"),
  version: z.number().int(),
  rules: z.record(z.string(), z.unknown()),
  locked: z.boolean(),
  createdAt: isoDate,
});
export const teamItem = z.object({
  ...base,
  type: z.literal("Team"),
  teamId: z.string(),
  name: z.string(),
  managerUserId: z.string().nullable(),
  /** Null until the commissioner sets the draft order (task 6). */
  draftPosition: z.number().int().nullable(),
});
/** Commissioner-only (docs/design/13 §4). `gsi1pk/gsi1sk` are present only while unclaimed. */
export const managerPrivateItem = z.object({
  ...base,
  ...gsi1,
  type: z.literal("ManagerPrivate"),
  seasonId: z.string(),
  leagueId: z.string(),
  teamId: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  /** Normalized. */
  email: z.string(),
  /** Opaque Cognito username (UUID); absent when no invitation was created. */
  cognitoUsername: z.string().optional(),
  invitedAt: isoDate,
  lastSentAt: isoDate.optional(),
  claimedAt: isoDate.optional(),
  claimedByUserId: z.string().optional(),
});
export const teamOwnerItem = z.object({
  ...base,
  type: z.literal("TeamOwner"),
  userId: z.string(),
  teamId: z.string(),
});
export const draftStatus = z.enum(["scheduled", "lobby", "in_progress", "paused", "complete"]);
export const draftItem = z.object({
  ...base,
  type: z.literal("Draft"),
  status: draftStatus,
  /** Seconds per pick, or null when the clock is off. */
  pickSeconds: z.number().int().nullable(),
  currentPick: z.number().int(),
  currentPickDeadline: isoDate.nullable(),
  startedAt: isoDate.nullable(),
  updatedAt: isoDate,
  /** Monotonic change counter (docs/design/14 §4): bumped by every pick/undo/status/clock/order change. */
  version: z.number().int().default(0),
  /** Team ids by draft position 1..9 (empty until the commissioner sets it). */
  order: z.array(z.string()).default([]),
  /** Alert-only pick clock on the current pick; all three are removed together. */
  clockStartedAt: isoDate.optional(),
  clockSeconds: z.number().int().optional(),
  clockExpiresAt: isoDate.optional(),
  /** Team ids with auto-draft on. Stored as a DynamoDB string set (atomic ADD/DELETE). */
  autoDraft: z
    .union([z.set(z.string()), z.array(z.string())])
    .optional()
    .transform((v): string[] => (v ? [...v] : [])),
});
export const madeBy = z.enum(["manager", "autopick", "commissioner"]);
export const pickItem = z.object({
  ...base,
  type: z.literal("Pick"),
  overallPick: z.number().int(),
  round: z.number().int(),
  teamId: z.string(),
  playerId: z.string(),
  slot,
  madeBy,
  madeByUserId: z.string().nullable(),
  madeAt: isoDate,
});
export const queueItem = z.object({
  ...base,
  type: z.literal("Queue"),
  teamId: z.string(),
  playerIds: z.array(z.string()),
  updatedAt: isoDate,
});
export const rosterEntryItem = z.object({
  ...base,
  type: z.literal("RosterEntry"),
  teamId: z.string(),
  slot,
  playerId: z.string(),
  /** 1 = WC … 4 = SB. */
  fromRound: z.number().int().min(1).max(4),
  acquiredVia: z.enum(["draft", "exception"]),
  txnId: z.string().optional(),
});
export const nflTeamItem = z.object({
  ...base,
  type: z.literal("NflTeam"),
  abbr: z.string(),
  conference: z.enum(["AFC", "NFC"]),
  seed: z.number().int(),
  name: z.string().optional(),
  status: z.enum(["alive", "bye", "eliminated", "champion"]),
  eliminatedInRound: playoffRound.optional(),
});
export const playerItem = z.object({
  ...base,
  type: z.literal("Player"),
  playerId: z.string(),
  name: z.string(),
  position,
  nflTeam: z.string(),
  providerPlayerId: z.string().nullable(),
  injuryStatus: z.string().nullable(),
  inPool: z.boolean(),
  draftedByTeamId: z.string().optional(),
  draftedAtPick: z.number().int().optional(),
  /** Provider overall rank (Sleeper search_rank; lower = better). Null/absent = unranked. */
  rank: z.number().int().nullable().optional(),
  /** Sleeper depth-chart order; display/sorting only. */
  depthChartOrder: z.number().int().nullable().optional(),
  /** Set when the commissioner edits `inPool` or adds the player: imports then leave `inPool` alone. */
  manualOverride: z.boolean().optional(),
});
/** docs/design/14 §3: record of the last automatic pool import. */
export const poolImportItem = z.object({
  ...base,
  type: z.literal("PoolImport"),
  importedAt: isoDate,
  source: z.string(),
  seasonYear: z.number().int(),
  counts: z.record(z.string(), z.number()),
});
/** docs/design/14 §6: single-use WebSocket ticket, keyed by sha256(ticket). `expiresAt` is epoch seconds (TTL). */
export const wsTicketItem = z.object({
  ...base,
  type: z.literal("WsTicket"),
  userId: z.string(),
  expiresAt: z.number().int(),
});
export const roundItem = z.object({
  ...base,
  type: z.literal("Round"),
  round: z.number().int().min(1).max(4),
  code: playoffRound,
  status: z.enum(["upcoming", "live", "final", "finalized"]),
  finalizedAt: isoDate.optional(),
  finalizedBy: z.string().optional(),
});
export const gameItem = z.object({
  ...base,
  type: z.literal("Game"),
  gameId: z.string(),
  round: z.number().int().min(1).max(4),
  providerGameId: z.string(),
  home: z.string(),
  away: z.string(),
  kickoff: isoDate,
  status: z.string(),
  homeScore: z.number(),
  awayScore: z.number(),
  winner: z.string().optional(),
});
export const statLineItem = z.object({
  ...base,
  type: z.literal("StatLine"),
  gameId: z.string(),
  playerId: z.string(),
  raw: z.record(z.string(), z.unknown()),
  canonical: z.record(z.string(), z.number()),
  fetchedAt: isoDate,
  providerHash: z.string(),
});
export const overrideItem = z.object({
  ...base,
  type: z.literal("Override"),
  gameId: z.string(),
  playerId: z.string(),
  statKey: z.string(),
  value: z.number(),
  reason: z.string(),
  byUserId: z.string(),
  at: isoDate,
});
export const pointsItem = z.object({
  ...base,
  type: z.literal("Points"),
  gameId: z.string(),
  playerId: z.string(),
  round: z.number().int().min(1).max(4),
  points: z.number(),
  breakdown: z.record(z.string(), z.number()),
  rulesetVersion: z.number().int(),
  computedAt: isoDate,
});
export const teamScoreItem = z.object({
  ...base,
  type: z.literal("TeamScore"),
  round: z.number().int().min(1).max(4),
  teamId: z.string(),
  points: z.number(),
  provisional: z.boolean(),
  computedAt: isoDate,
});
export const txnItem = z.object({
  ...base,
  type: z.literal("RosterTxn"),
  txnId: z.string(),
  teamId: z.string(),
  slot,
  playerOutId: z.string(),
  playerInId: z.string(),
  reason: z.string(),
  effectiveRound: z.number().int().min(1).max(4),
  byUserId: z.string(),
});
export const auditItem = z.object({
  ...base,
  type: z.literal("Audit"),
  auditId: z.string(),
  actorUserId: z.string().nullable(),
  action: z.string(),
  details: z.record(z.string(), z.unknown()),
  at: isoDate,
});

export const anyItem = z.discriminatedUnion("type", [
  userItem,
  leagueItem,
  leagueMemberItem,
  seasonPointerItem,
  seasonMetaItem,
  rulesetItem,
  teamItem,
  managerPrivateItem,
  teamOwnerItem,
  draftItem,
  pickItem,
  queueItem,
  rosterEntryItem,
  nflTeamItem,
  playerItem,
  poolImportItem,
  wsTicketItem,
  roundItem,
  gameItem,
  statLineItem,
  overrideItem,
  pointsItem,
  teamScoreItem,
  txnItem,
  auditItem,
]);

export type UserItem = z.infer<typeof userItem>;
export type LeagueItem = z.infer<typeof leagueItem>;
export type LeagueMemberItem = z.infer<typeof leagueMemberItem>;
export type SeasonPointerItem = z.infer<typeof seasonPointerItem>;
export type SeasonMetaItem = z.infer<typeof seasonMetaItem>;
export type RulesetItem = z.infer<typeof rulesetItem>;
export type TeamItem = z.infer<typeof teamItem>;
export type ManagerPrivateItem = z.infer<typeof managerPrivateItem>;
export type TeamOwnerItem = z.infer<typeof teamOwnerItem>;
export type DraftItem = z.infer<typeof draftItem>;
export type PickItem = z.infer<typeof pickItem>;
export type QueueItem = z.infer<typeof queueItem>;
export type RosterEntryItem = z.infer<typeof rosterEntryItem>;
export type NflTeamItem = z.infer<typeof nflTeamItem>;
export type PlayerItem = z.infer<typeof playerItem>;
export type PoolImportItem = z.infer<typeof poolImportItem>;
export type WsTicketItem = z.infer<typeof wsTicketItem>;
export type RoundItem = z.infer<typeof roundItem>;
export type GameItem = z.infer<typeof gameItem>;
export type StatLineItem = z.infer<typeof statLineItem>;
export type OverrideItem = z.infer<typeof overrideItem>;
export type PointsItem = z.infer<typeof pointsItem>;
export type TeamScoreItem = z.infer<typeof teamScoreItem>;
export type RosterTxnItem = z.infer<typeof txnItem>;
export type AuditItem = z.infer<typeof auditItem>;
export type AnyItem = z.infer<typeof anyItem>;
export type ItemType = AnyItem["type"];

export function parseItem(raw: unknown): AnyItem {
  return anyItem.parse(raw);
}
