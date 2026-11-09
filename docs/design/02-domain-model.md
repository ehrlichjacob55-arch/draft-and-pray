# 02 — Domain Model

> **Storage note (2026-11-09):** the database is DynamoDB. The entities, relationships and invariants below still define *what* is stored and guaranteed; [10-dynamodb-data-model](10-dynamodb-data-model.md) defines *how* (keys, transactions, conditional writes). Column types like `uuid`/`jsonb` are conceptual. `ROSTER_SLOT` is stored as per-round history entries (10 §2).

## 1. Entity-relationship diagram

```mermaid
erDiagram
    USER ||--o{ LEAGUE_MEMBER : "belongs to"
    LEAGUE ||--o{ LEAGUE_MEMBER : has
    LEAGUE ||--o{ SEASON : runs
    SEASON ||--o{ FANTASY_TEAM : has
    LEAGUE_MEMBER ||--o{ FANTASY_TEAM : manages
    SEASON ||--|| SCORING_RULESET : uses
    SEASON ||--|| DRAFT : has
    DRAFT ||--o{ DRAFT_PICK : contains
    FANTASY_TEAM ||--o{ DRAFT_PICK : makes
    PLAYER ||--o| DRAFT_PICK : "drafted in"
    FANTASY_TEAM ||--o{ ROSTER_SLOT : has
    PLAYER ||--o{ ROSTER_SLOT : fills
    FANTASY_TEAM ||--o{ DRAFT_QUEUE_ITEM : queues
    SEASON ||--o{ NFL_TEAM_SEASON : "playoff field"
    NFL_TEAM_SEASON ||--o{ PLAYER : rosters
    SEASON ||--o{ PLAYOFF_ROUND : has
    PLAYOFF_ROUND ||--o{ NFL_GAME : contains
    NFL_GAME ||--o{ PLAYER_GAME_STATS : produces
    PLAYER ||--o{ PLAYER_GAME_STATS : records
    PLAYER_GAME_STATS ||--o{ STAT_OVERRIDE : "corrected by"
    PLAYER_GAME_STATS ||--|| PLAYER_GAME_POINTS : "scored as"
    FANTASY_TEAM ||--o{ TEAM_ROUND_SCORE : earns
    PLAYOFF_ROUND ||--o{ TEAM_ROUND_SCORE : "scored in"
    FANTASY_TEAM ||--o{ ROSTER_TRANSACTION : "subject of"
    SEASON ||--o{ AUDIT_EVENT : logs

    USER {
        uuid id PK
        string email
        string display_name
    }
    LEAGUE {
        uuid id PK
        string name
    }
    LEAGUE_MEMBER {
        uuid id PK
        uuid league_id FK
        uuid user_id FK
        string role "commissioner | manager"
    }
    SEASON {
        uuid id PK
        uuid league_id FK
        int year "e.g. 2026 = 2026-27 playoffs"
        string status "setup | drafting | in_progress | complete"
        uuid ruleset_id FK
    }
    FANTASY_TEAM {
        uuid id PK
        uuid season_id FK
        uuid manager_member_id FK
        string name
        int draft_position
    }
    SCORING_RULESET {
        uuid id PK
        jsonb rules
        bool locked
        int version
    }
    DRAFT {
        uuid id PK
        uuid season_id FK
        string status "scheduled | lobby | in_progress | paused | complete"
        int pick_seconds "null = no clock"
        int current_overall_pick
        timestamp current_pick_deadline
    }
    DRAFT_PICK {
        uuid id PK
        uuid draft_id FK
        int overall_pick
        int round
        uuid fantasy_team_id FK
        uuid player_id FK
        string slot
        string made_by "manager | autopick | commissioner"
        timestamp made_at
    }
    DRAFT_QUEUE_ITEM {
        uuid fantasy_team_id FK
        uuid player_id FK
        int rank
    }
    ROSTER_SLOT {
        uuid fantasy_team_id FK
        string slot "QB RB1 RB2 WR1 WR2 TE FLEX1 FLEX2 DST K"
        uuid player_id FK
        string acquired_via "draft | exception"
    }
    NFL_TEAM_SEASON {
        uuid id PK
        uuid season_id FK
        string abbr
        string conference "AFC | NFC"
        int seed
        string status "alive | bye | eliminated | champion"
        string eliminated_in_round
    }
    PLAYER {
        uuid id PK
        string provider_player_id
        uuid nfl_team_season_id FK
        string name
        string position "QB RB WR TE K DST"
        string injury_status
        bool in_pool
    }
    PLAYOFF_ROUND {
        uuid id PK
        uuid season_id FK
        string code "WC | DIV | CONF | SB"
        int ordinal
        string status "upcoming | live | final | finalized"
    }
    NFL_GAME {
        uuid id PK
        uuid round_id FK
        string provider_game_id
        string home_abbr
        string away_abbr
        timestamp kickoff
        string status "scheduled | in_progress | final"
        string winner_abbr
    }
    PLAYER_GAME_STATS {
        uuid id PK
        uuid player_id FK
        uuid game_id FK
        jsonb raw_stats "from provider"
        timestamp fetched_at
    }
    STAT_OVERRIDE {
        uuid id PK
        uuid player_game_stats_id FK
        string stat_key
        numeric value
        string reason
        uuid by_user_id FK
    }
    PLAYER_GAME_POINTS {
        uuid player_game_stats_id FK
        numeric points
        jsonb breakdown
        int ruleset_version
    }
    TEAM_ROUND_SCORE {
        uuid fantasy_team_id FK
        uuid round_id FK
        numeric points
        bool provisional
    }
    ROSTER_TRANSACTION {
        uuid id PK
        uuid fantasy_team_id FK
        string slot
        uuid player_out_id FK
        uuid player_in_id FK
        string reason
        string effective_round
    }
    AUDIT_EVENT {
        uuid id PK
        uuid season_id FK
        uuid actor_user_id FK
        string action
        jsonb details
        timestamp at
    }
```

