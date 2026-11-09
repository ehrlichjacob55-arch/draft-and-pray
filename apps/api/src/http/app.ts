import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Dynamo } from "@dnp/db";
import type { Config } from "../config";
import { authMiddleware, type AppEnv } from "./auth";

export interface AppDeps {
  config: Config;
  db: Dynamo;
}

export function createApp({ config, db }: AppDeps) {
  const app = new Hono<AppEnv>().basePath("/api");

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    console.error("Unhandled error", err);
    return c.json({ error: "Internal Server Error" }, 500);
  });
  app.notFound((c) => c.json({ error: "Not Found" }, 404));

  const auth = authMiddleware(config);
  app.use("*", async (c, next) => {
    if (c.req.path === "/api/health") return next();
    return auth(c, next);
  });

  app.get("/health", async (c) => {
    let dbStatus: "ok" | "error" = "ok";
    try {
      // No item is expected; a successful call proves connectivity and needs no extra IAM beyond GetItem.
      await db.doc.send(
        new GetCommand({ TableName: db.tableName, Key: { pk: "HEALTH", sk: "HEALTH" } }),
      );
    } catch (err) {
      console.error("Health check db error", err);
      dbStatus = "error";
    }
    return c.json(
      { status: "ok", env: config.APP_ENV, db: dbStatus },
      dbStatus === "ok" ? 200 : 503,
    );
  });

  app.get("/me", (c) => c.json({ user: c.get("user") }));

  return app;
}

export type App = ReturnType<typeof createApp>;
