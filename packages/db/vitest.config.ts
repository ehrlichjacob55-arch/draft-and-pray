import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "db",
    include: ["src/**/*.test.ts"],
    globalSetup: ["./src/testing/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
