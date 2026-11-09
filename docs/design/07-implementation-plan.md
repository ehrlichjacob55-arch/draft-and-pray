# 07 — Implementation Plan

## 1. The hard deadline

The draft has to happen in the short window **after the NFL regular season ends and before the first Wild Card game** — roughly one week in early-to-mid January 2027 (confirm exact dates once the NFL schedule is final). The app must be tested with a full mock draft before then. Everything below works back from that.

## 2. Timeline

```mermaid
gantt
    title Playoff Fantasy app - plan to draft night
    dateFormat YYYY-MM-DD
    axisFormat %b %d

    section Phase 0 - Decide
    Scoring rules, exceptions, tiebreakers (Q1-Q4) :p0a, 2026-11-09, 14d
    Stats provider spike                           :p0b, 2026-11-09, 10d

    section Phase 1 - Foundation
    Repo, CI, Terraform, DB schema, auth, invites       :p1a, 2026-11-16, 7d
    Season setup + player pool import (adapter)    :p1b, after p1a, 7d

    section Phase 2 - Draft
    Pure logic: snake order, slot eligibility      :p2a, 2026-11-23, 4d
    Pick API, transactions, realtime               :p2b, after p2a, 7d
    Draft room UI, queue, clock, autopick          :p2c, after p2b, 8d

    section Phase 3 - Scoring
    Scoring engine + ruleset schema + tests        :p3a, 2026-11-30, 7d
    Ingestion jobs, elimination, overrides         :p3b, after p3a, 10d
    Standings, team and player pages               :p3c, after p3b, 6d

    section Phase 4 - Harden
    Commissioner console, finalize, audit          :p4a, 2026-12-21, 7d
    Replay 2025-26 playoffs + golden tests         :p4b, 2026-12-26, 6d
    Mock draft with the league                     :milestone, m1, 2027-01-03, 0d
    Fixes from mock draft                          :p4c, 2027-01-03, 5d

    section Season
    Import playoff field (approx)                  :milestone, m2, 2027-01-11, 0d
    Draft night (approx)                           :milestone, m3, 2027-01-13, 0d
    Wild Card weekend (approx)                     :milestone, m4, 2027-01-16, 0d
```

## 3. Phases and exit criteria

### Phase 0 — Decide (now → ~Nov 20)
- League answers Q1–Q6 in [08-open-questions](08-open-questions.md), especially the **scoring rules**.
- Stats provider spike: pull last season's playoff box scores from 1–2 candidates, check coverage against the ruleset, latency, and cost.
- **Exit:** ruleset values written down; provider chosen (or manual fallback accepted).

### Phase 1 — Foundation
- pnpm monorepo (React SPA + Lambda API) and Terraform per [09-aws-architecture](09-aws-architecture.md); schema from [02-domain-model](02-domain-model.md) as a DynamoDB single-table design ([10](10-dynamodb-data-model.md)).
- Magic-link sign-in, invite links, league/season/team setup.
- Provider adapter: import playoff field + players; manual/CSV adapter; seed with 2025–26 data.
- **Exit:** 9 test users can join a season and see an imported player pool.

### Phase 2 — Draft
- Pure functions + unit tests: snake order, slot auto-assignment, eligibility.
- Pick endpoint with row lock, `expected_pick`, constraints; undo; commissioner pick.
- Realtime broadcast + snapshot-on-reconnect.
- Draft room UI (phone + desktop), queue, clock with tick pattern, autopick.
- **Exit:** a full 90-pick draft with 9 browser sessions (Playwright), including refreshes, double-clicks and an expired clock.

### Phase 3 — Scoring
- Ruleset JSON schema + validation; engine for every rule type; point breakdowns.
- Ingestion job (schedule-aware frequency), canonical stat mapping, game status, elimination.
- Overrides, recompute, standings, team/player pages, realtime `scores_updated`.
- **Exit:** replaying last season's playoffs produces correct points for a hand-checked sample and correct eliminations.

### Phase 4 — Harden
- Commissioner console, round finalization, roster exceptions, audit log.
- Mock draft with the actual league using last season's player pool; collect feedback.
- Backups verified; error monitoring on.
- **Exit:** league signs off after mock draft.

### Season operations
- Import playoff field as soon as it's set → commissioner reviews pool → draft night → scoring runs automatically → commissioner finalizes each round → final placings after the Super Bowl.

## 4. Work breakdown for Claude Code

Suggested order of sessions/prompts. Each should reference these design docs (copy them into the repo under `docs/design/` and point `CLAUDE.md` at them).

| # | Task | Acceptance criteria |
|---|------|--------------------|
| 1 | Scaffold pnpm monorepo (Vite React + Tailwind, Hono on Lambda, DynamoDB) + Terraform for AWS; CI with lint, typecheck, tests, terraform validate | Health check works locally end to end; CI green; `terraform validate` passes |
| 2 | DB migrations for the domain model, constraints I-1…I-7, RLS policies | Migration runs locally; constraint tests pass |
| 3 | Auth, invites, season + team setup | Commissioner invites; managers join and name teams |
| 4 | `StatsProvider` interface, mock + CSV adapters, seed 2025–26 data | Player pool visible with seeds and positions |
| 5 | `draft-order` and `slot-eligibility` modules with exhaustive unit tests | 100% branch coverage on these modules |
| 6 | Draft API (start/pause/resume/pick/undo/tick) with transactions | Concurrency test: 2 simultaneous picks → exactly one succeeds |
| 7 | Draft room UI + realtime + queue + autopick | 9-session E2E draft completes; reconnect works |
| 8 | Ruleset schema + scoring engine with unit tests per rule type | Golden tests match hand calculations |
| 9 | Real provider adapter + ingestion job + elimination | Replay of a past playoff weekend updates statuses correctly |
| 10 | Overrides, recompute, round finalization, standings API | Override survives re-ingest; finalized round is frozen |
| 11 | Standings, team, player pages; commissioner console; audit log | Usable on a phone; all admin actions audited |
| 12 | Roster exceptions with effective round | Scores credit the right player per round |

## 5. Risks

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Scoring rules arrive late | Engine built but untested against real rules | Engine is rule-driven; plug in values whenever ready; golden tests once known |
| Stats API gaps (e.g. FG distance, DST detail) or downtime on game day | Wrong or late scores | Spike early; canonical mapping; manual/CSV fallback; commissioner overrides |
| Realtime glitches during the draft | Confusion on draft night | Snapshot-on-reconnect, server-authoritative state, commissioner pause/undo, mock draft |
| Short draft window | Draft can't be rescheduled easily | Pick date in December; clock + autopick so absent managers don't stall it |
| Scope creep (chat, trades, notifications) | Miss the deadline | Keep to v1 scope; park ideas in a backlog |

## 6. Nice-to-haves (post-v1 backlog)

- Draft chat and pick reactions
- Push/email notifications ("you're on the clock", "round finalized")
- Player projections and "max possible points" view
- Draft grades / recap page
- Spectator link
- Historical league records across seasons
