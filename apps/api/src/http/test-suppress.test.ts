import { describe, expect, it } from "vitest";
import { resolveTestSuppress, testModeAllowed } from "./test-suppress";

const ok = {
  config: { APP_ENV: "dev" as const },
  user: { groups: ["test-users"] },
  testSuppressQuery: "1",
  testTemporaryPassword: "Temp-Pass-123",
};

describe("resolveTestSuppress", () => {
  it("allows non-prod + test-users + flag + password", () => {
    for (const APP_ENV of ["local", "dev", "test"] as const)
      expect(resolveTestSuppress({ ...ok, config: { APP_ENV } })).toEqual({
        temporaryPassword: "Temp-Pass-123",
      });
  });
  it.each([
    ["prod", { config: { APP_ENV: "prod" as const } }],
    ["no groups", { user: {} }],
    ["other group", { user: { groups: ["admins"] } }],
    ["flag missing", { testSuppressQuery: undefined }],
    ["flag not 1", { testSuppressQuery: "true" }],
    ["password missing", { testTemporaryPassword: undefined }],
    ["empty password", { testTemporaryPassword: "" }],
  ])("denies: %s", (_name, override) => {
    expect(resolveTestSuppress({ ...ok, ...override })).toBeUndefined();
  });
  it("testModeAllowed ignores the password but keeps every other gate", () => {
    expect(testModeAllowed(ok)).toBe(true);
    expect(testModeAllowed({ ...ok, config: { APP_ENV: "prod" } })).toBe(false);
    expect(testModeAllowed({ ...ok, user: { groups: [] } })).toBe(false);
    expect(testModeAllowed({ ...ok, testSuppressQuery: undefined })).toBe(false);
  });
});
