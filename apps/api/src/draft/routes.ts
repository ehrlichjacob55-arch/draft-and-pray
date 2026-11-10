/** Draft, pool and realtime-ticket routes (docs/design/14 §3, §4, §6). */
import {
  addPlayerRequest,
  autoDraftRequest,
  autopickRequest,
  importPoolRequest,
  makePickRequest,
  queueRequest,
  setOrderRequest,
  startClockRequest,
  updatePlayerRequest,
  type ImportPoolResponse,
  type ListPlayersResponse,
  type RealtimeTicketResponse,
} from "@dnp/contract";
import {
  DomainError,
  addManualPlayer,
  createWsTicket,
  getPoolImport,
  importPool,
  listNflTeams,
  listPlayers,
  setPlayerInPool,
  type Dynamo,
} from "@dnp/db";
import type { Hono } from "hono";
import type { Config } from "../config";
import { PoolSourceError, type PoolSource } from "../providers";
import { logError } from "../redact";
import type { AppEnv } from "../http/auth";
import { loadSeasonMeta, requireCommissioner, requireMember } from "../http/authz";
import { ApiError, parseBody, parseOptionalBody } from "../http/errors";
import type { DraftService } from "./service";
import { toPoolPlayer } from "./snapshot";

export interface DraftRouteDeps {
  db: Dynamo;
  config: Config;
  service: DraftService;
  poolSource: PoolSource;
  now: () => Date;
}

/** `wsUrl` for POST /realtime/ticket: the WebSocket stage URL in AWS, ws://localhost:<port> locally. */
export function publicWsUrl(config: Config): string | undefined {
  if (config.WS_PUBLIC_URL) return config.WS_PUBLIC_URL;
  if (config.APP_ENV === "local") return `ws://localhost:${config.WS_PORT ?? "3002"}`;
  return undefined;
}

