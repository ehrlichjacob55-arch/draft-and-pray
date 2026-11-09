/**
 * Shared request/response contract for the HTTP API (docs/design/11 §4): zod schemas + inferred
 * types, used by apps/api (validation) and apps/web (typing). No I/O, no Node-only imports.
 */
import { z } from "zod";

// ---- Constants ----
export const MAX_TEAMS = 9;
export const TEAM_NAME_MAX = 40;
export const INVITE_TTL_DAYS = 14;

// ---- Errors ----
export const ERROR_CODES = [
  "bad_request",
  "validation_error",
  "unauthorized",
  "forbidden",
  "not_found",
  "invite_not_found",
  "season_full",
  "season_not_setup",
  "already_has_team",
  "invite_used",
  "invite_revoked",
  "invite_expired",
  "invite_bound",
  "email_mismatch",
  "team_name_taken",
  "conflict",
  "internal_error",
] as const;
export const errorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCode>;

export const apiError = z.object({
  error: z.object({ code: errorCode, message: z.string() }),
});
export type ApiError = z.infer<typeof apiError>;

// ---- Primitives ----
/** Trim + lowercase. Used for every email comparison and for stored emails. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export const emailSchema = z
  .string()
  .transform(normalizeEmail)
  .pipe(
    z
      .string()
      .max(254)
      .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Invalid email address"),
  );

export const teamNameSchema = z
  .string()
  .trim()
  .min(1, "Team name is required")
  .max(TEAM_NAME_MAX, `Team name must be at most ${TEAM_NAME_MAX} characters`);

/** Case-insensitive team-name key, used for the per-season uniqueness check. */
export const teamNameKey = (name: string): string => name.trim().toLowerCase();

export const seasonStatus = z.enum(["setup", "drafting", "in_progress", "complete"]);
export type SeasonStatus = z.infer<typeof seasonStatus>;
export const leagueRole = z.enum(["commissioner", "manager"]);
export type LeagueRole = z.infer<typeof leagueRole>;

export const INVITE_STATUSES = ["open", "pending", "used", "revoked", "expired"] as const;
export const inviteStatus = z.enum(INVITE_STATUSES);
export type InviteStatus = z.infer<typeof inviteStatus>;

export const INVITE_INVALID_REASONS = ["not_found", "expired", "used", "revoked"] as const;
export const inviteInvalidReason = z.enum(INVITE_INVALID_REASONS);
export type InviteInvalidReason = z.infer<typeof inviteInvalidReason>;

// ---- GET /me ----
export const meResponse = z.object({
  user: z.object({ userId: z.string(), email: z.string(), displayName: z.string() }).nullable(),
  leagues: z.array(
    z.object({
      leagueId: z.string(),
      name: z.string(),
      role: leagueRole,
      seasons: z.array(
        z.object({ seasonId: z.string(), year: z.number().int(), status: seasonStatus }),
      ),
    }),
  ),
});
export type MeResponse = z.infer<typeof meResponse>;

// ---- GET /seasons/:seasonId ----
export const teamSummary = z.object({
  teamId: z.string(),
  name: z.string(),
  managerUserId: z.string().nullable(),
  managerDisplayName: z.string().nullable(),
});
export type TeamSummary = z.infer<typeof teamSummary>;

export const seasonResponse = z.object({
  season: z.object({
    seasonId: z.string(),
    leagueId: z.string(),
    leagueName: z.string(),
    year: z.number().int(),
    status: seasonStatus,
  }),
  teams: z.array(teamSummary),
  myTeamId: z.string().nullable(),
  myRole: leagueRole,
  maxTeams: z.literal(MAX_TEAMS),
});
export type SeasonResponse = z.infer<typeof seasonResponse>;

// ---- Invites (commissioner) ----
export const inviteView = z.object({
  token: z.string(),
  url: z.string(),
  status: inviteStatus,
  pendingEmail: z.string().optional(),
  usedByDisplayName: z.string().optional(),
  createdAt: z.string(),
  /** ISO timestamp (the stored TTL is epoch seconds). */
  expiresAt: z.string(),
});
export type InviteView = z.infer<typeof inviteView>;

/** GET /seasons/:seasonId/invites */
export const listInvitesResponse = z.array(inviteView);
export type ListInvitesResponse = z.infer<typeof listInvitesResponse>;

/** POST /seasons/:seasonId/invites */
export const createInvitesRequest = z.object({ count: z.number().int().min(1).max(MAX_TEAMS) });
export type CreateInvitesRequest = z.infer<typeof createInvitesRequest>;
export const createInvitesResponse = z.array(inviteView);
export type CreateInvitesResponse = z.infer<typeof createInvitesResponse>;

/** DELETE /seasons/:seasonId/invites/:token */
export const revokeInviteResponse = z.object({ ok: z.literal(true) });
export type RevokeInviteResponse = z.infer<typeof revokeInviteResponse>;

// ---- Public invite endpoints ----
/** GET /invites/:token (always 200) */
export const invitePreviewResponse = z.object({
  valid: z.boolean(),
  reason: inviteInvalidReason.optional(),
  leagueName: z.string().optional(),
  seasonYear: z.number().int().optional(),
  /** Masked, e.g. j***@gmail.com. */
  pendingEmail: z.string().optional(),
});
export type InvitePreviewResponse = z.infer<typeof invitePreviewResponse>;

/** POST /invites/:token/register */
export const registerRequest = z.object({ email: emailSchema });
export type RegisterRequest = z.input<typeof registerRequest>;
export const registerResponse = z.object({ ok: z.literal(true) });
export type RegisterResponse = z.infer<typeof registerResponse>;

/** POST /invites/:token/accept */
export const acceptInviteRequest = z.object({ teamName: teamNameSchema });
export type AcceptInviteRequest = z.input<typeof acceptInviteRequest>;
export const acceptInviteResponse = z.object({ seasonId: z.string(), teamId: z.string() });
export type AcceptInviteResponse = z.infer<typeof acceptInviteResponse>;

// ---- PATCH /teams/:seasonId/:teamId ----
export const renameTeamRequest = z.object({ name: teamNameSchema });
export type RenameTeamRequest = z.input<typeof renameTeamRequest>;
export const renameTeamResponse = z.object({ teamId: z.string(), name: z.string() });
export type RenameTeamResponse = z.infer<typeof renameTeamResponse>;
