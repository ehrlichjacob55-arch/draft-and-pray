/**
 * The invitation email (docs/design/13 §3). Pure, so it is unit-tested without Lambda or Cognito.
 *
 * Cognito substitutes the literal placeholders `{username}` and `{####}` (the temporary password)
 * in whatever message the CustomMessage trigger returns, and REQUIRES both to be present. The
 * body carries only the recipient's own league, season and team name; never an email address or
 * anyone else's name (13 §6).
 */
import { INVITE_VALID_DAYS } from "@dnp/contract";

/** Cognito's hard limit for a custom email message. */
export const MAX_MESSAGE_CHARS = 20_000;
export const USERNAME_PLACEHOLDER = "{username}";
export const CODE_PLACEHOLDER = "{####}";

const NAME_MAX = 80;

export interface InviteMessageInput {
  /** Origin of the web app, e.g. https://d123.cloudfront.net (no trailing slash needed). */
  siteUrl: string;
  /** `request.usernameParameter` from the trigger event (defaults to `{username}`). */
  usernameParameter?: string | null;
  /** `request.codeParameter` from the trigger event (defaults to `{####}`). */
  codeParameter?: string | null;
  /** `request.clientMetadata`: leagueName, seasonYear, teamName (all optional). */
  clientMetadata?: Record<string, string | undefined> | null;
}

export interface InviteMessage {
  subject: string;
  html: string;
  link: string;
}

export const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Collapses whitespace/control characters and caps the length. */
const clean = (v: string | undefined, fallback: string): string => {
  const t = (v ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_MAX);
  return t || fallback;
};

/** Validates SITE_URL and returns its origin; throws so a misconfiguration fails loudly. */
export function normalizeSiteUrl(raw: string | undefined): string {
  if (!raw) throw new Error("SITE_URL is not configured");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("SITE_URL is not a valid URL");
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost")
    throw new Error("SITE_URL must be https");
  return url.origin;
}

export function buildInviteMessage(input: InviteMessageInput): InviteMessage {
  const username = input.usernameParameter || USERNAME_PLACEHOLDER;
  const code = input.codeParameter || CODE_PLACEHOLDER;
  const meta = input.clientMetadata ?? {};
  const league = clean(meta.leagueName, "Draft & Pray");
  const year = clean(meta.seasonYear, "");
  const team = clean(meta.teamName, "");
  const season = [league, year].filter(Boolean).join(" ");

  const origin = normalizeSiteUrl(input.siteUrl);
  // The code is URL-safe because we generate it (cognito.ts generateTemporaryPassword), so it can sit raw in the fragment.
  // Fragment (#), never a query string: the id and code are not sent to CloudFront or API logs.
  const link = `${origin}/welcome#u=${username}&c=${code}`;
  const href = `${origin}/welcome#u=${username}&amp;c=${code}`;

  const subject = `You're in: ${season} on Draft & Pray`.replace(/[\r\n]+/g, " ");

  const teamLine = team
    ? `<p style="margin:0 0 20px;font-size:16px;line-height:24px;color:#374151;">Your team: <strong>${escapeHtml(team)}</strong></p>`
    : "";
  const html = `<!doctype html>
<html>
<body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;">
<tr><td style="padding:32px 28px;">
<p style="margin:0 0 4px;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#6b7280;">Draft &amp; Pray</p>
<h1 style="margin:0 0 16px;font-size:24px;line-height:30px;color:#111827;">You're in: ${escapeHtml(season)}</h1>
<p style="margin:0 0 12px;font-size:16px;line-height:24px;color:#374151;">Your commissioner added you to the league. One click gets you in; there is no password to make up.</p>
${teamLine}
<p style="margin:0 0 24px;"><a href="${href}" style="display:inline-block;padding:14px 24px;background:#111827;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;border-radius:8px;">Join the league</a></p>
<p style="margin:0 0 8px;font-size:14px;line-height:20px;color:#6b7280;">If the button does not work, open the site's welcome page and enter this code:</p>
<p style="margin:0 0 20px;font-size:18px;line-height:24px;color:#111827;font-family:'SFMono-Regular',Consolas,monospace;"><code>${code}</code></p>
<p style="margin:0 0 4px;font-size:12px;line-height:18px;color:#9ca3af;">Account id: ${username}</p>
<p style="margin:0;font-size:12px;line-height:18px;color:#9ca3af;">This link works for ${INVITE_VALID_DAYS} days. If it expires, ask your commissioner to resend it. If you were not expecting this, you can ignore this email.</p>
</td></tr>
</table>
</body>
</html>`;

  if (!html.includes(CODE_PLACEHOLDER) || !html.includes(USERNAME_PLACEHOLDER))
    throw new Error("Invite message is missing a required placeholder");
  if (html.length > MAX_MESSAGE_CHARS) throw new Error("Invite message is too long");
  return { subject, html, link };
}
