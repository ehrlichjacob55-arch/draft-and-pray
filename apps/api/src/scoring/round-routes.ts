/**
 * Commissioner stat overrides and round finalization, plus the members' standings
 * (docs/design/04 §5-7, 10 §4.4/§4.7). Every commissioner write commits with its AUDIT item.
 */
import {
  setOverrideRequest,
  unfreezeRoundRequest,
  type GameLinesResponse,
  type StandingsResponse,
} from "@dnp/contract";
import {
  DomainError,
  clearOverride,
  finalizeRound,
  listRoundTeamScores,
  loadSeason,
  setOverride,
  unfreezeRound,
  type Dynamo,
  type SeasonSnapshot,
} from "@dnp/db";
import {
  PLAYOFF_ROUNDS,
  applyOverrides,
  computeStandings,
  isStatKey,
  latestStartedRound,
  parseRuleset,
  type RoundInfo,
} from "@dnp/domain";
import type { Hono } from "hono";
import type { Publisher } from "../realtime/types";
import { logError } from "../redact";
import type { AppEnv } from "../http/auth";
import { loadSeasonMeta, requireCommissioner, requireMember } from "../http/authz";
import { ApiError, notFound, parseBody } from "../http/errors";
import { buildGameLines, overridesOf, providerLine } from "./game-lines";
import { ingestView } from "./ingest-routes";
import { scoresPublisher } from "./publish";
import { recomputeSeason } from "./recompute";

export interface RoundRouteDeps {
  db: Dynamo;
  now: () => Date;
  publisher: Publisher;
}

const DEFAULT_ROUNDING = 2;

/** The four rounds with their status (a round without a ROUND item is upcoming). */
export const roundsOf = (
  snap: SeasonSnapshot,
): (RoundInfo & { code: (typeof PLAYOFF_ROUNDS)[number] })[] =>
  PLAYOFF_ROUNDS.map((code, i) => ({
    round: i + 1,
    code,
    status: snap.rounds.find((r) => r.round === i + 1)?.status ?? "upcoming",
  }));

/** Members' standings (docs/design/04 §5, 06 §5): one season load plus the pure `computeStandings`. */
export function buildStandings(snap: SeasonSnapshot): StandingsResponse {
  const rounds = roundsOf(snap);
  const active = snap.rulesets.find((r) => r.version === snap.meta?.activeRulesetVersion);
  const rounding = active
    ? parseRuleset({ ...active.rules, version: active.version }).rounding
    : DEFAULT_ROUNDING;
  const rows = computeStandings({
    rounding,
    teams: snap.teams.map((t) => ({
      teamId: t.teamId,
      assignments: snap.rosterEntries
        .filter((e) => e.teamId === t.teamId)
        .map((e) => ({ slot: e.slot, playerId: e.playerId, fromRound: e.fromRound })),
    })),
    teamScores: snap.teamScores,
    rounds,
    games: snap.games.map((g) => ({
      gameId: g.gameId,
      round: g.round,
      home: g.home,
      away: g.away,
      status: g.status,
    })),
    players: snap.players.map((p) => ({
      playerId: p.playerId,
      position: p.position,
      nflTeam: p.nflTeam,
    })),
    nflTeams: snap.nflTeams.map((t) => ({ abbr: t.abbr, status: t.status })),
  });
  const teams = new Map(snap.teams.map((t) => [t.teamId, t]));
  const out = rows
    .map((r) => ({
      rank: r.rank,
      tied: r.tied,
      teamId: r.teamId,
      teamName: teams.get(r.teamId)?.name ?? "",
      teamAbbr: teams.get(r.teamId)?.abbr ?? "",
      rounds: rounds.map(({ round, status }) => {
        const s = snap.teamScores.find((x) => x.round === round && x.teamId === r.teamId);
        // A round that has not started shows a dash even though it has its zero row.
        return status === "upcoming" || !s
          ? { round, points: null, provisional: false }
          : { round, points: s.points, provisional: s.provisional };
      }),
      total: r.total,
      playersAlive: r.playersAlive,
      playersTotal: r.playersTotal,
      maxGamesRemaining: r.maxGamesRemaining,
    }))
    .sort((a, b) => a.rank - b.rank || a.teamName.localeCompare(b.teamName));
  const finished = rounds[3]?.status === "finalized";
  return {
    asOf: latestStartedRound(rounds),
    rounds: rounds.map(({ round, code, status }) => ({ round, code, status })),
    rows: out,
    placings: finished
      ? out
          .filter((r) => r.rank <= 3)
          .map((r) => ({ place: r.rank as 1 | 2 | 3, teamId: r.teamId }))
      : null,
  };
}

