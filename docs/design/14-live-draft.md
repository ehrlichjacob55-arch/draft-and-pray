# 14 — Live Draft (Tasks 4-lite, 5, 6, 7)

Builds on [03-draft-design](03-draft-design.md) (format, lifecycle, slot rules), [10](10-dynamodb-data-model.md) §4.1–4.3 (pick/undo transactions, already implemented in `@dnp/db`), [13](13-manager-onboarding.md) (teams and PII rules) and [09](09-aws-architecture.md) (WebSocket API). **Where this doc and 03 differ, this doc wins.**

## 1. Decisions (owner, 2026-11-09)

| Topic | Decision | Replaces |
|---|---|---|
| Pick clock | **Off by default.** During the draft the commissioner can **start a 90 s clock on the current pick**. On expiry it's **alert only**: everyone sees "time expired", nothing is auto-picked, and the pick waits for the manager or the commissioner. Pause clears the clock. | 03 §5 (default 90 s + autopick on expiry), 08 Q6 |
| Autopick | Only for a manager who turns on **auto-draft** for their own team, or when the commissioner clicks "Autopick for this team". Order: the manager's queue (top available eligible), else **position order**: fill the first open slot in `QB, RB1, RB2, WR1, WR2, TE, FLEX1, FLEX2, K, DST` with an eligible player, choosing by NFL team seed ascending (#1 seeds first), then name A–Z. | 03 §5 ranking (projection/ADP) |
| Draft order | **Commissioner sets it manually** (drag/arrange 1–9). No randomize. | 08 Q5 |
| FLEX | RB / WR / TE | 08 Q3 (confirmed) |
| Player pool | All active QB/RB/WR/TE/K on the 14 playoff teams + one DST per team; the commissioner can include/exclude players before the draft and while it's paused. | 08 Q9 (confirmed) |
| Start | Commissioner clicks **Start**. Requires exactly 9 teams, all 9 joined (have a manager), a full draft order, and a non-empty pool. | 03 §2 preconditions (ruleset lock deferred to task 8) |
| Undo | Commissioner only, **last pick only** (also after pick 90, before Wild Card kickoff, as in 03). | — |
| Commissioner picks | The commissioner can make the current pick for any team (`madeBy = commissioner`). | — |
| Queue | Private to its owner. | — |
| Confirmation | Every pick asks "Draft {player} → {slot}?" first. | — |
| Visibility | Board, rosters and picks are visible to all league members, labelled by **team name only** (doc 13 PII rules). | — |

Because nothing auto-picks on clock expiry, **no scheduled jobs are needed for the draft**: there are no per-pick EventBridge schedules and no backstop tick. `job-draft-tick`, the scheduler group and the related IAM/env stay unused for now (cleanup later, not in this change).

## 2. Domain logic (`@dnp/domain`, pure, 100 % branch coverage)
- `draft-order.ts`: `roundOf(pick)`, `indexInRound(pick)`, `draftPositionOnClock(pick)` (03 §1 formula), `teamOnClock(pick, orderByPosition)`, `picksForPosition(pos)`, `nextPickFor(pos, afterPick)`, `picksUntilTurn(pos, currentPick)`.
- `slot-eligibility.ts`: `assignSlot(position, filledSlots)` (03 §3 most-specific-first), `eligiblePositions(filledSlots)`, `isDraftable(position, filledSlots, remainingPoolByPosition)` with the dead-end guard.
- `autopick.ts`: `chooseAutopick({ queue, available, filledSlots, nflTeamSeeds })` → `{ playerId, slot } | null`, implementing §1's order.
- Property tests: picks 1..90 map to each team exactly 10 times with snake reversal; any sequence of `assignSlot` results fills all 10 slots; FLEX is never used while a matching base slot is open.

## 3. Player pool — sourced automatically (task 4 for rosters)
Decided 2026-11-09 by the owner: **no hand-maintained player list.** The pool is imported automatically; manual CSV is only an emergency fallback.

