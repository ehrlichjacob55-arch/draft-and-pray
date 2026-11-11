/** Scoring-config routes (docs/design/04 §2, 06 §7): the season's versioned ruleset. */
import {
  createScoringVersionRequest,
  seedScoringRequest,
  updateScoringRequest,
  type RuleError,
  type ScoringResponse,
} from "@dnp/contract";
import {
  DomainError,
  createRulesetVersion,
  getRuleset,
  getSeasonMeta,
  listRulesets,
  lockRuleset,
  setActiveRuleset,
  updateRuleset,
  type Dynamo,
  type StoredRuleset,
} from "@dnp/db";
import { BUILTIN_RULESETS, safeParseRuleset } from "@dnp/domain";
import type { Hono } from "hono";
import type { AppEnv } from "../http/auth";
import { loadSeasonMeta, requireCommissioner, requireMember } from "../http/authz";
import { ApiError, notFound, parseBody } from "../http/errors";
import type { RulesetChangeHook } from "./hooks";

export interface ScoringRouteDeps {
  db: Dynamo;
  now: () => Date;
  onRulesetChange: RulesetChangeHook;
}

/** Validates the editable part of a ruleset; 400 with one `ruleErrors` entry per problem. */
export function validateRuleset(body: { rules: unknown[]; rounding: number }, name?: unknown) {
  const json = {
    rounding: body.rounding,
    rules: body.rules,
    ...(typeof name === "string" ? { name } : {}),
  };
  const parsed = safeParseRuleset({ ...json, version: 1 });
  if (parsed.ok) return json;
  const ruleErrors: RuleError[] = parsed.issues.map((i) => {
    const rule = i.ruleIndex === undefined ? undefined : body.rules[i.ruleIndex];
    const stat = (rule as { stat?: unknown } | null | undefined)?.stat;
    return {
      ruleIndex: i.ruleIndex ?? null,
      stat: typeof stat === "string" ? stat : null,
      message: i.field ? `${i.field}: ${i.message}` : i.message,
    };
  });
  const n = ruleErrors.length;
  throw new ApiError(
    400,
    "validation_error",
    `The scoring rules have ${n} problem${n === 1 ? "" : "s"}: ${parsed.errors[0]}`,
    ruleErrors,
  );
}

