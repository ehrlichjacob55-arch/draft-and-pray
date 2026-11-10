# 12 — Stats & Data Provider: ESPN (+ Sleeper for rosters)

Decided 2026-11-09 by the owner: **ESPN is the stats source.** The player pool uses ESPN for the playoff field and Sleeper for rosters (doc 14 §3). This answers 08 Q7: no paid provider.

## Endpoints (unofficial, public JSON, no key)

| Purpose | URL | Notes |
|---|---|---|
| Playoff field + seeds | `https://site.api.espn.com/apis/v2/sports/football/nfl/standings?season=<year>` | `children[]` = conferences; stat `playoffSeed` 1–7; `clincher` marker. |
| Playoff schedule / game status | `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=3&dates=<year>&week=<1..5>` | `seasontype=3` = postseason; week 1 = Wild Card … (Pro Bowl week skipped; verify the SB week number each season). `status.type.name` = `STATUS_SCHEDULED/IN_PROGRESS/FINAL`. |
| Box score + plays | `https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=<id>` | ~600 KB. `boxscore.players[].statistics[]` categories below; `scoringPlays[]`; `drives.previous[].plays[]` (full play-by-play). |
| Rosters | `https://api.sleeper.app/v1/players/nfl` (Sleeper) | ~5 MB, at most once a day, non-commercial use. |

ESPN blocks some automated fetchers but answers plain HTTPS GETs (verified with curl). Send a descriptive `User-Agent`, poll gently, and back off on errors.

## Verified coverage (2025–26 Wild Card, LAR @ CAR, fetched 2026-11-09)

Per-player categories and their labels:
- `passing`: C/ATT, YDS, AVG, TD, INT, SACKS, QBR, RTG
- `rushing`: CAR, YDS, AVG, TD, LONG
- `receiving`: REC, YDS, AVG, TD, LONG, TGTS
- `fumbles`: FUM, LOST, REC
- `defensive`: TOT, SOLO, SACKS, TFL, PD, QB HTS, TD
- `interceptions`: INT, YDS, TD
- `kickReturns`, `puntReturns`: NO, YDS, AVG, LONG, TD
- `kicking`: FG (made/att), PCT, LONG, XP (made/att), PTS
- `punting`

Team stats include `defensiveTouchdowns`, `turnovers` and `fumblesLost`.

| Canonical need (doc 04) | Source |
|---|---|
| pass/rush/rec yards, TDs, INT thrown, receptions | per-player categories |
| fumbles lost | `fumbles.LOST` |
| FG made by **distance band**, missed FGs | parse play text: scoring plays ("<Name> 46 Yd Field Goal"), and play-by-play for misses ("… 52 yard field goal is No Good") |
| XP made/missed | `kicking.XP` |
| 2-pt conversions (player) | play-by-play text ("TWO-POINT CONVERSION ATTEMPT … ATTEMPT SUCCEEDS") |
| DST points allowed | the opponent's final score (league rules decide whether defensive/return TDs scored *against* count; Q13) |
| DST sacks, INTs, fumble recoveries, defensive/return TDs, safeties, blocked kicks | summed `defensive` / `interceptions` / `fumbles.REC` / return categories for the team + play text for safeties and blocks |

## Risks & mitigations
- **Unofficial API:** fields or URLs can change without notice. Mitigations:
  - an adapter with strict zod parsing that fails loudly;
  - recorded fixtures from real games for replay tests (doc 04 §8);
  - commissioner stat overrides (FR-19);
  - the CSV/manual adapter as a fallback.
- **Text parsing** (FG distance, 2-pt, safeties) is the most fragile part. Cover it with fixtures from several games, and flag any unparsed scoring play for commissioner review.
- **Stat corrections:** re-poll final games every 6 h until the commissioner finalizes the round (doc 04 §6).
- **Terms:** no published terms for ESPN; Sleeper is non-commercial only. Acceptable for a private 10-person league; revisit if the app ever goes public.
