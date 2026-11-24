/** The commissioner's per-game stat view (docs/design/04 §7): provider stats, overrides, effective stats, points. */
import type { GameLine, GameLinesResponse, StatValues } from "@dnp/contract";
import type { SeasonSnapshot } from "@dnp/db";
import { applyOverrides, parseStatLine, type StatLine, type StatOverrides } from "@dnp/domain";

const toValues = (line: StatLine): StatValues => ({
  counts: { ...line.counts } as Record<string, number>,
  ...(line.events ? { events: { ...line.events } as Record<string, number[]> } : {}),
});

/** The player's stat line for a game (parsed), or undefined when the provider has none. Throws on an unreadable line. */
export function providerLine(snap: SeasonSnapshot, gameId: string, playerId: string) {
  const s = snap.stats.find((x) => x.gameId === gameId && x.playerId === playerId);
  return s
    ? parseStatLine({ counts: s.canonical, ...(s.events ? { events: s.events } : {}) })
    : undefined;
}

/** Overrides of a player-game as the engine takes them. */
export const overridesOf = (snap: SeasonSnapshot, gameId: string, playerId: string) => {
  const out: StatOverrides = {};
  for (const o of snap.overrides)
    if (o.gameId === gameId && o.playerId === playerId)
      (out as Record<string, number>)[o.statKey] = o.value;
  return out;
};

/**
 * Every pool player of the game's two teams that has a stat line or an override, plus both DSTs;
 * DSTs last, then points descending. Undefined for an unknown game.
 */
export function buildGameLines(
  snap: SeasonSnapshot,
  gameId: string,
): GameLinesResponse | undefined {
  const game = snap.games.find((g) => g.gameId === gameId);
  if (!game) return undefined;
  const roundStatus = snap.rounds.find((r) => r.round === game.round)?.status ?? "upcoming";
  const teams = new Set([game.home, game.away]);
  const touched = new Set([
    ...snap.stats.filter((s) => s.gameId === gameId).map((s) => s.playerId),
    ...snap.overrides.filter((o) => o.gameId === gameId).map((o) => o.playerId),
  ]);
  const points = new Map(
    snap.points.filter((p) => p.gameId === gameId).map((p) => [p.playerId, p]),
  );

  const lines: GameLine[] = [];
  for (const p of snap.players) {
    if (!teams.has(p.nflTeam)) continue;
    const isDst = p.position === "DST";
    if (!isDst && !touched.has(p.playerId)) continue;
    let provider: StatLine | undefined;
    let issue: string | undefined;
    try {
      provider = providerLine(snap, gameId, p.playerId);
    } catch (err) {
      issue = (err as Error).message;
    }
    const overrides = snap.overrides
      .filter((o) => o.gameId === gameId && o.playerId === p.playerId)
      .sort((a, b) => a.statKey.localeCompare(b.statKey))
      .map((o) => ({ statKey: o.statKey, value: o.value, reason: o.reason, at: o.at }));
    let effective: StatLine = provider ?? { counts: {} };
    if (!issue)
      try {
        effective = applyOverrides(effective, overridesOf(snap, gameId, p.playerId)).statLine;
      } catch (err) {
        issue = (err as Error).message;
      }
    const row = points.get(p.playerId);
    lines.push({
      playerId: p.playerId,
      name: p.name,
      position: p.position,
      nflTeam: p.nflTeam,
      provider: provider ? toValues(provider) : null,
      overrides,
      effective: toValues(effective),
      points: row?.points ?? null,
      breakdown: (row?.breakdown ?? []).map((b) => ({
        ruleIndex: b.ruleIndex,
        stat: b.stat,
        ...(b.label ? { label: b.label } : {}),
        value: b.value,
        points: b.points,
      })),
      ...(issue ? { issue } : {}),
    });
  }
  lines.sort(
    (a, b) =>
      Number(a.position === "DST") - Number(b.position === "DST") ||
      (b.points ?? -1e12) - (a.points ?? -1e12) ||
      a.name.localeCompare(b.name),
  );
  return {
    game: {
      gameId: game.gameId,
      round: game.round,
      roundStatus,
      home: game.home,
      away: game.away,
      homeScore: game.homeScore,
      awayScore: game.awayScore,
      status: game.status,
    },
    lines,
  };
}
