/**
 * Shared request/response contract for the HTTP API (docs/design/11 §4, 13 §5): zod schemas + inferred
 * types, used by apps/api (validation) and apps/web (typing). No I/O, no Node-only imports.
 */
import { z } from "zod";

// ---- Constants ----
export const MAX_TEAMS = 9;
export const TEAM_NAME_MAX = 40;
export const PERSON_NAME_MAX = 60;
/** Cognito temporary passwords (and so invitation codes) stay valid this long (docs/design/13 §1). */
export const INVITE_VALID_DAYS = 7;

// ---- Errors ----
export const ERROR_CODES = [
  "bad_request",
  "validation_error",
  "unauthorized",
  "forbidden",
  "not_found",
  "season_full",
  "season_not_setup",
  "email_already_added",
  "manager_joined",
  "invite_failed",
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

export const personNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(PERSON_NAME_MAX, `Name must be at most ${PERSON_NAME_MAX} characters`);

// ---- GET /me ----
export const justClaimed = z.object({
  seasonId: z.string(),
  teamId: z.string(),
  teamName: z.string(),
});
export type JustClaimed = z.infer<typeof justClaimed>;

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
  /** Teams that were assigned to the caller by this very request (docs/design/13 §1.4). */
  justClaimed: z.array(justClaimed),
});
export type MeResponse = z.infer<typeof meResponse>;

// ---- GET /seasons/:seasonId ----
/** Member-facing team: team name only, never a person's name or email (docs/design/13 §6). */
export const teamSummary = z.object({
  teamId: z.string(),
  name: z.string(),
  isMine: z.boolean(),
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

// ---- Managers (commissioner only; docs/design/13 §5) ----
export const MANAGER_STATUSES = ["invited", "joined", "expired"] as const;
export const managerStatus = z.enum(MANAGER_STATUSES);
export type ManagerStatus = z.infer<typeof managerStatus>;

export const managerView = z.object({
  teamId: z.string(),
  teamName: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  status: managerStatus,
  invitedAt: z.string(),
  lastSentAt: z.string().nullable(),
  claimedAt: z.string().nullable(),
});
export type ManagerView = z.infer<typeof managerView>;

/** GET /seasons/:seasonId/managers */
export const listManagersResponse = z.array(managerView);
export type ListManagersResponse = z.infer<typeof listManagersResponse>;

/**
 * POST /seasons/:seasonId/managers. `testTemporaryPassword` is honored only together with
 * `?testSuppress=1`, outside prod, for members of the `test-users` Cognito group (13 §7).
 */
/** URL-unreserved characters only, so a test code is safe in the /welcome link fragment. */
export const temporaryPasswordSchema = z
  .string()
  .min(8)
  .max(256)
  .regex(/^[A-Za-z0-9._~-]+$/, "Use only letters, digits and - _ . ~");

export const addManagerRequest = z.object({
  firstName: personNameSchema,
  lastName: personNameSchema,
  email: emailSchema,
  testTemporaryPassword: temporaryPasswordSchema.optional(),
});
export type AddManagerRequest = z.input<typeof addManagerRequest>;

/** Row + whether Cognito sent an invitation email (false when the person already had an account). */
export const managerWithDelivery = managerView.extend({ emailSent: z.boolean() });
export type ManagerWithDelivery = z.infer<typeof managerWithDelivery>;
export const addManagerResponse = managerWithDelivery;
export type AddManagerResponse = ManagerWithDelivery;

/** POST /seasons/:seasonId/managers/:teamId/resend */
export const resendManagerResponse = managerWithDelivery;
export type ResendManagerResponse = ManagerWithDelivery;

/** PATCH /seasons/:seasonId/managers/:teamId */
export const updateManagerRequest = z
  .object({
    firstName: personNameSchema.optional(),
    lastName: personNameSchema.optional(),
    email: emailSchema.optional(),
    testTemporaryPassword: temporaryPasswordSchema.optional(),
  })
  .refine(
    (v) => v.firstName !== undefined || v.lastName !== undefined || v.email !== undefined,
    "Nothing to update",
  );
export type UpdateManagerRequest = z.input<typeof updateManagerRequest>;
export const updateManagerResponse = managerWithDelivery;
export type UpdateManagerResponse = ManagerWithDelivery;

/** DELETE /seasons/:seasonId/managers/:teamId */
export const removeManagerResponse = z.object({ ok: z.literal(true) });
export type RemoveManagerResponse = z.infer<typeof removeManagerResponse>;

// ---- PATCH /teams/:seasonId/:teamId ----
export const renameTeamRequest = z.object({ name: teamNameSchema });
export type RenameTeamRequest = z.input<typeof renameTeamRequest>;
export const renameTeamResponse = z.object({ teamId: z.string(), name: z.string() });
export type RenameTeamResponse = z.infer<typeof renameTeamResponse>;
