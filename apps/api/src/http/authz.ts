/** Server-side authorization helpers (docs/design/11 §1). */
import type { LeagueRole } from "@dnp/contract";
import { getMember, getSeasonMeta, type Dynamo, type SeasonMetaItem } from "@dnp/db";
import type { AuthUser } from "./auth";
import { forbidden, notFound } from "./errors";

export interface Membership {
  leagueId: string;
  role: LeagueRole;
}

/** 403 unless the user is a member of the league. */
export async function requireMember(
  db: Dynamo,
  leagueId: string,
  user: AuthUser,
): Promise<Membership> {
  const m = await getMember(db, leagueId, user.sub);
  if (!m) throw forbidden("You are not a member of this league");
  return { leagueId, role: m.role };
}

/** 403 unless the user is the league's commissioner. */
export async function requireCommissioner(
  db: Dynamo,
  leagueId: string,
  user: AuthUser,
): Promise<Membership> {
  const m = await requireMember(db, leagueId, user);
  if (m.role !== "commissioner") throw forbidden("Commissioner access required");
  return m;
}

/** A season resolves to its league via season META (404 if the season does not exist). */
export async function loadSeasonMeta(db: Dynamo, seasonId: string): Promise<SeasonMetaItem> {
  const meta = await getSeasonMeta(db, seasonId);
  if (!meta) throw notFound("Season not found");
  return meta;
}
