/**
 * The ONLY place key strings are built (docs/design/10 §2). Numbers inside sort keys are
 * zero-padded so lexicographic order equals numeric order.
 */
import type { Slot } from "@dnp/domain";

const pad = (n: number, width: number) => String(n).padStart(width, "0");

export interface Key {
  pk: string;
  sk: string;
}
export interface KeyWithGsi1 extends Key {
  gsi1pk: string;
  gsi1sk: string;
}

export const seasonPk = (seasonId: string) => `SEASON#${seasonId}`;
export const leaguePk = (leagueId: string) => `LEAGUE#${leagueId}`;

// ---- Global partitions ----
export const userKey = (userId: string): Key => ({ pk: `USER#${userId}`, sk: "PROFILE" });
export const userGsi1 = (email: string) => ({ gsi1pk: `EMAIL#${email}`, gsi1sk: "USER" });
export const userKeys = (userId: string, email: string): KeyWithGsi1 => ({
  ...userKey(userId),
  ...userGsi1(email),
});
/** A5/A6 query keys. */
export const gsiUserPk = (userId: string) => `USER#${userId}`;
export const gsiEmailPk = (email: string) => `EMAIL#${email}`;

export const leagueKey = (leagueId: string): Key => ({ pk: leaguePk(leagueId), sk: "META" });
export const leagueMemberKey = (leagueId: string, userId: string): KeyWithGsi1 => ({
  pk: leaguePk(leagueId),
  sk: `MEMBER#${userId}`,
  gsi1pk: `USER#${userId}`,
  gsi1sk: `LEAGUE#${leagueId}`,
});
export const seasonPointerKey = (leagueId: string, year: number): Key => ({
  pk: leaguePk(leagueId),
  sk: `SEASON#${year}`,
});
export const inviteKey = (token: string): Key => ({ pk: `INVITE#${token}`, sk: "META" });
/** Invite item keys incl. the A12 index entry (invites of a season, ordered by createdAt). */
export const inviteKeys = (token: string, seasonId: string, createdAt: string): KeyWithGsi1 => ({
  ...inviteKey(token),
  gsi1pk: gsiSeasonInvitesPk(seasonId),
  gsi1sk: createdAt,
});
/** A12 query key. */
export const gsiSeasonInvitesPk = (seasonId: string) => `SEASONINV#${seasonId}`;

// ---- Season partition ----
export const seasonMetaKey = (seasonId: string): Key => ({ pk: seasonPk(seasonId), sk: "META" });
export const rulesetKey = (seasonId: string, version: number): Key => ({
  pk: seasonPk(seasonId),
  sk: `RULESET#v${pad(version, 3)}`,
});
export const teamKey = (seasonId: string, teamId: string): Key => ({
  pk: seasonPk(seasonId),
  sk: `TEAM#${teamId}`,
});
/** One team per user per season (docs/design/11 §2). */
export const teamOwnerKey = (seasonId: string, userId: string): Key => ({
  pk: seasonPk(seasonId),
  sk: `TEAMOWNER#${userId}`,
});
export const draftKey = (seasonId: string): Key => ({ pk: seasonPk(seasonId), sk: "DRAFT" });
export const pickKey = (seasonId: string, overallPick: number): Key => ({
  pk: seasonPk(seasonId),
  sk: `PICK#${pad(overallPick, 3)}`,
});
export const queueKey = (seasonId: string, teamId: string): Key => ({
  pk: seasonPk(seasonId),
  sk: `QUEUE#${teamId}`,
});
export const rosterEntryKey = (
  seasonId: string,
  teamId: string,
  slot: Slot,
  fromRound: number,
): Key => ({ pk: seasonPk(seasonId), sk: `ROSTER#${teamId}#${slot}#${fromRound}` });
export const nflTeamKey = (seasonId: string, abbr: string): Key => ({
  pk: seasonPk(seasonId),
  sk: `NFLTEAM#${abbr}`,
});
export const playerKey = (seasonId: string, playerId: string): Key => ({
  pk: seasonPk(seasonId),
  sk: `PLAYER#${playerId}`,
});
export const roundKey = (seasonId: string, round: number): Key => ({
  pk: seasonPk(seasonId),
  sk: `ROUND#${round}`,
});
export const gameKey = (seasonId: string, gameId: string): Key => ({
  pk: seasonPk(seasonId),
  sk: `GAME#${gameId}`,
});
export const statsKey = (seasonId: string, gameId: string, playerId: string): Key => ({
  pk: seasonPk(seasonId),
  sk: `STATS#${gameId}#${playerId}`,
});
export const overrideKey = (
  seasonId: string,
  gameId: string,
  playerId: string,
  statKey: string,
): Key => ({ pk: seasonPk(seasonId), sk: `OVERRIDE#${gameId}#${playerId}#${statKey}` });
export const pointsKey = (seasonId: string, gameId: string, playerId: string): Key => ({
  pk: seasonPk(seasonId),
  sk: `POINTS#${gameId}#${playerId}`,
});
export const teamScoreKey = (seasonId: string, round: number, teamId: string): Key => ({
  pk: seasonPk(seasonId),
  sk: `TEAMSCORE#${round}#${teamId}`,
});
export const txnKey = (seasonId: string, txnId: string): Key => ({
  pk: seasonPk(seasonId),
  sk: `TXN#${txnId}`,
});
export const auditKey = (seasonId: string, auditId: string): Key => ({
  pk: seasonPk(seasonId),
  sk: `AUDIT#${auditId}`,
});

// ---- Sort-key prefixes for Query begins_with (A2/A4/A9/A10/A11) ----
export const skPrefix = {
  picks: "PICK#",
  players: "PLAYER#",
  teams: "TEAM#",
  teamOwners: "TEAMOWNER#",
  seasonPointers: "SEASON#",
  members: "MEMBER#",
  audit: "AUDIT#",
  teamScores: "TEAMSCORE#",
  points: "POINTS#",
  rosterOfTeam: (teamId: string) => `ROSTER#${teamId}#`,
} as const;