- **Sources** (behind a `PoolSource` interface in `apps/api/src/providers/`, so they can be swapped after the stats-provider spike, doc 12):
  - **Playoff field + seeds:** ESPN standings JSON, `https://site.api.espn.com/apis/v2/sports/football/nfl/standings?season=<year>`. For each conference (`children[].name`), take teams whose stat `playoffSeed` ≤ 7 → `abbr`, `name`, `conference` (AFC/NFC), `seed`. Verified 2026-11-09 for `season=2025` (DEN/SEA #1 … LAC/GB #7). It's unofficial and undocumented, so it must be validated defensively: exactly 7 seeds per conference, distinct, 1–7; otherwise refuse with a clear error.
  - **Players:** Sleeper `GET https://api.sleeper.app/v1/players/nfl` (free, no key, ~15 MB as of 2026-11 — Sleeper's docs say ~5 MB, "use once per day at most"; non-commercial use). Keep players whose `team` is in the field, whose `position` is one of QB/RB/WR/TE/K, whose `status` is "Active", **and who have a depth-chart entry (`depth_chart_order` not null)**. Sleeper still marks some retired players "Active" on a team (e.g. Ben Roethlisberger on PIT, 2026-11) and lists practice-squad players; neither has a depth-chart entry. Safety net: if a field team would end up with **zero** players at a draftable position, include that team's active players at that position without a depth chart, and log a warning. Measured on the 2025 field: 331 Active → 241 with depth chart, and every team keeps ≥1 K, ≥2 QB, ≥2 RB, ≥3 TE, ≥4 WR. Store `providerPlayerId` = Sleeper `player_id`, name, position, team, `injuryStatus`, and `depthChartOrder` (for display/sorting only). Plus one generated `DST-<abbr>` per playoff team.
  - **Ranking (decided 2026-11-10 by the owner):** the import stores `rank` on each player = Sleeper `search_rank` (lower = better; values ≥ 9,999,999 or missing → `null`). It's refreshed on every re-import. Generated D/STs have `rank = null`. "Ranked" order everywhere (Players list, commissioner pool review) is: `rank` ascending, then unranked D/STs by NFL team seed ascending, then other unranked players by name.
- **Last-season stats (decided 2026-11-10):** the import also fetches Sleeper `GET https://api.sleeper.app/v1/stats/nfl/regular/<seasonYear>` (one request, ~1.2 MB, keyed by Sleeper `player_id`; team defenses keyed by team abbr) and stores a per-player `stats` object with **only** these keys, plus `statsSeason`:
  - QB: `gp, pass_cmp, pass_att, pass_yd, pass_td, pass_int, rush_yd, rush_td`
  - RB: `gp, rush_att, rush_yd, rush_td, rec, rec_yd, rec_td`
  - WR/TE: `gp, rec_tgt, rec, rec_yd, rec_td, rush_yd`
  - K: `gp, fgm, fga, fgm_50p, xpm, xpa`
  - DST (from the team-abbr entry): `gp, sack, int, fum_rec, def_td, def_st_td, pts_allow`

  Missing keys → 0 if the player has any stats entry, else `stats = null` (shown as "—", e.g. rookies or players who didn't play). Stats are refreshed on every re-import. They are display-only and never used for scoring.
- **Team abbreviation mapping** between ESPN and Sleeper (e.g. `WSH`↔`WAS`) lives in one tested table. Import fails loudly if any field team has zero players after mapping.
- **Import:** commissioner route `POST /seasons/:id/pool/import { seasonYear }` (sync; http Lambda timeout raised to 29 s). It's allowed while the draft is `scheduled` or `paused`.
  - It upserts `NFLTEAM#` and `PLAYER#` items (idempotent, keyed by `providerPlayerId`).
  - Players no longer returned are marked `inPool=false` (never deleted, never changed if already drafted).
  - Commissioner `inPool` overrides are preserved across re-imports via a `manualOverride` flag.
  - It records `POOLIMPORT` meta (`importedAt`, `source`, `counts`) and an audit event.
  - The same logic is exposed as `pnpm admin import-pool --env <env> --season-year <y>` (fetches the same sources).
- **Commissioner review:** `GET /seasons/:id/players` (member) and `PATCH /seasons/:id/players/:playerId { inPool }`, `POST /seasons/:id/players` (manual add, e.g. a late call-up) for the commissioner. Audited.
- **Fallback / tests:** `pnpm admin import-pool --from-csv teams.csv players.csv` (emergency only) and `pnpm admin seed-pool` (synthetic fictional pool for unit/e2e tests; refuses prod). Automated tests never hit the network; they use small trimmed fixtures recorded from the real sources.
- **DEV/TEST realism:** import **last season's real field** (`seasonYear 2025`) for mock drafts.

## 4. Draft state & API
`DRAFT` item (doc 10 §2) gains: `order: string[]` (teamIds by draft position 1..9), `clockStartedAt?`, `clockSeconds?` (90), `clockExpiresAt?`, `autoDraft: string[]` (teamIds with auto-draft on). Statuses: `scheduled` (setup) → `in_progress` ⇄ `paused` → `complete`, plus `resetting` (transient lock during a redraft, §4a). Season `META` (and the league's season pointer, see doc 11 §8) goes `setup → drafting` on start and `drafting → in_progress` at pick 90 (existing `recordPick` already does the latter for META; update the pointer too).

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /seasons/:id/draft` | member | **Snapshot**: status, order (teamIds + names), currentPick, onClockTeamId, round, clock (`startedAt`, `expiresAt`, `expired`), picks (`overallPick, round, teamId, playerId, slot, madeBy`), rosters per team, available players (id, name, position, nflTeam, seed, injury, `opponent?`), `myTeamId`, `myQueue` (own only), `myAutoDraft`, `version` (= number of picks made + status changes; increases monotonically). |
| `PUT /seasons/:id/draft/order` | commissioner | `{ order: teamId[9] }`, only while `scheduled`. Sets `TEAM.draftPosition` too. |
| `POST /seasons/:id/draft/start` · `/pause` · `/resume` | commissioner | Lifecycle (doc 10 §4.3 conditional updates + audit). Start checks §1 preconditions (409 with a reason code). Pause clears the clock. |
| `POST /seasons/:id/draft/clock` | commissioner | Starts a 90 s clock on the current pick (`in_progress` only); `DELETE` clears it. |
| `POST /seasons/:id/draft/picks` | team on clock or commissioner | `{ playerId, expectedPick, teamId? }` (commissioner may pass `teamId` = the on-clock team). Server: on-clock check, `isDraftable`, `assignSlot`, then `recordPick` (doc 10 §4.1). Errors: 409 `stale_pick`, `not_your_turn`, `player_taken`, `not_eligible`, `slot_filled`, `draft_not_active`. Then runs the **auto-draft chain** (§5). |
| `POST /seasons/:id/draft/autopick` | commissioner | Autopick for the on-clock team now (`madeBy = autopick`), with `expectedPick`. |
| `POST /seasons/:id/draft/undo` | commissioner | `undoLastPick` (doc 10 §4.2). |
| `POST /seasons/:id/draft/reset` | commissioner | Redraft (§4a). Body `{ confirm: "REDRAFT" }` (400 otherwise). Returns `{ status, version, currentPick, picksCleared }`. |
| `GET/PUT /seasons/:id/draft/queue` | team owner | `{ playerIds: [] }` (≤ 100), own team only; drafted players are filtered out on read. |
| `PUT /seasons/:id/draft/auto-draft` | team owner | `{ enabled }`. If enabling while on the clock, the server autopicks immediately. |
| `GET /seasons/:id/players` | member | Pool (for the pre-draft player list). |

Commissioner actions are audited (ids only).

### 4a. End of draft and Redraft
**End of draft** (owner, 2026-11-10: "once all selections are made the draft should end"). The transaction that records pick 90 (doc 10 §4.1) atomically sets `DRAFT.status = complete`, `currentPick = 91`, `currentPickDeadline = null`, removes the clock fields (even if a 90 s clock was running), and moves season `META` and the league pointer to `in_progress`. From then on the server rejects with 409: picks and autopick (`draft_not_active`), clock start (`draft_not_active`) and clear, pause, resume, start, order and auto-draft changes (`draft_wrong_status`). The auto-draft chain stops at 90 (`currentPick > 90`). The snapshot has `onClockTeamId = null`, `round = null`, `clock = null`; the room shows "Draft complete" (no banner, no on-the-clock strip, no clock, no Draft buttons, board by default). Only undo of pick 90 is possible (commissioner): it returns the draft to `in_progress` at pick 90 (META/pointer back to `drafting`, clock cleared).

**Redraft** (commissioner, owner request 2026-11-10). Resets a draft that has started (`in_progress`, `paused`, `complete`; 409 `draft_wrong_status` before that, or once the season is past the draft) so the commissioner can press Start again. Storage recipe: doc 10 §4.8 (lock to `resetting`, chunked idempotent cleanup, finalize). Effects: all picks and draft roster entries removed, every drafted player available again, `DRAFT` back to `scheduled` with `currentPick = 1`, no clock, `startedAt = null`, `version` incremented, season `META` and pointer back to `setup`. Kept: draft order, teams and abbreviations, memberships, the player pool, per-manager queues and auto-draft toggles. Audit `draft.reset` `{ picksCleared }`; broadcast `draft_changed { kind: "reset" }`. While `resetting` the snapshot reports that status (no on-the-clock team, no clock) and the room shows a read-only "Resetting the draft" notice; calling the endpoint again resumes an interrupted reset. Auto-draft is not run by a redraft: the commissioner presses Start (teams that kept auto-draft on will then chain).
UI: Commissioner tab, "Draft setup" section, once the draft has started: a danger "Redraft" button with "Clears all N picks and returns the draft to the lobby. Order, teams, queues and auto-draft settings are kept.", opening a dialog that requires typing `REDRAFT`. On success the setup data reloads so the order and Start controls reappear. The "Draft complete" banner shows a "Draft again" link to the Commissioner tab for the commissioner only. Members never see either.

## 5. Auto-draft chain
After any pick (or when auto-draft is enabled), while the next on-clock team has auto-draft on and the draft is `in_progress`: compute `chooseAutopick` and `recordPick(madeBy = "autopick")`, with up to 90 iterations in one request. Each pick is its own transaction, so a concurrent manual pick causes a clean `stale_pick` stop. Each autopick is broadcast like any pick.

## 6. Realtime
- **Ticketed WebSocket auth** (no tokens or PII in URLs):
  1. `POST /realtime/ticket` (signed-in) → `{ ticket, wsUrl }`, where the ticket is 32 random bytes, stored as `WSTICKET#<sha256(ticket)>` with `userId` and TTL 60 s.
  2. The client connects to `wss://…?ticket=…`.
  3. `ws-connect` consumes the ticket (conditional delete) and stores `userId` on the connection; an invalid ticket is rejected.
  4. `ws-default` `subscribe` requires membership of the league that owns the channel: `draft:<seasonId>`.
- **Events** on `draft:<seasonId>`: `draft_changed { version, kind: "pick"|"undo"|"status"|"clock"|"order", pick? }`. Clients **refetch the snapshot** on any event whose `version` > the local one, and on (re)connect. Simple and always consistent at this scale. Events carry no PII and no queues.
- Broadcast from the http Lambda after each successful write (publisher already exists). Failures to broadcast never fail the request.
- **Fallback polling**: if the socket is down, the draft room polls the snapshot every 5 s.
- Local dev: no API Gateway WebSocket. The local server exposes the same protocol on `ws://localhost:3002` (the `ws` package), with the same ticket flow, so the UI code path is identical.

## 7. Draft room UI (v2, owner layout 2026-11-10; replaces the earlier 3-column layout)
- **Header banner** (unchanged): `Round R · Pick N of 90`, on-the-clock team, "You pick in K (pick P)", clock countdown when started (red "Time expired" when expired), paused banner, connection dot.
- **On-the-clock strip** (2026-11-10, owner): a horizontal row of small boxes **between the header banner and the three panes**, replacing the right pane's "On the clock" card. Box 1 (highlighted) is the on-clock pick: `#N`, team abbreviation, team name, the clock countdown when started ("Time expired" when expired), and "You" if it's mine. Boxes 2–9 are the next 8 picks in snake order (crossing rounds; a round divider marker where the round changes): `#N` + abbreviation, with mine marked. Shown only while `in_progress`/`paused`. On phone it scrolls horizontally, with the current box first. Clicking a box shows that team's roster in the left pane.
- **Desktop layout:** three columns.

  | Left (≈ 20 %) | Center (main, ≈ 55 %) | Right (≈ 25 %) |
  |---|---|---|
  | **Roster**: my 10 slots by default (labels without numbers: `RB`, `WR`, `FLEX`; no position badge beside the name except a small muted tag on FLEX slots; the full player name wraps, never truncates); a team selector to view any team's roster (team names only); the commissioner (no team) starts on the on-clock team. Clicking a pick in the right pane switches this pane to that team. | **Players list** (default) **or Draft board**, switched by a prominent toggle button `Players ⇄ Board` at the top of the center column. | **My queue** (reorder up/down, remove, auto-draft toggle) → **Drafted players**, chronological (oldest at the top, newest at the bottom; auto-scrolls to the newest pick while the viewer is within ~40 px of the bottom, never yanks them away from history): `#pick · R · ABBR · player · pos · NFL team`, live-updating. |

- **Phone (< 768 px):** tabs `Players | Board | Roster | Queue | Picks` (same panes).
- **Players list** (the main feature):
  - **Filters:** search; position (All/QB/RB/WR/TE/K/DST); NFL team; "Hide ineligible" (default on). All combine.
  - **Default sort:** overall rank (§3). **Stat columns are sortable** (click the header: desc → asc → back to rank); the rank column is sortable too.
  - **Columns:** `Rank · Player (name, injury tag) · Pos · NFL team ·` (no seed number; seed stays in the data and the detail panel) then last-season stats depending on the position filter:
    - All: GP, Pass Yd, Pass TD, Rush Yd, Rush TD, Rec, Rec Yd, Rec TD (blank where N/A)
    - QB: GP, Cmp/Att, Pass Yd, Pass TD, INT, Rush Yd, Rush TD
    - RB: GP, Rush Att, Rush Yd, Rush TD, Rec, Rec Yd, Rec TD
    - WR/TE: GP, Tgt, Rec, Rec Yd, Rec TD, Rush Yd
    - K: GP, FGM/FGA, FG 50+, XPM/XPA
    - DST: GP, Sacks, INT, Fum Rec, Def TD, ST TD, Pts Allowed

    Then the actions `★ Queue` and `Draft` (enabled only on my turn and only for eligible players; **Draft submits the pick immediately, with no confirmation**: the button is disabled while the request is in flight and errors show inline in the room's error banner). A header note says "Stats: <statsSeason> regular season".
  - **Phone:** the table collapses to rows showing rank, name, pos/team, the 2–3 headline stats for the position, and actions.
- **Player detail panel** (click a player name): a side drawer on desktop, a bottom sheet on phone. It opens with a **face card**: a 96 px headshot (lazy-loaded, empty `alt`) beside the name, position badge, NFL team and injury chip, falling back to an initials avatar when `headshotUrl` is null or the image fails to load (no headshots in table rows). `availablePlayer.headshotUrl` is built server-side (`apps/api/src/draft/headshots.ts`): Sleeper players `sleepercdn.com/content/nfl/players/<providerPlayerId>.jpg`, DST the Sleeper team logo (ESPN abbr mapped to Sleeper's, e.g. WSH to was), synthetic/manual rows `null`. It also shows the full last-season stat line for the position, games played, injury status, NFL team + seed + Wild Card opponent or BYE, rank, and Queue / Draft buttons. No PII. It closes with Esc or the close button.
- **Draft board** (center, via the toggle): the 10×9 grid as before (column headers = team abbreviation with the full team name as a tooltip, in draft order, position colours, current pick highlighted, auto-draft badges).
- **Your-turn alert:** when the viewer's team comes on the clock, the browser tab title flashes ("⏰ Your pick! – Draft & Pray") until the page is focused. The beep follows the sound toggle (on by default), remembered in `localStorage` (try/catch); `navigator.vibrate` on phones when supported. It never fires for picks made by the viewer themself.
- **Sounds** (Web Audio, no files; one **Sound on/off** toggle in the room header, **on by default** unless `localStorage dnp.draft.sound` is `"0"`; muting silences everything including the your-turn beep): a two-note chime when the viewer enters the room (if the browser blocks audio it plays on the first pointerdown/keydown instead); a 3-note rising fanfare when the draft goes `scheduled`/`lobby`/paused-before-the-first-pick to `in_progress` while the viewer is in the room (never on first load); a ~1.5 s square-wave alarm once per clock when the countdown hits zero (keyed on the clock's `startedAt`/`expiresAt`; not if it was already expired on arrival), for everyone in the room. Logic lives in `useRoomSounds`.
- **Commissioner panel** (unchanged functionality): order (pre-start), Start, Pause/Resume, clock, make pick for the on-clock team, autopick, undo, pool include/exclude. It sits in a collapsible bar under the header, so the three columns keep their space.
- Pre-draft lobby and complete states are as before. After completion the center defaults to the Board.

### Team abbreviations (2026-11-10, owner)
- `TEAM.abbr`: 2–4 characters A–Z/0–9, uppercase, **unique within the season**.
- **Default** (set on team creation; backfilled lazily for older teams with a conditional write that never overwrites a custom value): strip a leading "Team " (case-insensitive), remove non-alphanumerics, uppercase, take the first 4 characters (fewer than 2 left → `TM`). On a clash within the season, replace the last character with 2, 3, … Examples: "Team Alpha" → `ALPH`, "Team Smith" → `SMIT`, "Red Zone" → `REDZ`, "Team Al" → `AL`.
- **Editable** by the team owner or the commissioner wherever the team name is edited (League home rename, commissioner Team names, welcome card). Validation: 409 `team_abbr_taken`, 400 for invalid format. Renaming a team does **not** change a custom abbreviation; it recomputes only if the abbreviation is still the auto-default.
- Used in the on-the-clock strip, the board column headers and the drafted list. Team names remain the primary label elsewhere. No PII beyond the (owner-chosen) team name.

## 8. Testing
- **Domain:** exhaustive unit and property tests (§2).
- **API/db (DynamoDB Local):** order/start preconditions; each pick error code; commissioner pick; clock start/expiry flag; pause clears the clock; auto-draft chain (several consecutive auto teams, stops on a manual team); undo, including after completion; a concurrent-pick race; queue privacy (another team's queue is never in any response); snapshot has no PII keys; ticket single-use and expiry; subscribe membership check.
- **Web:** draft room states (lobby, my turn, not my turn, expired clock, paused, complete), immediate pick submit (double click sends one), face card, filters, room sounds, queue reorder, commissioner controls, reconnect-and-refetch logic (mock socket).
- **Local e2e (Playwright):** a 9-team league (commissioner + 8 dev-signed-in managers created via the managers API), seeded pool, order set, start. Two real browser contexts draft while the other 7 teams use auto-draft; complete all 90 picks; undo the last pick; both contexts see consistent boards.
- **DEV smoke:** a full 90-pick draft in the Test League via the API with test users (auto-draft for most teams), checking WebSocket events arrive via a ticketed connection.
