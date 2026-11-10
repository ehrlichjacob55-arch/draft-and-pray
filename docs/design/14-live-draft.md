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
`DRAFT` item (doc 10 §2) gains: `order: string[]` (teamIds by draft position 1..9), `clockStartedAt?`, `clockSeconds?` (90), `clockExpiresAt?`, `autoDraft: string[]` (teamIds with auto-draft on). Statuses: `scheduled` (setup) → `in_progress` ⇄ `paused` → `complete`. Season `META` (and the league's season pointer, see doc 11 §8) goes `setup → drafting` on start and `drafting → in_progress` at pick 90 (existing `recordPick` already does the latter for META; update the pointer too).

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /seasons/:id/draft` | member | **Snapshot**: status, order (teamIds + names), currentPick, onClockTeamId, round, clock (`startedAt`, `expiresAt`, `expired`), picks (`overallPick, round, teamId, playerId, slot, madeBy`), rosters per team, available players (id, name, position, nflTeam, seed, injury, `opponent?`), `myTeamId`, `myQueue` (own only), `myAutoDraft`, `version` (= number of picks made + status changes; increases monotonically). |
| `PUT /seasons/:id/draft/order` | commissioner | `{ order: teamId[9] }`, only while `scheduled`. Sets `TEAM.draftPosition` too. |
| `POST /seasons/:id/draft/start` · `/pause` · `/resume` | commissioner | Lifecycle (doc 10 §4.3 conditional updates + audit). Start checks §1 preconditions (409 with a reason code). Pause clears the clock. |
| `POST /seasons/:id/draft/clock` | commissioner | Starts a 90 s clock on the current pick (`in_progress` only); `DELETE` clears it. |
| `POST /seasons/:id/draft/picks` | team on clock or commissioner | `{ playerId, expectedPick, teamId? }` (commissioner may pass `teamId` = the on-clock team). Server: on-clock check, `isDraftable`, `assignSlot`, then `recordPick` (doc 10 §4.1). Errors: 409 `stale_pick`, `not_your_turn`, `player_taken`, `not_eligible`, `slot_filled`, `draft_not_active`. Then runs the **auto-draft chain** (§5). |
| `POST /seasons/:id/draft/autopick` | commissioner | Autopick for the on-clock team now (`madeBy = autopick`), with `expectedPick`. |
| `POST /seasons/:id/draft/undo` | commissioner | `undoLastPick` (doc 10 §4.2). |
| `GET/PUT /seasons/:id/draft/queue` | team owner | `{ playerIds: [] }` (≤ 100), own team only; drafted players are filtered out on read. |
| `PUT /seasons/:id/draft/auto-draft` | team owner | `{ enabled }`. If enabling while on the clock, the server autopicks immediately. |
| `GET /seasons/:id/players` | member | Pool (for the pre-draft player list). |

Commissioner actions are audited (ids only).

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

## 7. Draft room UI (doc 06 §3–4)
- **Header banner**: `Round R · Pick N of 90`, on-the-clock team, "You pick in K (pick P)", the clock countdown when started (red + "Time expired" when expired), and a connection status dot.
- **Phone**: tabs `Players | Queue | Roster | Board`. **Desktop**: three columns (players + queue | board | my roster).
- **Players**: search; filters by position and NFL team; "Hide ineligible" (default on, uses `isDraftable` client-side for the viewer's team); each row shows position, name, NFL team (seed), injury tag and buttons ★Queue / Draft (Draft is enabled only when it's your turn and the player is eligible) → confirmation sheet "Draft {name} → {slot}?".
- **Queue**: reorder (drag on desktop, up/down buttons on phone), remove, and an auto-draft toggle with an explanation.
- **Roster**: the 10 slots for my team; a picker to view other teams' rosters.
- **Board**: a 10×9 grid, with columns = teams in draft order (team names), cells colour-coded by position and the current pick highlighted.
- **Commissioner panel** (only for the commissioner): set the draft order (before start), Start, Pause/Resume, Start 90 s clock / Clear clock, Make pick for on-clock team (uses the same player list), Autopick for team, Undo last pick (with confirm), and pool include/exclude before start.
- Pre-draft: League home links to the Draft room, which shows a lobby (order and teams, "waiting for commissioner to start"). After pick 90: "Draft complete", final rosters.

## 8. Testing
- **Domain:** exhaustive unit and property tests (§2).
- **API/db (DynamoDB Local):** order/start preconditions; each pick error code; commissioner pick; clock start/expiry flag; pause clears the clock; auto-draft chain (several consecutive auto teams, stops on a manual team); undo, including after completion; a concurrent-pick race; queue privacy (another team's queue is never in any response); snapshot has no PII keys; ticket single-use and expiry; subscribe membership check.
- **Web:** draft room states (lobby, my turn, not my turn, expired clock, paused, complete), confirmation sheet, filters, queue reorder, commissioner controls, reconnect-and-refetch logic (mock socket).
- **Local e2e (Playwright):** a 9-team league (commissioner + 8 dev-signed-in managers created via the managers API), seeded pool, order set, start. Two real browser contexts draft while the other 7 teams use auto-draft; complete all 90 picks; undo the last pick; both contexts see consistent boards.
- **DEV smoke:** a full 90-pick draft in the Test League via the API with test users (auto-draft for most teams), checking WebSocket events arrive via a ticketed connection.
