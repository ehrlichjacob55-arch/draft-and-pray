/**
 * ESPN game snapshot -> canonical stat lines (docs/design/12 "Canonical mapping"). Pure: the pool
 * is passed in, nothing is fetched. Anything that cannot be attributed with confidence becomes a
 * warning instead of a guess, so the commissioner can override it.
 */
import type { EventStat, Position, StatKey } from "@dnp/domain";
import type { BoxAthlete, ParsedSummary, SummaryPlay, SummaryTeam } from "./espn-boxscore";
import { PoolSourceError } from "./types";

export interface PoolPlayerRef {
  playerId: string;
  name: string;
  position: Position;
  nflTeam: string;
  espnId?: string;
}

export interface MappedStatLine {
  playerId: string;
  canonical: Partial<Record<StatKey, number>>;
  events?: Partial<Record<EventStat, number[]>>;
  /** The compact provider values this line was read from. */
  raw: Record<string, unknown>;
}
export interface MappedGame {
  lines: MappedStatLine[];
  warnings: string[];
}

// ---- Names ----
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
const tokensOf = (name: string): string[] => {
  const t = name.toLowerCase().replace(/[’'.]/g, "").replace(/-/g, "").split(/\s+/).filter(Boolean);
  while (t.length > 1 && SUFFIXES.has(t[t.length - 1]!)) t.pop();
  return t;
};
/** Case, punctuation, apostrophes and Jr./III suffixes ignored. */
export const normalizeFullName = (name: string): string => tokensOf(name).join(" ");
/** First initial + last name of a full name: "Amon-Ra St. Brown" -> "astbrown". */
const shortKeyOfFull = (name: string): string => {
  const t = tokensOf(name);
  return `${t[0]?.[0] ?? ""}${t.slice(1).join("")}`;
};
/** "C.Williams" (play text) -> "cwilliams". Undefined when it is not initial + last name. */
export const shortKeyOfPlayText = (short: string): string | undefined => {
  const m = /^([A-Za-z])\.\s*(.+)$/.exec(short.trim());
  return m ? `${m[1]!.toLowerCase()}${tokensOf(m[2]!).join("")}` : undefined;
};
const athleteShortKey = (a: BoxAthlete): string =>
  a.firstName && a.lastName
    ? `${a.firstName[0]!.toLowerCase()}${tokensOf(a.lastName).join("")}`
    : shortKeyOfFull(a.name);

// ---- Box-score readers (by key) ----
function intOf(cat: string, row: Record<string, string>, key: string): number {
  const raw = row[key];
  if (raw === undefined) throw new PoolSourceError(`ESPN box score ${cat} has no "${key}" column`);
  const n = Number(raw);
  if (!Number.isInteger(n))
    throw new PoolSourceError(`ESPN box score ${cat}.${key} is not a number`);
  return n;
}
function pairOf(
  cat: string,
  row: Record<string, string>,
  key: string,
  sep: "/" | "-",
): [number, number] {
  const raw = row[key];
  const m =
    raw === undefined ? null : (sep === "/" ? /^(\d+)\/(\d+)$/ : /^(\d+)-(-?\d+)$/).exec(raw);
  if (!m) throw new PoolSourceError(`ESPN box score ${cat}.${key} is not a "${sep}" pair`);
  return [Number(m[1]), Number(m[2])];
}

// ---- Play text ----
const KICKER = String.raw`([A-Z]\.[A-Za-z'’\-]+(?: (?:Jr|Sr)\.?| II| III| IV)?)`;
const FG_PLAY = new RegExp(String.raw`${KICKER}\s+(\d+) yard field goal is (GOOD|No Good|BLOCKED)`);
const XP_BLOCKED = new RegExp(String.raw`${KICKER} extra point is BLOCKED`);
const TWO_PT = /TWO-POINT CONVERSION ATTEMPT\.\s*(.*?)\s*ATTEMPT SUCCEEDS/i;
const TWO_PT_PASS = /^(.+?)\s+pass\b(?:\s+\w+)*?\s+to\s+(.+?)\s+is complete/i;
const TWO_PT_RUSH = /^([A-Z]\.[A-Za-z'’-]+(?: (?:Jr|Sr)\.?| II| III| IV)?)\s+(?!pass\b)\S/;

/** A scoring play the defense or special teams scored (the offense's team id on the play is the other side). */
const DEF_TD =
  /interception return|fumble return|fumble recovery \(opponent\)|sack opp fumble recovery/i;
const BLOCK_RETURN_TD = /(blocked|missed).*(punt|field goal|kick|extra point).*touchdown/i;
const KICK_RETURN_TD = /^(kickoff|punt) return touchdown$/i;
const OFFENSE_TD = /^(passing|rushing) touchdown$/i;
const FIELD_GOAL_GOOD = /^field goal good$/i;
const TWO_POINT_TYPE = /two.?point|conversion/i;
const SPECIAL_TEAMS_TEXT = /\b(kicks|punts)\b|MUFFS/;

interface Draft {
  counts: Partial<Record<StatKey, number>>;
  events: Partial<Record<EventStat, number[]>>;
  raw: Record<string, unknown>;
}

interface Kick {
  kind: "good" | "missed" | "blocked";
  distance: number;
  kicker: string;
  teamId: string | undefined;
}

export function mapSummaryToStatLines(
  summary: ParsedSummary,
  pool: readonly PoolPlayerRef[],
): MappedGame {
  const warnings: string[] = [];
  const lines = new Map<string, Draft>();
  const teams: [SummaryTeam, SummaryTeam] = [summary.home, summary.away];
  const abbrOf = (teamId: string | undefined) => teams.find((t) => t.id === teamId)?.abbr;
  const opponentOf = (teamId: string | undefined) => teams.find((t) => t.id !== teamId);

  // ---- Pool matching ----
  const poolByEspn = new Map(pool.filter((p) => p.espnId).map((p) => [p.espnId as string, p]));
  const fantasyPool = pool.filter((p) => p.position !== "DST");
  type Match = { p: PoolPlayerRef } | { p?: undefined; ambiguous: boolean };

  const matchAthlete = (a: BoxAthlete): Match => {
    const byId = poolByEspn.get(a.id);
    if (byId) return { p: byId };
    const abbr = abbrOf(a.teamId);
    const isKicker = a.stats.kicking !== undefined;
    const want = normalizeFullName(a.name);
    const found = fantasyPool.filter(
      (p) =>
        p.nflTeam === abbr &&
        (p.position === "K") === isKicker &&
        normalizeFullName(p.name) === want,
    );
    return found.length === 1 ? { p: found[0]! } : { ambiguous: found.length > 1 };
  };

  /** A short play-text name ("C.Williams") to a pool player of `teamId`'s team. */
  const matchShort = (short: string, teamId: string | undefined, kicker = false): Match => {
    const key = shortKeyOfPlayText(short);
    const abbr = abbrOf(teamId);
    if (!key || !abbr) return { ambiguous: false };
    let found = fantasyPool.filter(
      (p) =>
        p.nflTeam === abbr && (!kicker || p.position === "K") && shortKeyOfFull(p.name) === key,
    );
    if (found.length > 1) {
      // Box-score athletes with this short name pin down the right one by ESPN id.
      const ids = new Set(
        summary.athletes
          .filter((a) => a.teamId === teamId && athleteShortKey(a) === key)
          .map((a) => a.id),
      );
      const narrowed = found.filter((p) => p.espnId !== undefined && ids.has(p.espnId));
      if (narrowed.length > 0) found = narrowed;
    }
    return found.length === 1 ? { p: found[0]! } : { ambiguous: found.length > 1 };
  };

  const draftFor = (playerId: string): Draft => {
    let d = lines.get(playerId);
    if (!d) {
      d = { counts: {}, events: {}, raw: {} };
      lines.set(playerId, d);
    }
    return d;
  };
  const add = (d: Draft, key: StatKey, n: number) => {
    d.counts[key] = (d.counts[key] ?? 0) + n;
  };

  // ---- Plays: kicks, blocked punts, two-point conversions ----
  const kicks: Kick[] = [];
  const blockedXps: { kicker: string; teamId: string | undefined }[] = [];
  const blockedPunts: (string | undefined)[] = [];
  const twoPoints: { play: SummaryPlay; inner: string }[] = [];
  for (const play of summary.plays) {
    const fg = FG_PLAY.exec(play.text);
    if (fg)
      kicks.push({
        kind: fg[3] === "GOOD" ? "good" : fg[3] === "BLOCKED" ? "blocked" : "missed",
        distance: Number(fg[2]),
        kicker: fg[1]!,
        teamId: play.teamId,
      });
    const xp = XP_BLOCKED.exec(play.text);
    if (xp) blockedXps.push({ kicker: xp[1]!, teamId: play.teamId });
    if (/punt is BLOCKED/i.test(play.text) || /^blocked punt$/i.test(play.type))
      blockedPunts.push(play.teamId);
    const two = TWO_PT.exec(play.text);
    if (two) twoPoints.push({ play, inner: two[1]! });
  }

  /** The box-score kicker a play's short name refers to (kickers of either team; play team breaks ties). */
  const kickerAthletes = summary.athletes.filter((a) => a.stats.kicking !== undefined);
  const kickerOf = (short: string, teamId: string | undefined): BoxAthlete | undefined => {
    const key = shortKeyOfPlayText(short);
    let found = kickerAthletes.filter((a) => athleteShortKey(a) === key);
    if (found.length > 1) found = found.filter((a) => a.teamId === teamId);
    return found.length === 1 ? found[0] : undefined;
  };
  const kickByKicker = new Map<string, Kick[]>();
  const xpBlockedBy = new Map<string, number>();
  const blocksBy = new Map<string, number>(); // by BLOCKING team id
  const creditBlock = (kickingTeamId: string | undefined) => {
    const blocker = opponentOf(kickingTeamId);
    if (blocker) blocksBy.set(blocker.id, (blocksBy.get(blocker.id) ?? 0) + 1);
  };
  for (const k of kicks) {
    const a = kickerOf(k.kicker, k.teamId);
    if (!a) {
      warnings.push(
        `Could not tell which kicker made the ${k.distance}-yard field goal try by ${k.kicker} (${abbrOf(k.teamId) ?? "?"})`,
      );
      continue;
    }
    const key = `${a.teamId}:${a.id}`;
    kickByKicker.set(key, [...(kickByKicker.get(key) ?? []), k]);
    if (k.kind === "blocked") creditBlock(a.teamId);
  }
  for (const x of blockedXps) {
    const a = kickerOf(x.kicker, x.teamId);
    if (!a) {
      warnings.push(`Could not tell which kicker had the blocked extra point by ${x.kicker}`);
      continue;
    }
    const key = `${a.teamId}:${a.id}`;
    xpBlockedBy.set(key, (xpBlockedBy.get(key) ?? 0) + 1);
    creditBlock(a.teamId);
  }
  for (const teamId of blockedPunts) creditBlock(teamId);

  // ---- Offensive / kicking players, from the box score ----
  const relevant = (c: Partial<Record<StatKey, number>>) => Object.values(c).some((v) => v !== 0);
  const returnTds = new Map<string, number>(); // by team id: kick + punt return TDs (box score)
  for (const a of summary.athletes) {
    const counts: Partial<Record<StatKey, number>> = {};
    const raw: Record<string, unknown> = { espnId: a.id };
    const events: Partial<Record<EventStat, number[]>> = {};
    const { passing, rushing, receiving, fumbles, kickReturns, puntReturns, kicking } = a.stats;
    if (passing) {
      counts.pass_yds = intOf("passing", passing, "passingYards");
      const td = intOf("passing", passing, "passingTouchdowns");
      const int = intOf("passing", passing, "interceptions");
      if (td > 0) counts.pass_td = td;
      if (int > 0) counts.pass_int = int;
      raw.passing = {
        passingYards: passing.passingYards,
        passingTouchdowns: passing.passingTouchdowns,
        interceptions: passing.interceptions,
      };
    }
    if (rushing) {
      counts.rush_yds = intOf("rushing", rushing, "rushingYards");
      const td = intOf("rushing", rushing, "rushingTouchdowns");
      if (td > 0) counts.rush_td = td;
      raw.rushing = {
        rushingYards: rushing.rushingYards,
        rushingTouchdowns: rushing.rushingTouchdowns,
      };
    }
    if (receiving) {
      counts.rec = intOf("receiving", receiving, "receptions");
      counts.rec_yds = intOf("receiving", receiving, "receivingYards");
      const td = intOf("receiving", receiving, "receivingTouchdowns");
      if (td > 0) counts.rec_td = td;
      raw.receiving = {
        receptions: receiving.receptions,
        receivingYards: receiving.receivingYards,
        receivingTouchdowns: receiving.receivingTouchdowns,
      };
    }
    if (fumbles) {
      const lost = intOf("fumbles", fumbles, "fumblesLost");
      if (lost > 0) counts.fum_lost = lost;
      raw.fumbles = { fumblesLost: fumbles.fumblesLost };
    }
    let ret = 0;
    if (kickReturns) {
      ret += intOf("kickReturns", kickReturns, "kickReturnTouchdowns");
      raw.kickReturns = { kickReturnTouchdowns: kickReturns.kickReturnTouchdowns };
    }
    if (puntReturns) {
      ret += intOf("puntReturns", puntReturns, "puntReturnTouchdowns");
      raw.puntReturns = { puntReturnTouchdowns: puntReturns.puntReturnTouchdowns };
    }
    if (ret > 0) {
      counts.ret_td = ret;
      returnTds.set(a.teamId, (returnTds.get(a.teamId) ?? 0) + ret);
    }
    if (kicking) {
      const [fgMade, fgAtt] = pairOf("kicking", kicking, "fieldGoalsMade/fieldGoalAttempts", "/");
      const [xpMade, xpAtt] = pairOf("kicking", kicking, "extraPointsMade/extraPointAttempts", "/");
      raw.kicking = {
        "fieldGoalsMade/fieldGoalAttempts": kicking["fieldGoalsMade/fieldGoalAttempts"],
        "extraPointsMade/extraPointAttempts": kicking["extraPointsMade/extraPointAttempts"],
      };
      const mine = kickByKicker.get(`${a.teamId}:${a.id}`) ?? [];
      const fgBlocked = mine.filter((k) => k.kind === "blocked").length;
      const fgMissed = Math.max(fgAtt - fgMade - fgBlocked, 0);
      const xpBlocked = xpBlockedBy.get(`${a.teamId}:${a.id}`) ?? 0;
      const xpMissed = Math.max(xpAtt - xpMade - xpBlocked, 0);
      if (fgMade > 0) counts.fg_made = fgMade;
      if (fgMissed > 0) counts.fg_missed = fgMissed;
      if (fgBlocked > 0) counts.fg_blocked = fgBlocked;
      if (xpMade > 0) counts.xp_made = xpMade;
      if (xpMissed > 0) counts.xp_missed = xpMissed;
      if (xpBlocked > 0) counts.xp_blocked = xpBlocked;
      for (const [stat, kind, n] of [
        ["fg_made", "good", fgMade],
        ["fg_missed", "missed", fgMissed],
      ] as const) {
        if (n === 0) continue;
        const distances = mine.filter((k) => k.kind === kind).map((k) => k.distance);
        if (distances.length === n) events[stat] = distances;
        else
          warnings.push(
            `${a.name} (${abbrOf(a.teamId)}): found ${distances.length} field goal distances for ${n} ${stat === "fg_made" ? "made" : "missed"} kicks; distances not recorded, so this game needs a commissioner override`,
          );
      }
    }

    const match = matchAthlete(a);
    if (match.p) {
      if (Object.keys(counts).length === 0) continue;
      if (lines.has(match.p.playerId)) {
        warnings.push(
          `${a.name} (${abbrOf(a.teamId)}) matched a pool player twice; second entry ignored`,
        );
        continue;
      }
      const d = draftFor(match.p.playerId);
      d.counts = counts;
      d.events = events;
      d.raw = raw;
    } else if (relevant(counts)) {
      warnings.push(
        match.ambiguous
          ? `${a.name} (${abbrOf(a.teamId)}) matches more than one player in the pool; not guessing`
          : `${a.name} (${abbrOf(a.teamId)}) has stats but is not in the player pool`,
      );
    }
  }

  // ---- Two-point conversions ----
  for (const { play, inner } of twoPoints) {
    const defensive = DEF_TD.test(play.type);
    const order = defensive
      ? [opponentOf(play.teamId)?.id, play.teamId]
      : [play.teamId, opponentOf(play.teamId)?.id];
    const pass = TWO_PT_PASS.exec(inner);
    const rush = pass ? null : TWO_PT_RUSH.exec(inner);
    if (!pass && !rush) {
      warnings.push(`Could not read a successful two-point conversion: ${inner}`);
      continue;
    }
    const names = pass ? [pass[1]!, pass[2]!] : [rush![1]!];
    const keys: StatKey[] = pass ? ["pass_2pt", "rec_2pt"] : ["rush_2pt"];
    const teamId = order.find(
      (id) => id !== undefined && matchShort(names[0]!, id).p !== undefined,
    );
    names.forEach((short, i) => {
      const m = matchShort(short, teamId ?? play.teamId);
      if (m.p) {
        const d = draftFor(m.p.playerId);
        add(d, keys[i]!, 1);
      } else
        warnings.push(
          `Could not match ${short} (${abbrOf(teamId ?? play.teamId) ?? "?"}) for a two-point conversion`,
        );
    });
  }

  // ---- Defense / special teams ----
  const defTds = new Map<string, number>();
  const blockReturnTds = new Map<string, number>();
  const safeties = new Map<string, number>();
  const bump = (m: Map<string, number>, id: string | undefined) => {
    if (id) m.set(id, (m.get(id) ?? 0) + 1);
  };
  for (const sp of summary.scoringPlays) {
    if (
      OFFENSE_TD.test(sp.type) ||
      FIELD_GOAL_GOOD.test(sp.type) ||
      KICK_RETURN_TD.test(sp.type) ||
      TWO_POINT_TYPE.test(sp.type)
    )
      continue;
    if (/safety/i.test(sp.type)) bump(safeties, sp.teamId);
    else if (BLOCK_RETURN_TD.test(sp.type)) bump(blockReturnTds, sp.teamId);
    else if (/fumble recovery \(own\)/i.test(sp.type)) {
      const who = /^(.+?) \d+ Yd /.exec(sp.text)?.[1];
      const fullKey = who ? normalizeFullName(who) : undefined;
      const abbr = abbrOf(sp.teamId);
      const found = fantasyPool.filter(
        (p) => p.nflTeam === abbr && normalizeFullName(p.name) === fullKey,
      );
      if (found.length === 1) add(draftFor(found[0]!.playerId), "fum_rec_td", 1);
      else warnings.push(`Unclassified scoring play (fumble recovery touchdown): ${sp.text}`);
    } else if (DEF_TD.test(sp.type) && !SPECIAL_TEAMS_TEXT.test(sp.text)) bump(defTds, sp.teamId);
    else warnings.push(`Unclassified scoring play (${sp.type || "no type"}): ${sp.text}`);
  }

  for (const team of teams) {
    const opp = opponentOf(team.id)!;
    let sacks = 0;
    let ints = 0;
    let fumblesLost = 0;
    for (const a of summary.athletes) {
      if (a.teamId !== opp.id) continue;
      if (a.stats.passing) {
        sacks += pairOf("passing", a.stats.passing, "sacks-sackYardsLost", "-")[0];
        ints += intOf("passing", a.stats.passing, "interceptions");
      }
      if (a.stats.fumbles) fumblesLost += intOf("fumbles", a.stats.fumbles, "fumblesLost");
    }
    const d = draftFor(`DST-${team.abbr}`);
    d.counts = {
      def_pts_allowed: opp.score,
      def_sack: sacks,
      def_int: ints,
      def_fum_rec: fumblesLost,
    };
    const blocks = blocksBy.get(team.id) ?? 0;
    const safety = safeties.get(team.id) ?? 0;
    const defTd = defTds.get(team.id) ?? 0;
    const retTd = (returnTds.get(team.id) ?? 0) + (blockReturnTds.get(team.id) ?? 0);
    if (blocks > 0) d.counts.def_block = blocks;
    if (safety > 0) d.counts.def_safety = safety;
    if (defTd > 0) d.counts.def_td = defTd;
    if (retTd > 0) d.counts.ret_td = retTd;
    d.raw = { opponent: opp.abbr, opponentScore: opp.score };
  }

  const out: MappedStatLine[] = [];
  for (const [playerId, d] of lines) {
    if (Object.keys(d.counts).length === 0) continue;
    out.push({
      playerId,
      canonical: d.counts,
      ...(Object.keys(d.events).length > 0 ? { events: d.events } : {}),
      raw: d.raw,
    });
  }
  return { lines: out, warnings };
}
