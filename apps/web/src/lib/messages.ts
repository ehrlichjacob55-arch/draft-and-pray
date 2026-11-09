import { ApiError } from "../api";

/** Friendly text for API errors (docs/design/11 §4 error codes). */
export function friendlyError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "team_name_taken":
        return "Another team already uses that name. Pick a different one.";
      case "season_full":
        return "This season already has all 9 teams.";
      case "season_not_setup":
        return "Adding managers is closed: this season is no longer in setup.";
      case "email_already_added":
        return "That email is already on a team in this season.";
      case "manager_joined":
        return "That manager has already joined, so this can no longer be changed.";
      case "invite_failed":
        return "We could not send the invitation email. Nothing was changed; please try again.";
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

/** Only same-origin relative paths are allowed as a post-sign-in target. */
export function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\")
    ? next
    : "/";
}
