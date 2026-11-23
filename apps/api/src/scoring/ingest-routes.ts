/** Live-stats routes (docs/design/12): the commissioner's switch, status and "Refresh now". */
import {
  setIngestRequest,
  type IngestGame,
  type IngestResponse,
  type IngestRound,
} from "@dnp/contract";
import {
  DomainError,
  auditIngestRun,
  getIngestState,
  listGames,
  listRounds,
  setIngestEnabled,
  type Dynamo,
} from "@dnp/db";
import type { Hono } from "hono";
import type { LiveSource } from "../providers";
import type { Publisher } from "../realtime/types";
import { logError } from "../redact";
import type { AppEnv } from "../http/auth";
import { loadSeasonMeta, requireCommissioner } from "../http/authz";
import { parseBody } from "../http/errors";
import { runIngest } from "./ingest";
import { scoresPublisher } from "./publish";

export interface IngestRouteDeps {
  db: Dynamo;
  now: () => Date;
  source: LiveSource;
  publisher: Publisher;
}

const GAME_STATUSES = ["scheduled", "in_progress", "final"] as const;

/** The commissioner's view: registry state plus every round with its games. */
export async function ingestView(db: Dynamo, seasonId: string): Promise<IngestResponse> {
  const [state, rounds, games] = await Promise.all([
    getIngestState(db, seasonId),
    listRounds(db, seasonId),
    listGames(db, seasonId),
  ]);
  return {
    enabled: state?.enabled ?? false,
    nextPollAt: state?.nextPollAt ?? null,
    lastRunAt: state?.lastRunAt ?? null,
    lastSuccessAt: state?.lastSuccessAt ?? null,
    lastError: state?.lastError ?? null,
    lastSummary: state?.lastSummary ?? null,
    warnings: state?.warnings ?? [],
    rounds: rounds
      .sort((a, b) => a.round - b.round)
      .map((r): IngestRound => ({
        round: r.round,
        code: r.code,
        status: r.status,
        games: games
          .filter((g) => g.round === r.round)
          .sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.gameId.localeCompare(b.gameId))
          .map((g): IngestGame => ({
            gameId: g.gameId,
            home: g.home,
            away: g.away,
            homeScore: g.homeScore,
            awayScore: g.awayScore,
            status: (GAME_STATUSES as readonly string[]).includes(g.status)
              ? (g.status as IngestGame["status"])
              : "scheduled",
            kickoff: g.kickoff,
          })),
      })),
  };
}

export function registerIngestRoutes(app: Hono<AppEnv>, deps: IngestRouteDeps) {
  const { db, now, source, publisher } = deps;

  const commissioner = async (seasonId: string, user: AppEnv["Variables"]["user"]) => {
    const season = await loadSeasonMeta(db, seasonId);
    await requireCommissioner(db, season.leagueId, user);
    return season;
  };

  app.get("/seasons/:seasonId/ingest", async (c) => {
    const season = await commissioner(c.req.param("seasonId"), c.get("user"));
    return c.json(await ingestView(db, season.seasonId));
  });

  app.put("/seasons/:seasonId/ingest", async (c) => {
    const user = c.get("user");
    const season = await commissioner(c.req.param("seasonId"), user);
    const { enabled } = await parseBody(c, setIngestRequest);
    await setIngestEnabled(db, {
      seasonId: season.seasonId,
      leagueId: season.leagueId,
      year: season.year,
      enabled,
      actorUserId: user.sub,
      now: now().toISOString(),
    });
    return c.json(await ingestView(db, season.seasonId));
  });

  // Runs one ingest inline (the HTTP Lambda allows 29 s; summaries are fetched 4 at a time). A
  // failed run is not an HTTP error: the response carries `lastError` for the UI to show.
  app.post("/seasons/:seasonId/ingest/run", async (c) => {
    const user = c.get("user");
    const season = await commissioner(c.req.param("seasonId"), user);
    let busy = false;
    try {
      const result = await runIngest({
        db,
        seasonId: season.seasonId,
        now: now(),
        source,
        publish: scoresPublisher(publisher, season.seasonId, now),
      });
      busy = result.busy;
    } catch (err) {
      logError("Manual stats refresh failed", err, { seasonId: season.seasonId });
    }
    if (busy)
      throw new DomainError("ingest_busy", "A stats update is already running. Try again shortly.");
    await auditIngestRun(db, {
      seasonId: season.seasonId,
      actorUserId: user.sub,
      now: now().toISOString(),
    });
    return c.json(await ingestView(db, season.seasonId));
  });
}
