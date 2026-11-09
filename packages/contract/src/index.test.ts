import { describe, expect, it } from "vitest";
import {
  ERROR_CODES,
  MAX_TEAMS,
  acceptInviteRequest,
  apiError,
  createInvitesRequest,
  emailSchema,
  normalizeEmail,
  registerRequest,
  renameTeamRequest,
  teamNameKey,
  teamNameSchema,
} from "./index";

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Jane.Doe@Gmail.COM \n")).toBe("jane.doe@gmail.com");
  });
});

describe("emailSchema / registerRequest", () => {
  it("normalizes valid emails", () => {
    expect(registerRequest.parse({ email: " A@B.co " })).toEqual({ email: "a@b.co" });
  });
  it.each(["", "nope", "a@b", "a b@c.com", "@c.com"])("rejects %j", (bad) => {
    expect(emailSchema.safeParse(bad).success).toBe(false);
  });
});

describe("team names", () => {
  it("trims", () => expect(teamNameSchema.parse("  Gridiron Gang ")).toBe("Gridiron Gang"));
  it("rejects empty or whitespace-only", () => {
    expect(teamNameSchema.safeParse("").success).toBe(false);
    expect(teamNameSchema.safeParse("   ").success).toBe(false);
  });
  it("accepts 40 chars and rejects 41", () => {
    expect(teamNameSchema.safeParse("x".repeat(40)).success).toBe(true);
    expect(teamNameSchema.safeParse("x".repeat(41)).success).toBe(false);
  });
  it("builds a case-insensitive key", () => {
    expect(teamNameKey(" Foo ")).toBe(teamNameKey("fOO"));
  });
  it("is used by accept and rename requests", () => {
    expect(acceptInviteRequest.safeParse({ teamName: " " }).success).toBe(false);
    expect(renameTeamRequest.parse({ name: " ok " })).toEqual({ name: "ok" });
  });
});

describe("createInvitesRequest", () => {
  it("accepts 1..MAX_TEAMS integers only", () => {
    expect(MAX_TEAMS).toBe(9);
    expect(createInvitesRequest.safeParse({ count: 1 }).success).toBe(true);
    expect(createInvitesRequest.safeParse({ count: 9 }).success).toBe(true);
    for (const count of [0, 10, 1.5, "3"])
      expect(createInvitesRequest.safeParse({ count }).success).toBe(false);
  });
});

describe("error shape", () => {
  it("accepts every known code and rejects unknown ones", () => {
    for (const code of ERROR_CODES)
      expect(apiError.safeParse({ error: { code, message: "m" } }).success).toBe(true);
    expect(apiError.safeParse({ error: { code: "bogus", message: "m" } }).success).toBe(false);
  });
});
