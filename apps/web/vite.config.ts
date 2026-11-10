import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Overridable so a second stack (e.g. e2e) can run next to `pnpm dev`.
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: { "/api": `http://localhost:${process.env.API_PORT ?? 3001}` },
  },
  test: {
    name: "web",
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
