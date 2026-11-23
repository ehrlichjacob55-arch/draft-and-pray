/** Test helpers: a league season with 9 teams (no Cognito, no HTTP) for scoring/ingest tests. */
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  addManager,
  bootstrapLeague,
  localSub,
  rosterEntryKey,
  seedBuiltinRuleset,
  type Dynamo,
} from "@dnp/db";
import type { Slot } from "@dnp/domain";

export interface TestSeason {
  seasonId: string;
  leagueId: string;
  commissionerEmail: string;
  commissionerId: string;
  teamIds: string[];
}

let counter = 0;

/** A fresh league with a commissioner, 9 (unclaimed) teams and the `league` ruleset active as v1. */
export async function createTestSeason(
  db: Dynamo,
  opts: { year?: number; ruleset?: boolean; managers?: number } = {},
): Promise<TestSeason> {
  counter++;
  const email = `boss${counter}-${Math.random().toString(36).slice(2, 8)}@local.test`;
  const commissionerId = localSub(email);
  const r = await bootstrapLeague(db, {
    userId: commissionerId,
    email,
    leagueName: `Scores League ${counter}`,
    year: opts.year ?? 2026,
  });
  const teamIds: string[] = [];
  for (let i = 1; i <= (opts.managers ?? 9); i++) {
    const row = await addManager(db, {
      seasonId: r.seasonId,
      firstName: "Sekrit",
      lastName: `Person${i}`,
      email: `m${counter}-${i}@local.test`,
      actorUserId: commissionerId,
    });
    teamIds.push(row.team.teamId);
  }
  if (opts.ruleset !== false)
    await seedBuiltinRuleset(db, { seasonId: r.seasonId, name: "league" });
  return {
    seasonId: r.seasonId,
    leagueId: r.leagueId,
    commissionerEmail: email,
    commissionerId,
    teamIds,
  };
}

/** Puts `ROSTER#<team>#<slot>#1` (what the draft writes) without running a draft. */
export async function putRosterEntry(
  db: Dynamo,
  seasonId: string,
  entry: { teamId: string; slot: Slot; playerId: string; fromRound?: number },
): Promise<void> {
  const fromRound = entry.fromRound ?? 1;
  await db.doc.send(
    new PutCommand({
      TableName: db.tableName,
      Item: {
        ...rosterEntryKey(seasonId, entry.teamId, entry.slot, fromRound),
        type: "RosterEntry",
        teamId: entry.teamId,
        slot: entry.slot,
        playerId: entry.playerId,
        fromRound,
        acquiredVia: "draft",
      },
    }),
  );
}
