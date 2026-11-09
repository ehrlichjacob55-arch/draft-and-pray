# 10 — DynamoDB Data Model (supersedes the storage parts of 02)

Decided 2026-11-09: the database is **DynamoDB**, so everything stays in AWS. The *entities and invariants* in [02-domain-model](02-domain-model.md) still define what the app stores and guarantees; this doc defines **how** they're stored. Where 02 says "unique constraint" or "row lock", read the matching conditional write or transaction below.

## 1. Approach

- **One application table**, `dnp-<env>-app`, using the single-table pattern: `pk` (S), `sk` (S), plus one GSI `gsi1` (`gsi1pk`, `gsi1sk`). On-demand billing, PITR on in prod. The WebSocket connection table from 09 §4 stays separate.
- **Season-partitioned.** Nearly all game data lives under `pk = SEASON#<seasonId>`. A season is small (≈ 400 players, ≈ 13 games, ≈ 600 stat lines, 90 picks, well under 2 MB), so the server can **load the whole season with one paginated Query** and compute in memory. Standings, scoring recomputes and "players alive" are pure functions in `@dnp/domain` over that in-memory snapshot. They are not database queries.
- **Invariants via conditions.** Uniqueness = `attribute_not_exists(pk)` on a deterministic key. Draft serialization = a condition on the draft item's `currentPick`. Multi-item changes use `TransactWriteItems` (≤ 100 items), so they're all-or-nothing.
- **Strongly consistent reads** for anything that feeds a write decision (draft state, roster before a pick).
- **Access:** `@aws-sdk/lib-dynamodb` (DocumentClient) behind a thin repository layer in `@dnp/db`. All key strings are built in one module (`keys.ts`), and every item type has a zod schema. No ORM.
- **IDs:** ULIDs (sortable) for leagues, seasons, teams, players, audit events. DST players use `DST-<NFL abbr>`. Numbers inside sort keys are zero-padded (`PICK#007`).

## 2. Item catalog

`E` = entity type, stored as the attribute `type` on every item.

### Global partitions
| Entity | pk | sk | gsi1pk / gsi1sk | Key attributes |
|---|---|---|---|---|
| User | `USER#<userId>` | `PROFILE` | `EMAIL#<email>` / `USER` | userId (= Cognito `sub`), email, displayName |
| League | `LEAGUE#<leagueId>` | `META` | — | name, createdAt |
| League member | `LEAGUE#<leagueId>` | `MEMBER#<userId>` | `USER#<userId>` / `LEAGUE#<leagueId>` | role `commissioner`\|`manager` |
| Season pointer | `LEAGUE#<leagueId>` | `SEASON#<year>` | — | seasonId, status |
| Invite | `INVITE#<token>` | `META` | — | leagueId, seasonId, expiresAt (TTL), usedBy? |

### Season partition: `pk = SEASON#<seasonId>`
| Entity | sk | Key attributes |
|---|---|---|
| Season meta | `META` | leagueId, year, status `setup\|drafting\|in_progress\|complete`, activeRulesetVersion |
| Scoring ruleset | `RULESET#v<NNN>` | version, rules (JSON map), locked, createdAt |
| Fantasy team | `TEAM#<teamId>` | name, managerUserId, draftPosition |
| Draft state | `DRAFT` | status `scheduled\|lobby\|in_progress\|paused\|complete`, pickSeconds, currentPick, currentPickDeadline, startedAt, updatedAt |
| Draft pick | `PICK#<NNN>` | overallPick, round, teamId, playerId, slot, madeBy `manager\|autopick\|commissioner`, madeByUserId, madeAt |
| Draft queue | `QUEUE#<teamId>` | playerIds (ordered list), updatedAt |
| Roster slot entry | `ROSTER#<teamId>#<slot>#<fromRound>` | teamId, slot, playerId, fromRound (1=WC…4=SB), acquiredVia `draft\|exception`, txnId? |
| NFL team | `NFLTEAM#<abbr>` | conference, seed, status `alive\|bye\|eliminated\|champion`, eliminatedInRound? |
| Player | `PLAYER#<playerId>` | name, position, nflTeam, providerPlayerId, injuryStatus, inPool, draftedByTeamId?, draftedAtPick?, rank? |
| Playoff round | `ROUND#<n>` | code `WC\|DIV\|CONF\|SB`, status `upcoming\|live\|final\|finalized`, finalizedAt?, finalizedBy? |
| NFL game | `GAME#<gameId>` | round, providerGameId, home, away, kickoff, status, homeScore, awayScore, winner? |
| Raw stat line | `STATS#<gameId>#<playerId>` | raw (provider fields), canonical (map), fetchedAt, providerHash |
| Stat override | `OVERRIDE#<gameId>#<playerId>#<statKey>` | value, reason, byUserId, at |
| Player-game points | `POINTS#<gameId>#<playerId>` | round, points, breakdown, rulesetVersion, computedAt |
| Team round score | `TEAMSCORE#<n>#<teamId>` | points, provisional, computedAt |
| Roster transaction | `TXN#<ulid>` | teamId, slot, playerOutId, playerInId, reason, effectiveRound, byUserId |
| Audit event | `AUDIT#<ulid>` | actorUserId, action, details, at |

