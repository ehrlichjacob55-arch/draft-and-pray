/**
 * ESPN game summary -> a provider-shaped, pool-independent snapshot of one game (docs/design/12).
 * Box-score columns are always read by `keys`, never by position. Unofficial endpoint: the parts
 * we use are validated strictly (fail loudly), everything else is ignored.
 */
import type { LiveGameStatus } from "@dnp/domain";
import { z } from "zod";
import { liveStatusOf, readCompetitors } from "./espn-scoreboard";
import { PoolSourceError } from "./types";

// ---- Raw shapes (the parts we read) ----
const statusType = z.object({ name: z.string(), completed: z.boolean().optional() });
const team = z.object({ id: z.string().min(1), abbreviation: z.string().min(1) });
const competitor = z.object({
  homeAway: z.enum(["home", "away"]),
  score: z
    .union([z.string(), z.number()])
    .transform((v) => Number(v))
    .optional(),
  winner: z.boolean().optional(),
  team,
});
const athlete = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
});
const play = z.object({
  type: z.object({ text: z.string() }).optional(),
  text: z.string().default(""),
  scoringPlay: z.boolean().optional(),
  start: z.object({ team: z.object({ id: z.string() }).optional() }).optional(),
});
const summary = z.object({
  header: z.object({
    competitions: z
      .array(
        z.object({
          status: z.object({ type: statusType }),
          competitors: z.array(competitor).length(2),
        }),
      )
      .min(1),
  }),
  boxscore: z
    .object({
      players: z
        .array(
          z.object({
            team,
            statistics: z.array(
              z.object({
                name: z.string(),
                keys: z.array(z.string()),
                athletes: z.array(z.object({ athlete, stats: z.array(z.string()) })),
              }),
            ),
          }),
        )
        .default([]),
    })
    .default({ players: [] }),
  scoringPlays: z
    .array(
      z.object({
        type: z.object({ text: z.string() }).optional(),
        text: z.string().default(""),
        team: z.object({ id: z.string() }).optional(),
        awayScore: z.coerce.number().optional(),
        homeScore: z.coerce.number().optional(),
      }),
    )
    .default([]),
  drives: z
    .object({
      previous: z.array(z.object({ plays: z.array(play).default([]) })).default([]),
      current: z.object({ plays: z.array(play).default([]) }).optional(),
    })
    .default({ previous: [] }),
});

// ---- Parsed shapes ----
export interface SummaryTeam {
  /** ESPN team id (what plays and scoring plays refer to). */
  id: string;
  abbr: string;
  score: number;
}
export interface BoxAthlete {
  id: string;
  name: string;
  firstName?: string;
  lastName?: string;
  teamId: string;
  /** category name -> stat key -> raw value, e.g. `passing.passingYards = "304"`. */
  stats: Record<string, Record<string, string>>;
}
export interface SummaryPlay {
  teamId: string | undefined;
  type: string;
  text: string;
}
export interface SummaryScoringPlay {
  teamId: string | undefined;
  type: string;
  text: string;
  /** Running score after the play, conversion included; absent when ESPN omitted it. */
  awayScore?: number;
  homeScore?: number;
}
export interface ParsedSummary {
  status: LiveGameStatus;
  home: SummaryTeam;
  away: SummaryTeam;
  athletes: BoxAthlete[];
  /** Every real play (no-play penalties removed), in game order. */
  plays: SummaryPlay[];
  scoringPlays: SummaryScoringPlay[];
}

/** A play the officials wiped out ("... - No Play.") never counts. */
const isNoPlay = (text: string) => /\bNo Play\b/i.test(text);

export function parseEspnSummary(json: unknown): ParsedSummary {
  const parsed = summary.safeParse(json);
  if (!parsed.success) throw new PoolSourceError("ESPN game summary had an unexpected shape");
  const s = parsed.data;
  const comp = s.header.competitions[0]!;
  const status = liveStatusOf(comp.status.type);
  const names = readCompetitors(comp.competitors, status);
  const home = comp.competitors.find((c) => c.homeAway === "home")!;
  const away = comp.competitors.find((c) => c.homeAway === "away")!;
  if (!names) throw new PoolSourceError("ESPN game summary had unreadable scores");
  const asTeam = (c: typeof home, score: number): SummaryTeam => ({
    id: c.team.id,
    abbr: c.team.abbreviation,
    score,
  });

  const athletes = new Map<string, BoxAthlete>();
  for (const t of s.boxscore.players)
    for (const cat of t.statistics)
      for (const a of cat.athletes) {
        const id = `${t.team.id}:${a.athlete.id}`;
        const entry = athletes.get(id) ?? {
          id: a.athlete.id,
          name: a.athlete.displayName,
          ...(a.athlete.firstName ? { firstName: a.athlete.firstName } : {}),
          ...(a.athlete.lastName ? { lastName: a.athlete.lastName } : {}),
          teamId: t.team.id,
          stats: {},
        };
        const row: Record<string, string> = {};
        cat.keys.forEach((key, i) => {
          const v = a.stats[i];
          if (v !== undefined) row[key] = v;
        });
        entry.stats[cat.name] = row;
        athletes.set(id, entry);
      }

  const plays = [...s.drives.previous.flatMap((d) => d.plays), ...(s.drives.current?.plays ?? [])]
    .filter((p) => !isNoPlay(p.text))
    .map((p) => ({ teamId: p.start?.team?.id, type: p.type?.text ?? "", text: p.text }));

  return {
    status,
    home: asTeam(home, names.homeScore),
    away: asTeam(away, names.awayScore),
    athletes: [...athletes.values()],
    plays,
    scoringPlays: s.scoringPlays.map((p) => ({
      teamId: p.team?.id,
      type: p.type?.text ?? "",
      text: p.text,
      ...(p.awayScore !== undefined ? { awayScore: p.awayScore } : {}),
      ...(p.homeScore !== undefined ? { homeScore: p.homeScore } : {}),
    })),
  };
}
