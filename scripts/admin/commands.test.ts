import { describe, expect, it } from "vitest";
import { runAdmin, type Deps } from "./commands";
import {
  assertTestEnv,
  isNewTestUserEmail,
  isTestUserEmail,
  newTestUserEmail,
  resolveEnvConfig,
} from "../lib/env";

/** Deps that fail the test if anything tries to resolve a config (i.e. reach for AWS). */
const noAws: Deps & { calls: number } = {
  calls: 0,
  resolveConfig() {
    noAws.calls++;
    throw new Error("resolveConfig must not be called for prod");
  },
  log: () => {},
};

describe("prod refusal", () => {
  it("assertTestEnv rejects prod and unknown envs, accepts dev/test and (optionally) local", () => {
    expect(() => assertTestEnv("prod", true)).toThrow(/prod/);
    expect(() => assertTestEnv("prod", false)).toThrow(/prod/);
    expect(() => assertTestEnv("staging", true)).toThrow(/--env/);
    expect(() => assertTestEnv(undefined, true)).toThrow(/--env/);
    expect(assertTestEnv("dev", false)).toBe("dev");
    expect(assertTestEnv("test", false)).toBe("test");
    expect(assertTestEnv("local", true)).toBe("local");
    expect(() => assertTestEnv("local", false)).toThrow();
  });

  it.each([
    ["test-users", "create"],
    ["test-users", "delete"],
    ["test-league", "seed"],
    ["test-league", "reset"],
    ["seed-pool", undefined],
    ["draft-league", "setup"],
  ])("%s %s --env prod is refused before resolving config or touching AWS", async (cmd, sub) => {
    await expect(runAdmin([cmd, ...(sub ? [sub] : []), "--env", "prod"], noAws)).rejects.toThrow(
      /Refusing.*prod/,
    );
    expect(noAws.calls).toBe(0);
  });

  it("resolveEnvConfig for local never consults Terraform", () => {
    const cfg = resolveEnvConfig("local", {}, () => {
      throw new Error("terraform must not run");
    });
    expect(cfg).toMatchObject({ env: "local", tableName: "dnp-local-app" });
  });
});

describe("test-user email patterns", () => {
  it("recognizes generated test users and fresh dnp-new users only", () => {
    expect(isTestUserEmail("dnp-test-01@example.com")).toBe(true);
    expect(isTestUserEmail("dnp-new-ab12cd34-1@example.com")).toBe(true);
    expect(isNewTestUserEmail(newTestUserEmail("ab12cd34", 2))).toBe(true);
    for (const bad of ["dnp-new-x@gmail.com", "someone@example.com", "dnp-new-@example.com"])
      expect(isTestUserEmail(bad)).toBe(false);
  });
});