**Roster history replaces 02's single `ROSTER_SLOT` row.** The draft writes `ROSTER#<team>#<slot>#1`. A roster exception effective in the Divisional round writes `…#2`. The player who counts for slot S in round r is the entry with the greatest `fromRound ≤ r`. This resolves the 02/04 conflict between "one player per slot" and "a slot can change by round".

## 3. Access patterns

| # | Pattern | Operation |
|---|---|---|
| A1 | Load an entire season (draft room snapshot, standings, recompute) | `Query pk = SEASON#<id>` (paginate) |
| A2 | Load one slice of a season (e.g. only picks, only players) | `Query pk = SEASON#<id>, begins_with(sk, "PICK#")` |
| A3 | Draft state for a pick decision | `GetItem DRAFT` (consistent) |
| A4 | A team's roster | `Query begins_with(sk, "ROSTER#<teamId>#")` (consistent) |
| A5 | My leagues | `Query gsi1 gsi1pk = USER#<userId>` |
| A6 | User by email (invites, admin) | `Query gsi1 gsi1pk = EMAIL#<email>` |
| A7 | League members, seasons | `Query pk = LEAGUE#<id>` |
| A8 | Redeem invite | `GetItem INVITE#<token>` then a transaction (§4.5) |
| A9 | Audit log, newest first | `Query begins_with(sk, "AUDIT#")`, `ScanIndexForward=false` |
| A10 | Standings | `Query begins_with(sk, "TEAMSCORE#")` + teams + NFL teams (or A1) |
| A11 | Player page | `Query begins_with(sk, "POINTS#")` filtered in memory by playerId, plus `STATS#` / `OVERRIDE#` for the games (small enough to filter in memory) |

No Scans anywhere.

## 4. Write recipes (transactions)

### 4.1 Make a pick (manager, autopick or commissioner)
Pre-read (consistent): `DRAFT`, the team's `ROSTER#<team>#…` entries and the `PLAYER`. Compute in `@dnp/domain`: the on-clock team for `expectedPick`, slot eligibility and the chosen slot. Then `TransactWriteItems`:
1. **Update `DRAFT`**: `SET currentPick = :next, currentPickDeadline = :dl, updatedAt = :now`, with condition `status = :in_progress AND currentPick = :expected`. This serializes picks (02 I-5); a stale tab or double-click fails here.
2. **Put `PICK#<NNN>`**, with condition `attribute_not_exists(pk)` (I-2).
3. **Update `PLAYER#<id>`**: `SET draftedByTeamId, draftedAtPick`, with condition `inPool = :true AND attribute_not_exists(draftedByTeamId)` (I-1).
4. **Put `ROSTER#<team>#<slot>#1`**, with condition `attribute_not_exists(pk)` (I-3).
5. **Put `AUDIT#<ulid>`**.

If the pick number reaches 90, item 1 also sets `status = complete`, `currentPick = 91` and `currentPickDeadline = null`, and a sixth item sets the season `META` status to `in_progress`. (`currentPick` is always "next pick", so the undo rule `currentPick = n+1` holds even after the last pick.) Autopicks write `AUDIT.actorUserId = null`. On `TransactionCanceledException`, map `CancellationReasons` to a 409 (stale pick / player taken / slot filled) and return a fresh snapshot.