export function registerDraftRoutes(app: Hono<AppEnv>, deps: DraftRouteDeps) {
  const { db, config, service, poolSource, now } = deps;

  /** Loads the season and the caller's membership (404 / 403 otherwise). */
  const member = async (seasonId: string, user: AppEnv["Variables"]["user"]) => {
    const season = await loadSeasonMeta(db, seasonId);
    const m = await requireMember(db, season.leagueId, user);
    return { season, actor: { userId: user.sub, role: m.role } };
  };
  const commissioner = async (seasonId: string, user: AppEnv["Variables"]["user"]) => {
    const season = await loadSeasonMeta(db, seasonId);
    await requireCommissioner(db, season.leagueId, user);
    return { season, actor: { userId: user.sub, role: "commissioner" as const } };
  };

  // ---- Snapshot ----
  app.get("/seasons/:seasonId/draft", async (c) => {
    const { season, actor } = await member(c.req.param("seasonId"), c.get("user"));
    return c.json(await service.snapshot(season, actor));
  });

  // ---- Commissioner lifecycle ----
  app.put("/seasons/:seasonId/draft/order", async (c) => {
    const { season, actor } = await commissioner(c.req.param("seasonId"), c.get("user"));
    const { order } = await parseBody(c, setOrderRequest);
    return c.json(await service.setOrder(season, actor, order));
  });
  app.post("/seasons/:seasonId/draft/start", async (c) => {
    const { season, actor } = await commissioner(c.req.param("seasonId"), c.get("user"));
    return c.json(await service.start(season, actor));
  });
  app.post("/seasons/:seasonId/draft/pause", async (c) => {
    const { season, actor } = await commissioner(c.req.param("seasonId"), c.get("user"));
    return c.json(await service.pause(season, actor));
  });
  app.post("/seasons/:seasonId/draft/resume", async (c) => {
    const { season, actor } = await commissioner(c.req.param("seasonId"), c.get("user"));
    return c.json(await service.resume(season, actor));
  });
  app.post("/seasons/:seasonId/draft/clock", async (c) => {
    const { season, actor } = await commissioner(c.req.param("seasonId"), c.get("user"));
    const { expectedPick } = await parseOptionalBody(c, startClockRequest);
    return c.json(await service.startPickClock(season, actor, expectedPick));
  });
  app.delete("/seasons/:seasonId/draft/clock", async (c) => {
    const { season, actor } = await commissioner(c.req.param("seasonId"), c.get("user"));
    return c.json(await service.clearPickClock(season, actor));
  });
  app.post("/seasons/:seasonId/draft/autopick", async (c) => {
    const { season, actor } = await commissioner(c.req.param("seasonId"), c.get("user"));
    const { expectedPick } = await parseBody(c, autopickRequest);
    return c.json(await service.autopick(season, actor, expectedPick));
  });
  app.post("/seasons/:seasonId/draft/undo", async (c) => {
    const { season, actor } = await commissioner(c.req.param("seasonId"), c.get("user"));
    return c.json(await service.undo(season, actor));
  });

  // ---- Picks ----
  app.post("/seasons/:seasonId/draft/picks", async (c) => {
    const { season, actor } = await member(c.req.param("seasonId"), c.get("user"));
    const body = await parseBody(c, makePickRequest);
    return c.json(await service.pick(season, actor, body));
  });

  // ---- Team-owner settings ----
  app.get("/seasons/:seasonId/draft/queue", async (c) => {
    const { season, actor } = await member(c.req.param("seasonId"), c.get("user"));
    return c.json({ playerIds: await service.readQueue(season, actor) });
  });
  app.put("/seasons/:seasonId/draft/queue", async (c) => {
    const { season, actor } = await member(c.req.param("seasonId"), c.get("user"));
    const { playerIds } = await parseBody(c, queueRequest);
    return c.json({ playerIds: await service.writeQueue(season, actor, playerIds) });
  });
  app.put("/seasons/:seasonId/draft/auto-draft", async (c) => {
    const { season, actor } = await member(c.req.param("seasonId"), c.get("user"));
    const { enabled } = await parseBody(c, autoDraftRequest);
    return c.json(await service.setAuto(season, actor, enabled));
  });

  // ---- Player pool ----
  const poolView = async (seasonId: string): Promise<ListPlayersResponse> => {
    const [nflTeams, players, last] = await Promise.all([
      listNflTeams(db, seasonId),
      listPlayers(db, seasonId),
      getPoolImport(db, seasonId),
    ]);
    const seeds = new Map(nflTeams.map((t) => [t.abbr, t.seed]));
    return {
      teams: nflTeams.map((t) => ({
        abbr: t.abbr,
        name: t.name ?? t.abbr,
        conference: t.conference,
        seed: t.seed,
      })),
      players: players
        .map((p) => toPoolPlayer(p, seeds))
        .sort((a, b) => a.name.localeCompare(b.name, "en") || a.playerId.localeCompare(b.playerId)),
      lastImport: last
        ? {
            importedAt: last.importedAt,
            source: last.source,
            seasonYear: last.seasonYear,
            counts: last.counts,
          }
        : null,
    };
  };

  app.get("/seasons/:seasonId/players", async (c) => {
    const { season } = await member(c.req.param("seasonId"), c.get("user"));
    return c.json(await poolView(season.seasonId));
  });

  const onePlayer = async (seasonId: string, playerId: string) => {
    const view = await poolView(seasonId);
    const p = view.players.find((x) => x.playerId === playerId);
    if (!p) throw new DomainError("not_found", "Player not found");
    return p;
  };

  app.patch("/seasons/:seasonId/players/:playerId", async (c) => {
    const { season, actor } = await commissioner(c.req.param("seasonId"), c.get("user"));
    const { inPool } = await parseBody(c, updatePlayerRequest);
    await setPlayerInPool(db, {
      seasonId: season.seasonId,
      playerId: c.req.param("playerId"),
      inPool,
      actorUserId: actor.userId,
      now: now().toISOString(),
    });
    await service.emit(season.seasonId, "status");
    return c.json(await onePlayer(season.seasonId, c.req.param("playerId")));
  });

  app.post("/seasons/:seasonId/players", async (c) => {
    const { season, actor } = await commissioner(c.req.param("seasonId"), c.get("user"));
    const body = await parseBody(c, addPlayerRequest);
    const added = await addManualPlayer(db, {
      seasonId: season.seasonId,
      name: body.name,
      position: body.position,
      nflTeam: body.nflTeam,
      injuryStatus: body.injuryStatus ?? null,
      actorUserId: actor.userId,
      now: now().toISOString(),
    });
    await service.emit(season.seasonId, "status");
    return c.json(await onePlayer(season.seasonId, added.playerId), 201);
  });

  app.post("/seasons/:seasonId/pool/import", async (c) => {
    const { season, actor } = await commissioner(c.req.param("seasonId"), c.get("user"));
    const { seasonYear } = await parseBody(c, importPoolRequest);
    let data;
    try {
      data = await poolSource.load(seasonYear);
    } catch (err) {
      logError("Pool source failed", err);
      throw new DomainError(
        "pool_import_failed",
        err instanceof PoolSourceError ? err.message : "The player pool source failed",
      );
    }
    const importedAt = now().toISOString();
    const counts = await importPool(db, {
      seasonId: season.seasonId,
      seasonYear,
      source: poolSource.source,
      teams: data.teams,
      players: data.players,
      actorUserId: actor.userId,
      now: importedAt,
    });
    await service.emit(season.seasonId, "status");
    return c.json({
      source: poolSource.source,
      seasonYear,
      importedAt,
      counts,
      ...(data.warnings?.length ? { warnings: data.warnings } : {}),
    } satisfies ImportPoolResponse);
  });

  // ---- Realtime ticket (any signed-in user) ----
  app.post("/realtime/ticket", async (c) => {
    const wsUrl = publicWsUrl(config);
    if (!wsUrl) throw new ApiError(503, "internal_error", "Realtime is not configured");
    const ticket = await createWsTicket(db, { userId: c.get("user").sub, now: now() });
    return c.json({ ticket, wsUrl } satisfies RealtimeTicketResponse);
  });
}
