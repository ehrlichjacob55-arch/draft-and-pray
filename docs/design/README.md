# Draft & Pray — Design Package

**Draft & Pray** is a web app that moves our 9-team playoff fantasy league fully online: a **live snake draft** of players from NFL playoff teams, then **automatic weekly scoring** that accumulates through the Super Bowl. Once you draft, your roster is locked — all that's left is to pray.

> Status: **Draft v0.1** — design only. Implementation will be done later with Claude Code.
> Last updated: 2026-11-09

## Documents

| # | Document | What it covers |
|---|----------|----------------|
| 01 | [Requirements](01-requirements.md) | Goals, roles, league rules, functional & non-functional requirements, scope |
| 02 | [Domain Model](02-domain-model.md) | Entities, relationships (ER diagram), key invariants |
| 03 | [Draft Design](03-draft-design.md) | Snake order, draft state machine, pick flow, timer/autopick, commissioner controls |
| 04 | [Scoring Design](04-scoring-design.md) | Configurable scoring rules, stats pipeline, elimination, standings, tiebreakers |
| 05 | [Architecture](05-architecture.md) | System diagram, recommended stack, API surface, realtime, scheduled jobs |
| 06 | [UI Screens](06-ui-screens.md) | Screen inventory and wireframes |
| 07 | [Implementation Plan](07-implementation-plan.md) | Phased plan, timeline to the January draft, Claude Code work breakdown |
| 08 | [Open Questions](08-open-questions.md) | Decisions still needed from the league |
| 09 | [AWS Architecture](09-aws-architecture.md) | AWS + Terraform stack, repo layout, build/deploy contract (supersedes parts of 05) |
| 10 | [DynamoDB Data Model](10-dynamodb-data-model.md) | Single-table keys, access patterns, transactions for picks/undo/recompute (storage for 02) |
| 11 | [Sign-in, Invites & League Setup](11-auth-and-league-setup.md) | Task 3: Cognito email-OTP sign-in, invite links, season/team setup, test users (DEV/TEST only) |
| 12 | [Stats & Data Provider](12-stats-provider.md) | ESPN for stats, schedule and playoff seeds; Sleeper for rosters; verified field coverage and risks |
| 13 | [One-Step Manager Onboarding](13-manager-onboarding.md) | Commissioner adds managers; one email + one click signs in, verifies and assigns the team; PII rules (supersedes 11's invite links) |
| 14 | [Live Draft](14-live-draft.md) | Owner decisions (manual order, optional 90 s alert-only clock, opt-in auto-draft), draft API, ticketed WebSocket, draft room UI (supersedes parts of 03) |

## League at a glance

- **9 teams**, one manager each, plus a commissioner.
- **Roster (= lineup, locked after draft):** QB, RB1, RB2, WR1, WR2, TE, FLEX1, FLEX2, DST, K — **10 players**.
- **Draft:** live, real-time snake draft — 10 rounds × 9 teams = **90 picks**.
- **Player pool:** players on the 14 NFL playoff teams only.
- **Scoring:** custom league rules (to be supplied), applied to every playoff game; points are **cumulative** across Wild Card → Divisional → Conference → Super Bowl.
- **Elimination:** when a player's NFL team is knocked out, that player stops scoring and cannot be replaced (except for commissioner-approved exceptions).
- **Prizes:** 1st, 2nd, 3rd place by cumulative points after the Super Bowl.

## Key decisions so far

| Decision | Choice |
|----------|--------|
| Project / app name | **Draft & Pray** |
| Draft style | Live snake draft, real time |
| Stats source | Sports data API, with commissioner manual override |
| Scoring | Custom, fully configurable rule set (values TBD) |
| Roster | 10 locked slots, no bench, no weekly lineup changes |
| Infrastructure | AWS via Terraform: S3 + CloudFront SPA, Lambda + API Gateway, DynamoDB (single table), Cognito, WebSocket API |
