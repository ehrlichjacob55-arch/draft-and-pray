import { beforeAll, describe, expect, it } from "vitest";
import { createDynamo, type Dynamo } from "@dnp/db";
import { createTestDynamo, testEndpoint } from "@dnp/db/testing";
import { loadConfig } from "./config";
import { createApp } from "./http/app";

let db: Dynamo;
beforeAll(async () => {
  db = await createTestDynamo("api");
});

describe("http app", () => {
  it("GET /api/health returns ok with db ok", async () => {
    const app = createApp({ config: loadConfig({}), db });
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", env: "local", db: "ok" });
  });

  it("GET /api/health returns 503 with db error when DynamoDB is unreachable", async () => {
    const bad = createDynamo({ tableName: "nope", endpoint: "http://127.0.0.1:1" });
    const app = createApp({ config: loadConfig({}), db: bad });
    const res = await app.request("/api/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "ok", env: "local", db: "error" });
  });

  it("uses the shared test endpoint", () => {
    expect(testEndpoint()).toMatch(/^http:\/\/localhost:\d+$/);
  });

  it("GET /api/me returns user null for an unknown local dev user", async () => {
    const app = createApp({ config: loadConfig({}), db });
    const res = await app.request("/api/me");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null, leagues: [], justClaimed: [] });
  });

  it("rejects /api/me without a token when Cognito is configured", async () => {
    const app = createApp({
      config: loadConfig({ COGNITO_USER_POOL_ID: "us-east-1_abc123", COGNITO_CLIENT_ID: "client" }),
      db,
    });
    expect((await app.request("/api/me")).status).toBe(401);
    expect((await app.request("/api/health")).status).toBe(200);
  });

  it("returns JSON 404s", async () => {
    const app = createApp({ config: loadConfig({}), db });
    const res = await app.request("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not Found" } });
  });
});
