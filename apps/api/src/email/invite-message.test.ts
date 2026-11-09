import { describe, expect, it } from "vitest";
import type { CustomMessageTriggerEvent } from "aws-lambda";
import { handler } from "../handlers/cognito-custom-message";
import {
  MAX_MESSAGE_CHARS,
  buildInviteMessage,
  escapeHtml,
  normalizeSiteUrl,
} from "./invite-message";

const SITE = "https://d123.cloudfront.net";
const meta = { leagueName: "League Example", seasonYear: "2026", teamName: "Team Example" };

describe("buildInviteMessage", () => {
  it("has both required placeholders, the fragment link and the fallback code", () => {
    const m = buildInviteMessage({ siteUrl: SITE, clientMetadata: meta });
    expect(m.html).toContain("{####}");
    expect(m.html).toContain("{username}");
    expect(m.link).toBe(`${SITE}/welcome#u={username}&c={####}`);
    expect(m.html).toContain(`href="${SITE}/welcome#u={username}&amp;c={####}"`);
    expect(m.link).not.toContain("?");
    expect(m.subject).toBe("You're in: League Example 2026 on Draft & Pray");
    expect(m.html).toContain("Team Example");
    expect(m.html).toContain("League Example 2026");
  });

  it("uses the trigger's own placeholder strings", () => {
    const m = buildInviteMessage({
      siteUrl: `${SITE}/`,
      usernameParameter: "{username}",
      codeParameter: "{####}",
      clientMetadata: meta,
    });
    expect(m.link.startsWith(`${SITE}/welcome#`)).toBe(true);
  });

  it("is inline-styled HTML with no email address or script", () => {
    const m = buildInviteMessage({ siteUrl: SITE, clientMetadata: meta });
    expect(m.html).toMatch(/style="/);
    expect(m.html).not.toMatch(/<script|<style|<link/i);
    expect(m.html).not.toMatch(/[^\s@]+@[^\s@]+\.[a-z]/i);
  });

  it("HTML-escapes league and team names and strips control characters", () => {
    const m = buildInviteMessage({
      siteUrl: SITE,
      clientMetadata: {
        leagueName: `<img src=x onerror=alert(1)>&"'`,
        seasonYear: "2026",
        teamName: "<b>Team</b>\r\nBcc: x",
      },
    });
    expect(m.html).not.toContain("<img");
    expect(m.html).not.toContain("<b>Team</b>");
    expect(m.html).toContain("&lt;img src=x onerror=alert(1)&gt;&amp;&quot;&#39;");
    expect(m.html).toContain("&lt;b&gt;Team&lt;/b&gt; Bcc: x");
    expect(m.subject).not.toMatch(/[\r\n]/);
  });

  it("stays well under 20,000 characters even with huge metadata", () => {
    const big = "x".repeat(50_000);
    const m = buildInviteMessage({
      siteUrl: SITE,
      clientMetadata: { leagueName: big, seasonYear: big, teamName: big },
    });
    expect(m.html.length).toBeLessThan(MAX_MESSAGE_CHARS);
    expect(m.html.length).toBeLessThan(5_000);
  });

  it("falls back gracefully without metadata", () => {
    const m = buildInviteMessage({ siteUrl: SITE });
    expect(m.subject).toBe("You're in: Draft & Pray on Draft & Pray");
    expect(m.html).toContain("{####}");
  });

  it("escapeHtml handles the five special characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("normalizeSiteUrl", () => {
  it("returns the origin; rejects missing, invalid and non-https URLs", () => {
    expect(normalizeSiteUrl("https://x.example.com/path?q=1")).toBe("https://x.example.com");
    expect(normalizeSiteUrl("http://localhost:5173")).toBe("http://localhost:5173");
    expect(() => normalizeSiteUrl(undefined)).toThrow(/SITE_URL/);
    expect(() => normalizeSiteUrl("not a url")).toThrow(/valid/);
    expect(() => normalizeSiteUrl("http://evil.example.com")).toThrow(/https/);
  });
});

function event(triggerSource: string): CustomMessageTriggerEvent {
  return {
    version: "1",
    region: "us-east-2",
    userPoolId: "us-east-2_abc123",
    userName: "11111111-2222-3333-4444-555555555555",
    callerContext: { awsSdkVersion: "x", clientId: "c" },
    triggerSource,
    request: {
      userAttributes: { email: "alex@example.com" },
      codeParameter: "{####}",
      usernameParameter: "{username}",
      clientMetadata: meta,
    },
    response: { smsMessage: "", emailMessage: "", emailSubject: "" },
  } as unknown as CustomMessageTriggerEvent;
}

describe("cognito-custom-message handler", () => {
  const run = (e: CustomMessageTriggerEvent) =>
    (handler as unknown as (e: CustomMessageTriggerEvent) => Promise<CustomMessageTriggerEvent>)(e);

  it("rewrites CustomMessage_AdminCreateUser (initial send and resend)", async () => {
    process.env.SITE_URL = SITE;
    const out = await run(event("CustomMessage_AdminCreateUser"));
    expect(out.response.emailSubject).toBe("You're in: League Example 2026 on Draft & Pray");
    expect(out.response.emailMessage).toContain(`${SITE}/welcome#u={username}&amp;c={####}`);
    expect(out.response.emailMessage).not.toContain("alex@example.com");
  });

  it.each([
    "CustomMessage_SignUp",
    "CustomMessage_ResendCode",
    "CustomMessage_ForgotPassword",
    "CustomMessage_UpdateUserAttribute",
    "CustomMessage_VerifyUserAttribute",
    "CustomMessage_Authentication",
    "CustomMessage_AdminCreateUserX",
  ])("returns %s unchanged", async (src) => {
    process.env.SITE_URL = SITE;
    const e = event(src);
    const out = await run(e);
    expect(out.response).toEqual({ smsMessage: "", emailMessage: "", emailSubject: "" });
  });

  it("fails loudly when SITE_URL is not configured", async () => {
    delete process.env.SITE_URL;
    await expect(run(event("CustomMessage_AdminCreateUser"))).rejects.toThrow(/SITE_URL/);
  });
});
