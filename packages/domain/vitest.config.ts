import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "domain",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/draft-order.ts", "src/slot-eligibility.ts", "src/autopick.ts", "src/rank.ts"],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
    },
  },
});
