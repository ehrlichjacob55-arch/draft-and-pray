import { describe, expect, it } from "vitest";
import {
  ERROR_CODES,
  MAX_TEAMS,
  addManagerRequest,
  apiError,
  emailSchema,
  normalizeEmail,
  updateManagerRequest,
  meResponse,
  seasonResponse,
  renameTeamRequest,
  teamNameKey,
  teamNameSchema,
} from "./index";

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Jane.Doe@Gmail.COM \n")).toBe("jane.doe@gmail.com");
  });
});

describe("emailSchema", () => {
  it("normalizes valid emails", () => {
    expect(emailSchema.parse(" A@B.co ")).toBe("a@b.co");
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
  it("is used by the rename request", () => {
    expect(renameTeamRequest.safeParse({ name: " " }).success).toBe(false);
    expect(renameTeamRequest.parse({ name: " ok " })).toEqual({ name: "ok" });
  });
});

describe("manager requests", () => {
  it("normalizes and trims an add request", () => {
    expect(
      addManagerRequest.parse({
        firstName: " Alex ",
        lastName: "Example",
        email: " A@Example.com ",
      }),
    ).toEqual({ firstName: "Alex", lastName: "Example", email: "a@example.com" });
    expect(MAX_TEAMS).toBe(9);
  });
  it.each([
    { firstName: "", lastName: "E", email: "a@example.com" },
    { firstName: "A", lastName: " ", email: "a@example.com" },
    { firstName: "A", lastName: "E", email: "nope" },
    { firstName: "A", lastName: "E" },
  ])("rejects %j", (bad) => {
    expect(addManagerRequest.safeParse(bad).success).toBe(false);
  });
  it("accepts only URL-safe test temporary passwords", () => {
    const base = { firstName: "A", lastName: "B", email: "a@example.com" };
    expect(
      addManagerRequest.safeParse({ ...base, testTemporaryPassword: "Abc-def_1.2~xyz" }).success,
    ).toBe(true);
    for (const bad of ["Abc&def#12345", "Abc def 12345", "Abc+def%12345", "Short1-"])
      expect(addManagerRequest.safeParse({ ...base, testTemporaryPassword: bad }).success).toBe(
        false,
      );
  });
  it("needs at least one field to update", () => {
    expect(updateManagerRequest.safeParse({}).success).toBe(false);
    expect(updateManagerRequest.safeParse({ lastName: "New" }).success).toBe(true);
  });
});

describe("member-facing shapes carry no PII fields", () => {
  it("season teams are {teamId, name, isMine}", () => {
    const parsed = seasonResponse.shape.teams.element.parse({
      teamId: "t",
      name: "Team Example",
      isMine: false,
      email: "x@example.com",
      firstName: "Alex",
    });
    expect(Object.keys(parsed).sort()).toEqual(["isMine", "name", "teamId"]);
  });
  it("/me requires justClaimed", () => {
    expect(meResponse.safeParse({ user: null, leagues: [] }).success).toBe(false);
    expect(meResponse.safeParse({ user: null, leagues: [], justClaimed: [] }).success).toBe(true);
  });
});

describe("error shape", () => {
  it("accepts every known code and rejects unknown ones", () => {
    for (const code of ERROR_CODES)
      expect(apiError.safeParse({ error: { code, message: "m" } }).success).toBe(true);
    expect(apiError.safeParse({ error: { code: "bogus", message: "m" } }).success).toBe(false);
  });
});
