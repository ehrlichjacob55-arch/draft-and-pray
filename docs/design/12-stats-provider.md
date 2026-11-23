# 12 — Stats & Data Provider: ESPN (+ Sleeper for rosters)

Decided 2026-11-09 by the owner: **ESPN is the stats source.** The player pool uses ESPN for the playoff field and Sleeper for rosters (doc 14 §3). This answers 08 Q7: no paid provider.

## Endpoints (unofficial, public JSON, no key)

| Purpose | URL | Notes |
|---|---|---|
| Playoff field + seeds | `https://site.api.espn.com/apis/v2/sports/football/nfl/standings?season=<year>` | `children[]` = conferences; stat `playoffSeed` 1–7; `clincher` marker. |
| Playoff schedule / game status | `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=3&dates=<year>&week=<1..5>` | `seasontype=3` = postseason. Round/week mapping below. `status.type.name` = `STATUS_SCHEDULED/IN_PROGRESS/FINAL` and others (see "Game status"). |
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

## Rounds and weeks

| Round | Code | ESPN `week` (`seasontype=3`) |
|---|---|---|
| 1 | WC | 1 |
| 2 | DIV | 2 |
| 3 | CONF | 3 |
| (Pro Bowl) | | 4: never a round |
| 4 | SB | 5 |

Verified against `dates=2025`: 6 + 4 + 2 + 1 games, all `STATUS_FINAL`. A season that numbers the Super Bowl week 4 is handled: when week 5 has no games and week 4 has **exactly one** game between two teams of the playoff field, it is the Super Bowl. The ingest also drops any game with a team outside the field (the Pro Bowl lists AFC/NFC). **Game ids are ESPN event ids** (`GAME#<eventId>`).

The ESPN `dates=` year is the **NFL season the pool's field was imported from** (`POOLIMPORT.seasonYear`), falling back to the league season year when no import exists. A dev league that imported last season's field therefore replays last season's postseason.

### Game status
`status.type.completed` true or `STATUS_FINAL` is `final`; `STATUS_SCHEDULED`, `STATUS_POSTPONED` and `STATUS_CANCELED` are `scheduled`; every other state (in progress, halftime, end of period, delays, anything new) is `in_progress`. A round is `final` only when all of its games are final **and** the whole round is listed (6/4/2/1 games): ESPN lists later matchups only once they are known.

## Canonical mapping (implemented; the contract)

Box-score columns are always read **by `keys`**, never by position. Values the parser requires but cannot find or read fail the game's parse loudly (`PoolSourceError`), which surfaces as a warning for that game while the others continue.

**Offensive player** (a pool player; box-score athlete matched as below):

| Canonical key | ESPN source | Emitted |
|---|---|---|
| `pass_yds` | `passing.passingYards` | always, for a passer (even 0) |
| `pass_td` / `pass_int` | `passing.passingTouchdowns` / `passing.interceptions` | when > 0 |
| `rush_yds` | `rushing.rushingYards` | always, for a rusher |
| `rush_td` | `rushing.rushingTouchdowns` | when > 0 |
| `rec` / `rec_yds` | `receiving.receptions` / `receiving.receivingYards` | always, for a receiver |
| `rec_td` | `receiving.receivingTouchdowns` | when > 0 |
| `fum_lost` | `fumbles.fumblesLost` | when > 0 |
| `ret_td` | `kickReturns.kickReturnTouchdowns` + `puntReturns.puntReturnTouchdowns` | when > 0 |
| `fum_rec_td` | scoring play of type "Fumble Recovery (Own)": the scorer's full name from the play text, matched on the team; otherwise a warning | when > 0 |
| `pass_2pt` / `rec_2pt` | play text `TWO-POINT CONVERSION ATTEMPT. <passer> pass to <receiver> is complete. ATTEMPT SUCCEEDS.` (failed attempts count for nothing) | when > 0 |
| `rush_2pt` | the same text with a runner instead of a pass | when > 0 |

