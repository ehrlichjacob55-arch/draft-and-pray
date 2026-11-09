import { ApiError } from "../api";

/** Friendly text for API errors (docs/design/11 §4 error codes). */
export function friendlyError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "email_mismatch":
        return "This invite is reserved for a different email address. Sign out and sign in with the email the invite was registered with.";
      case "already_has_team":
        return "You already have a team in this season.";
      case "team_name_taken":
        return "Another team already uses that name. Pick a different one.";
      case "season_full":
        return "This season already has all 9 teams (counting open invites).";
      case "invite_bound":
        return "This invite is already reserved for a different email address.";
      case "season_not_setup":
        return "Team sign-up is closed: this season is no longer in setup.";
      case "invite_used":
        return "This invite has already been used.";
      case "invite_revoked":
        return "This invite was revoked by the commissioner.";
      case "invite_expired":
        return "This invite has expired.";
      case "invite_not_found":
      case "not_found":
        return "We could not find that. It may have been removed.";
      case "unauthorized":
        return "Your session has expired. Please sign in again.";
      case "forbidden":
        return "You do not have access to that.";
      case "network_error":
        return "Could not reach the server. Check your connection and try again.";
      case "validation_error":
      case "bad_request":
        return err.message;
      default:
        return err.message || "Something went wrong. Please try again.";
    }
  }
  return err instanceof Error ? err.message : "Something went wrong. Please try again.";
}

export const INVITE_INVALID_TEXT = {
  not_found: "We could not find this invite link. Check that you copied the whole link.",
  expired: "This invite link has expired. Ask your commissioner for a new one.",
  used: "This invite link has already been used. Ask your commissioner for a new one.",
  revoked: "This invite link was revoked. Ask your commissioner for a new one.",
} as const;

/** Only same-origin relative paths are allowed as a post-sign-in target. */
export function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\")
    ? next
    : "/";
}
