import type { CustomMessageTriggerHandler } from "aws-lambda";
import { buildInviteMessage } from "../email/invite-message";

/**
 * Cognito CustomMessage trigger (docs/design/13 §3). Rewrites only the AdminCreateUser invitation
 * (initial send and RESEND); every other trigger source is returned unchanged.
 * Deliberately logs nothing: the event holds the recipient's email.
 */
export const handler: CustomMessageTriggerHandler = async (event) => {
  if (event.triggerSource !== "CustomMessage_AdminCreateUser") return event;
  const { subject, html } = buildInviteMessage({
    siteUrl: process.env.SITE_URL ?? "",
    usernameParameter: event.request.usernameParameter,
    codeParameter: event.request.codeParameter,
    clientMetadata: event.request.clientMetadata ?? undefined,
  });
  event.response.emailSubject = subject;
  event.response.emailMessage = html;
  return event;
};