## 2. Entity notes

- **League → Season.** The league persists across years; each year's playoffs is a new `SEASON` with its own teams, draft, rules and player pool. Last year's season stays readable.
- **Player is per-season.** A player row is created when the playoff field is imported. `provider_player_id` links back to the stats API for ingestion.
- **DST is a "player".** Each playoff team gets one `PLAYER` with position `DST`, so the draft and scoring treat it uniformly.
- **Roster slots are explicit.** Even though there are no lineup decisions, storing the slot (RB1 vs FLEX2) keeps the roster display stable and makes exceptions ("replace FLEX1") unambiguous.
- **Raw stats vs. overrides vs. points.** Provider data is stored untouched in `PLAYER_GAME_STATS.raw_stats`. Commissioner corrections live in `STAT_OVERRIDE`. Points are always derived: `points = score(rules, raw_stats ⊕ overrides)`. Re-ingesting never wipes an override.
- **Team round scores are a cache.** `TEAM_ROUND_SCORE` can be rebuilt from player points at any time; it exists for fast standings.

## 3. Invariants (enforce in the database where possible)

| # | Invariant | Enforcement |
|---|-----------|-------------|
| I-1 | A player is drafted at most once per draft | Unique `(draft_id, player_id)` on `DRAFT_PICK` |
| I-2 | Each overall pick number used once | Unique `(draft_id, overall_pick)` |
| I-3 | Each team has at most one player per slot | Unique `(fantasy_team_id, slot)` on `ROSTER_SLOT` |
| I-4 | A player fills an eligible slot only | Server-side validation (+ check constraint via eligibility table) |
| I-5 | Only the team on the clock can pick (except commissioner/autopick) | Server-side, inside the pick transaction |
| I-6 | Ruleset is locked before draft starts; finalized rounds are immutable | Status checks on write |
| I-7 | Exactly 9 teams, 10 slots each, 90 picks | Season setup validation; draft completes at pick 90 |

## 4. Playoff structure reference

| Round | Code | Games | Teams playing | Notes |
|-------|------|-------|---------------|-------|
| Wild Card | WC | 6 | 12 | #1 seeds (1 AFC, 1 NFC) on bye |
| Divisional | DIV | 4 | 8 | |
| Conference Championships | CONF | 2 | 4 | |
| Super Bowl | SB | 1 | 2 | Usually 2 weeks after CONF |

A player can play at most 4 games (a non-#1 seed reaching the Super Bowl) or 3 games (a #1 seed). This matters for draft strategy, and the UI should surface it (seed + "max games remaining").