### 4.2 Undo last pick (commissioner)
Read `DRAFT` (currentPick = n+1) and `PICK#n`. Then one transaction: update `DRAFT` (condition `currentPick = :n1`, set it to n, set a fresh deadline, restore status `in_progress` if it was `complete`); a paused draft stays paused), delete `PICK#n` (condition exists), `REMOVE draftedByTeamId, draftedAtPick` on the player, delete `ROSTER#…#1`, and put an `AUDIT` item. When undoing from `complete`, a sixth item sets season `META` back to `drafting`. A missing `PICK#n` is reported as a conflict (label `pick`) so the API can return 409.

### 4.3 Draft lifecycle (start / pause / resume)
Single `UpdateItem` on `DRAFT`, with a condition on the current status (e.g. pause requires `in_progress`), plus an `AUDIT` item in the same transaction.

### 4.4 Ingest and recompute (job-ingest, override, ruleset change, exception)
1. Upsert `GAME#` and `STATS#` items. Skip the write when `providerHash` is unchanged, so the job stays idempotent.
2. Update `NFLTEAM#` statuses on final games (elimination).
3. Load the season (A1), then call the pure function `computeSeason(snapshot)` → `POINTS#` and `TEAMSCORE#` items **for non-finalized rounds only**.
4. `BatchWriteItem` (chunks of 25) for the changed points and score items. Broadcast `scores_updated`.

**Finalized rounds are frozen by construction.** Recompute never writes `POINTS#`/`TEAMSCORE#` for a round whose status is `finalized`. Unfreezing (commissioner, audited) sets the round back to `final`, and the next recompute updates it. A new ruleset version therefore applies to non-finalized rounds unless the commissioner unfreezes. This resolves the 04 conflict between "recompute anytime" and "finalized is frozen".

### 4.5 Redeem invite
Transaction: update `INVITE#` (condition `attribute_not_exists(usedBy) AND expiresAt > :now`), put the `MEMBER#` item (condition not exists), put the `TEAM#` item.

### 4.6 Roster exception (commissioner)
Transaction: put `ROSTER#<team>#<slot>#<effectiveRound>` (condition not exists), put `TXN#`, update the new `PLAYER#` (`draftedByTeamId`, with condition not already owned), put `AUDIT#`.

### 4.7 Stat override
Put `OVERRIDE#…` + `AUDIT#` in one transaction, then run recompute (4.4 step 3–4).

## 5. Mapping the invariants from 02

| 02 invariant | DynamoDB enforcement |
|---|---|
| I-1 player drafted once | Condition `attribute_not_exists(draftedByTeamId)` on the `PLAYER` item (4.1 item 3) |
| I-2 pick number used once | `attribute_not_exists` on `PICK#<NNN>` |
| I-3 one player per slot | `attribute_not_exists` on `ROSTER#<team>#<slot>#<fromRound>` |
| I-4 eligible slot only | `@dnp/domain` slot eligibility, checked before the transaction; item 4 guards the race |
| I-5 only the on-clock team picks | Server-side check plus the `currentPick` condition |
| I-6 ruleset locked / finalized frozen | Condition on `RULESET.locked` for edits; recompute skips finalized rounds |
| I-7 9 teams / 10 slots / 90 picks | Season-setup validation; the pick transaction completes the draft at 90 |

## 6. Local dev & tests

- **DynamoDB Local** (AWS's official emulator, Java) supports transactions and condition expressions. `pnpm ddb:local` downloads it into `.dynamodb-local/` (gitignored) and runs it on `:8000`, persisted to `.dynamodb-local/data`.
- Test suites start their own in-memory DynamoDB Local on a random port (vitest global setup) and create the table from the **same table definition** (`packages/db/src/table.ts`) that Terraform mirrors.
- Env: `APP_TABLE` (table name), `DYNAMODB_ENDPOINT` (set only locally, e.g. `http://localhost:8000`), `AWS_REGION`.
- There are no migrations. The schema lives in code (zod) and every item carries `type`; future shape changes are handled in code or by one-off backfill scripts.

## 7. Cost
On-demand at this scale is pennies: ≈ 0.6 KB items, a few hundred thousand requests per season. Storage is far under the 25 GB permanent free allowance.