export function registerRoundRoutes(app: Hono<AppEnv>, deps: RoundRouteDeps) {
  const { db, now, publisher } = deps;

  const commissioner = async (seasonId: string, user: AppEnv["Variables"]["user"]) => {
    const season = await loadSeasonMeta(db, seasonId);
    await requireCommissioner(db, season.leagueId, user);
    return season;
  };
  const recompute = (seasonId: string) =>
    recomputeSeason(db, seasonId, scoresPublisher(publisher, seasonId, now), now());
  /** After an audited write: a failed recompute is logged; the next ingest run catches up. */
  const recomputeBestEffort = async (seasonId: string) => {
    try {
      await recompute(seasonId);
    } catch (err) {
      logError("Recompute after a commissioner change failed", err, { seasonId });
    }
  };
  const roundParam = (raw: string | undefined): number => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 4) throw notFound("Round not found");
    return n;
  };
  const gameBody = async (seasonId: string, gameId: string): Promise<GameLinesResponse> => {
    const body = buildGameLines(await loadSeason(db, seasonId, { consistentRead: true }), gameId);
    if (!body) throw notFound("Game not found");
    return body;
  };

  // ---- Members: standings ----
  app.get("/seasons/:seasonId/standings", async (c) => {
    const season = await loadSeasonMeta(db, c.req.param("seasonId"));
    await requireMember(db, season.leagueId, c.get("user"));
    return c.json(
      buildStandings(await loadSeason(db, season.seasonId)) satisfies StandingsResponse,
    );
  });

  // ---- Commissioner: one game's lines ----
  app.get("/seasons/:seasonId/games/:gameId/lines", async (c) => {
    const season = await commissioner(c.req.param("seasonId"), c.get("user"));
    return c.json(await gameBody(season.seasonId, c.req.param("gameId")));
  });

  app.put("/seasons/:seasonId/overrides", async (c) => {
    const user = c.get("user");
    const season = await commissioner(c.req.param("seasonId"), user);
    const body = await parseBody(c, setOverrideRequest);
    const snap = await loadSeason(db, season.seasonId, { consistentRead: true });
    const game = snap.games.find((g) => g.gameId === body.gameId);
    if (!game) throw notFound("Game not found");
    if (!isStatKey(body.statKey))
      throw new ApiError(400, "validation_error", `${body.statKey} is not a stat key`);
    const player = snap.players.find((p) => p.playerId === body.playerId);
    if (!player || ![game.home, game.away].includes(player.nflTeam))
      throw new ApiError(
        400,
        "validation_error",
        "That player is not in the pool or not on one of this game's teams",
      );
    // The domain rule decides what a value means (e.g. field goals above the recorded distances).
    const provider = providerLine(snap, body.gameId, body.playerId) ?? { counts: {} };
    const current = overridesOf(snap, body.gameId, body.playerId);
    let from: number;
    try {
      from = applyOverrides(provider, current).statLine.counts[body.statKey] ?? 0;
      applyOverrides(provider, { ...current, [body.statKey]: body.value });
    } catch (err) {
      throw new ApiError(400, "validation_error", (err as Error).message);
    }
    const status = snap.rounds.find((r) => r.round === game.round)?.status;
    if (status === "finalized")
      throw new DomainError(
        "round_finalized",
        "This round is finalized. Unfreeze the round first.",
      );
    await setOverride(db, {
      seasonId: season.seasonId,
      round: game.round,
      gameId: body.gameId,
      playerId: body.playerId,
      statKey: body.statKey,
      value: body.value,
      reason: body.reason,
      from,
      actorUserId: user.sub,
      now: now().toISOString(),
    });
    await recomputeBestEffort(season.seasonId);
    return c.json(await gameBody(season.seasonId, body.gameId));
  });

  app.delete("/seasons/:seasonId/overrides/:gameId/:playerId/:statKey", async (c) => {
    const user = c.get("user");
    const season = await commissioner(c.req.param("seasonId"), user);
    const { gameId, playerId, statKey } = c.req.param();
    const snap = await loadSeason(db, season.seasonId, { consistentRead: true });
    const game = snap.games.find((g) => g.gameId === gameId);
    if (!game) throw notFound("Game not found");
    if (snap.rounds.find((r) => r.round === game.round)?.status === "finalized")
      throw new DomainError(
        "round_finalized",
        "This round is finalized. Unfreeze the round first.",
      );
    const existing = snap.overrides.find(
      (o) => o.gameId === gameId && o.playerId === playerId && o.statKey === statKey,
    );
    if (!existing) throw notFound("Override not found");
    await clearOverride(db, {
      seasonId: season.seasonId,
      round: game.round,
      gameId,
      playerId,
      statKey,
      from: existing.value,
      actorUserId: user.sub,
      now: now().toISOString(),
    });
    await recomputeBestEffort(season.seasonId);
    return c.json(await gameBody(season.seasonId, gameId));
  });

  // ---- Commissioner: finalize / unfreeze (docs/design/04 §6) ----
  app.post("/seasons/:seasonId/rounds/:round/finalize", async (c) => {
    const user = c.get("user");
    const season = await commissioner(c.req.param("seasonId"), user);
    const round = roundParam(c.req.param("round"));
    const status = (await loadSeason(db, season.seasonId, { consistentRead: true })).rounds.find(
      (r) => r.round === round,
    )?.status;
    if (!status) throw notFound("Round not found");
    if (status === "finalized")
      throw new DomainError("round_finalized", "This round is already finalized.");
    if (status !== "final")
      throw new DomainError(
        "round_not_final",
        "A round can be finalized once all its games are final.",
      );
    // Take in the latest stats and overrides first, then freeze exactly what that produced.
    await recompute(season.seasonId);
    await finalizeRound(db, {
      seasonId: season.seasonId,
      round,
      actorUserId: user.sub,
      now: now().toISOString(),
      teamScores: await listRoundTeamScores(db, season.seasonId, round),
    });
    await scoresPublisher(publisher, season.seasonId, now)();
    return c.json(await ingestView(db, season.seasonId));
  });

  app.post("/seasons/:seasonId/rounds/:round/unfreeze", async (c) => {
    const user = c.get("user");
    const season = await commissioner(c.req.param("seasonId"), user);
    const round = roundParam(c.req.param("round"));
    const { reason } = await parseBody(c, unfreezeRoundRequest);
    await unfreezeRound(db, {
      seasonId: season.seasonId,
      round,
      reason,
      actorUserId: user.sub,
      now: now().toISOString(),
    });
    await recomputeBestEffort(season.seasonId);
    return c.json(await ingestView(db, season.seasonId));
  });
}