**Kicker** (`kicking` category; plays are matched to the kicker by short name, or all of a team's kicks belong to its only kicker):

| Canonical key | Source |
|---|---|
| `fg_made` | made of `fieldGoalsMade/fieldGoalAttempts`; `events.fg_made` = the distances of the team's plays "NN yard field goal is GOOD", in play order |
| `fg_blocked` | plays "NN yard field goal is BLOCKED" for that kicker |
| `fg_missed` | attempts − made − blocked; `events.fg_missed` = distances of plays "… is No Good", in play order |
| `xp_made` | made of `extraPointsMade/extraPointAttempts` |
| `xp_blocked` | plays "<kicker> extra point is BLOCKED" |
| `xp_missed` | attempts − made − blocked |

If a distance list does not have the same length as its count, **no distances are stored for that key** and a warning is raised: the scoring engine then reports the player-game as an issue (a distance rule needs distances), and the commissioner overrides it. Plays ending "- No Play." (penalties) never count.

**DST** (player id `DST-<ESPN abbr>`, position DST; both teams of every game get a line):

| Canonical key | Source | Emitted |
|---|---|---|
| `def_pts_allowed` | the opponent's current/final score **minus the opponent's defensive TD drives**: interception-return and fumble-return TDs (the plays counted as `def_td` for the opponent) including their conversion, i.e. the score change of that scoring play (6, 7 or 8). Kickoff/punt/blocked-kick/missed-FG return TDs and safeties still count against the defense; never below 0. If the score change is unreadable it falls back to 6 (+1 when the text shows a made kick) and warns. `raw.opponentDefensivePoints` holds the deduction (04 §2, Q13) | always |
| `def_sack` | the opponent passers' sacks (first number of `passing.sacks-sackYardsLost`) | always |
| `def_int` | the opponent passers' `passing.interceptions` | always |
| `def_fum_rec` | the opponent's `fumbles.fumblesLost`, summed over all its athletes (a muffed punt lost counts) | always |
| `def_block` | blocked field goals and extra points kicked by the opponent, and **blocked punts** (Q15) | when > 0 |
| `def_safety` | scoring plays whose type is a safety, credited to the scoring team | when > 0 |
| `def_td` | this team's scoring plays of type interception return, fumble return, "Fumble Recovery (Opponent)", "Sack Opp Fumble Recovery" | when > 0 |
| `ret_td` | the team's kickoff/punt return TDs (box score, all its athletes, pool or not) plus blocked/missed-kick return TDs (scoring plays) (Q16) | when > 0 |
| `def_yds_allowed` | not emitted (no league rule uses it) | |

A stat line with no counts is not written. Scoring plays that match none of the above (including a fumble recovery TD on a kick or punt) are **not guessed**: each raises the warning `Unclassified scoring play (<type>): <text>`.

Verified against the recorded 2025 postseason (13 games): the parser reproduces `GOLDEN_PLAYERS` (LAR @ CAR) exactly and runs the whole postseason without warnings when every box-score athlete is in the pool.

## Player matching (ESPN athlete -> pool player)

1. `PLAYER.espnId` equal to the box-score `athlete.id` (Sleeper's `espn_id`, stored by the pool import).
2. Otherwise the **normalized full name** (case, periods, apostrophes, hyphens and Jr./Sr./II/III/IV ignored) on the same NFL team; a kicker only matches a `K`, anyone else a non-`K`. More than one match is ambiguous and is never guessed.
3. Otherwise no match: a warning `<Name> (<TEAM>) has stats but is not in the player pool`, only for athletes who would score something (defensive-only athletes are ignored silently).

Play text uses short names (`C.Williams`): initial + last name, normalized the same way, matched on the right team among the pool players (and the box-score athletes with that short name, whose ESPN ids break ties). Ambiguous or unmatched names are warnings, never guesses. The two-point conversion of a team's pick-six is credited to the scoring team.

## Runtime (docs 04 §3, 10 §4.4)

`runIngest` per season: take the lease; load the season; fetch the four scoreboards; upsert games; fetch summaries for games **in progress**, and **final** games never fetched as final or last fetched more than 6 hours ago while their round is not finalized (4 at a time; a failed summary is a warning and the others continue); parse, match and upsert stat lines (skipping unchanged `providerHash`); derive NFL team statuses and round statuses; recompute scores; broadcast `scores_updated` if anything changed; release the lease with the summary, warnings (at most 100, no user data) and the next poll time. Any error records a short `lastError` and retries in 15 minutes.

## Risks & mitigations
- **Unofficial API:** fields or URLs can change without notice. Mitigations:
  - an adapter with strict zod parsing that fails loudly;
  - recorded fixtures from real games for replay tests (doc 04 §8);
  - commissioner stat overrides (FR-19);
  - the CSV/manual adapter as a fallback.
- **Text parsing** (FG distance, 2-pt, safeties) is the most fragile part. It is covered by fixtures from all 13 games of the 2025 postseason (`apps/api/src/providers/__fixtures__/espn`, trimmed to the fields the parser reads), and any unclassified scoring play, unmatched athlete or distance mismatch becomes a commissioner-visible warning.
- **Stat corrections:** final games are re-fetched every 6 h until the commissioner finalizes the round (doc 04 §6); stat lines whose `providerHash` is unchanged are not rewritten.
- **Terms:** no published terms for ESPN; Sleeper is non-commercial only. Acceptable for a private 10-person league; revisit if the app ever goes public.