export function registerScoringRoutes(app: Hono<AppEnv>, deps: ScoringRouteDeps) {
  const { db, now, onRulesetChange } = deps;

  const versionParam = (raw: string | undefined): number => {
    const v = Number(raw);
    if (!Number.isInteger(v) || v < 1) throw notFound("Ruleset version not found");
    return v;
  };

  const state = async (seasonId: string, forCommissioner: boolean): Promise<ScoringResponse> => {
    const [meta, all] = await Promise.all([
      getSeasonMeta(db, seasonId),
      listRulesets(db, seasonId),
    ]);
    const activeVersion = meta?.activeRulesetVersion;
    const active = all.find((r) => r.item.version === activeVersion);
    return {
      seasonId,
      active: active
        ? {
            version: active.item.version,
            name: active.ruleset.name ?? null,
            rounding: active.ruleset.rounding,
            rules: (active.item.rules.rules ?? []) as Record<string, unknown>[],
            locked: active.item.locked,
            lockedAt: active.item.lockedAt ?? null,
            note: active.item.note ?? null,
          }
        : null,
      versions: all.map(({ item }) => ({
        version: item.version,
        locked: item.locked,
        active: item.version === activeVersion,
        createdAt: item.createdAt,
        note: item.note ?? null,
        lockedAt: item.lockedAt ?? null,
        ...(forCommissioner ? { by: item.createdBy === null ? "system" : "commissioner" } : {}),
      })) as ScoringResponse["versions"],
    };
  };

  const activeVersionOf = async (seasonId: string): Promise<number | undefined> =>
    (await getSeasonMeta(db, seasonId))?.activeRulesetVersion;

  const commissioner = async (seasonId: string, user: AppEnv["Variables"]["user"]) => {
    const season = await loadSeasonMeta(db, seasonId);
    await requireCommissioner(db, season.leagueId, user);
    return season;
  };

  const nameOf = (r: StoredRuleset | undefined) => r?.ruleset.name;

  // ---- Read: any league member ----
  app.get("/seasons/:seasonId/scoring", async (c) => {
    const user = c.get("user");
    const season = await loadSeasonMeta(db, c.req.param("seasonId"));
    const m = await requireMember(db, season.leagueId, user);
    return c.json(await state(season.seasonId, m.role === "commissioner"));
  });

  // ---- Commissioner writes (each is audited by the repo, in the same transaction) ----
  app.post("/seasons/:seasonId/scoring/seed", async (c) => {
    const user = c.get("user");
    const season = await commissioner(c.req.param("seasonId"), c.get("user"));
    const { ruleset } = await parseBody(c, seedScoringRequest);
    if ((await listRulesets(db, season.seasonId)).length > 0)
      throw new DomainError("ruleset_exists", "This season already has scoring rules");
    const created = await createRulesetVersion(db, {
      seasonId: season.seasonId,
      actorUserId: user.sub,
      now: now().toISOString(),
      rules: BUILTIN_RULESETS[ruleset],
      note: `Loaded the ${ruleset} rules`,
    });
    if ((await activeVersionOf(season.seasonId)) !== created.item.version)
      await setActiveRuleset(db, {
        seasonId: season.seasonId,
        actorUserId: user.sub,
        version: created.item.version,
        now: now().toISOString(),
      });
    await onRulesetChange({
      seasonId: season.seasonId,
      version: created.item.version,
      reason: "seed",
    });
    return c.json(await state(season.seasonId, true), 201);
  });

  app.put("/seasons/:seasonId/scoring/versions/:version", async (c) => {
    const user = c.get("user");
    const season = await commissioner(c.req.param("seasonId"), user);
    const version = versionParam(c.req.param("version"));
    const body = await parseBody(c, updateScoringRequest);
    const existing = await getRuleset(db, season.seasonId, version);
    if (!existing) throw notFound("Ruleset version not found");
    const lockedError = new DomainError(
      "ruleset_locked",
      `Version ${version} is locked. Save your changes as a new version instead.`,
    );
    if (existing.item.locked) throw lockedError;
    const rules = validateRuleset(body, nameOf(existing));
    try {
      await updateRuleset(db, {
        seasonId: season.seasonId,
        actorUserId: user.sub,
        now: now().toISOString(),
        version,
        rules,
        ...(body.note !== undefined ? { note: body.note } : {}),
      });
    } catch (err) {
      // Locked between our read and the conditional write.
      if (err instanceof DomainError && err.code === "conflict") throw lockedError;
      throw err;
    }
    if ((await activeVersionOf(season.seasonId)) === version)
      await onRulesetChange({ seasonId: season.seasonId, version, reason: "update" });
    return c.json(await state(season.seasonId, true));
  });

  app.post("/seasons/:seasonId/scoring/versions", async (c) => {
    const user = c.get("user");
    const season = await commissioner(c.req.param("seasonId"), user);
    const body = await parseBody(c, createScoringVersionRequest);
    const active = (await listRulesets(db, season.seasonId)).find(
      (r) => r.item.version === season.activeRulesetVersion,
    );
    const rules = validateRuleset(body, nameOf(active));
    const created = await createRulesetVersion(db, {
      seasonId: season.seasonId,
      actorUserId: user.sub,
      now: now().toISOString(),
      rules,
      ...(body.note ? { note: body.note } : {}),
    });
    if (body.activate) {
      await setActiveRuleset(db, {
        seasonId: season.seasonId,
        actorUserId: user.sub,
        version: created.item.version,
        now: now().toISOString(),
      });
      await onRulesetChange({
        seasonId: season.seasonId,
        version: created.item.version,
        reason: "create",
      });
    }
    return c.json(await state(season.seasonId, true), 201);
  });

  app.post("/seasons/:seasonId/scoring/versions/:version/lock", async (c) => {
    const user = c.get("user");
    const season = await commissioner(c.req.param("seasonId"), user);
    await lockRuleset(db, {
      seasonId: season.seasonId,
      actorUserId: user.sub,
      now: now().toISOString(),
      version: versionParam(c.req.param("version")),
    });
    return c.json(await state(season.seasonId, true));
  });

  app.post("/seasons/:seasonId/scoring/versions/:version/activate", async (c) => {
    const user = c.get("user");
    const season = await commissioner(c.req.param("seasonId"), user);
    const version = versionParam(c.req.param("version"));
    const before = await activeVersionOf(season.seasonId);
    await setActiveRuleset(db, {
      seasonId: season.seasonId,
      actorUserId: user.sub,
      now: now().toISOString(),
      version,
    });
    if (before !== version)
      await onRulesetChange({ seasonId: season.seasonId, version, reason: "activate" });
    return c.json(await state(season.seasonId, true));
  });
}
