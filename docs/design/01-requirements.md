# 01 — Requirements

## 1. Problem & goals

Our playoff league has run on a mix of online tools. This year we want one web app that handles the whole season:

1. **Draft** — draft players from the NFL playoff teams in a live snake draft.
2. **Scores** — calculate each team's points every playoff round and keep a running cumulative total through the Super Bowl.

### Goals
- One place for the draft, rosters, scores and standings.
- Scoring happens automatically from real stats — no spreadsheets.
- Works well on a phone (people draft and check scores from anywhere).
- Cheap/free to run for a small group.
- Reusable every season.

### Non-goals (v1)
- Handling money / prize payouts (the app only shows final placings).
- Regular-season fantasy, trades, waivers, weekly lineup setting.
- Public sign-up or multiple unrelated leagues (one private league; data model allows more later).
- Native mobile apps (responsive web only).

## 2. Roles

| Role | Who | Can do |
|------|-----|--------|
| **Commissioner** | 1 person (may also own a team) | Everything a manager can, plus: configure season, set draft order, run/pause/undo draft, manage player pool, override stats, finalize rounds, apply roster exceptions |
| **Manager** | Owner of one of the 9 teams | Join league, draft, view all rosters, scores and standings |
| **Spectator** *(optional)* | Anyone with a view link | Read-only view of draft board and standings |

## 3. League rules (as the app must enforce them)

### 3.1 Roster
| Slot | Eligible positions |
|------|-------------------|
| QB | QB |
| RB1, RB2 | RB |
| WR1, WR2 | WR |
| TE | TE |
| FLEX1, FLEX2 | RB, WR, TE *(assumed — see open questions)* |
| DST | Team defense/special teams |
| K | K |

- Every team must fill all 10 slots in the draft. Roster = lineup; there is no bench.
- After the draft, rosters are **locked**. The only changes are commissioner-applied **exceptions** (rules TBD).
- A player can be on only one fantasy team.

### 3.2 Player pool
- Players on the 14 NFL teams that make the playoffs, at positions QB/RB/WR/TE/K, plus one DST per team.
- The draft happens after the playoff field is set and before the first Wild Card game kicks off.

### 3.3 Scoring
- Custom league scoring rules (values to be supplied) applied to each player's stats in each playoff game.
- Team score for a round = sum of its 10 players' points in that round.
- Cumulative score = sum of all completed and in-progress rounds.
- Players whose NFL team has a Wild Card bye (the #1 seeds) score 0 that round but are **not** eliminated.
- Players whose NFL team is eliminated score nothing more.

### 3.4 Standings & prizes
- Ranked by cumulative points after the Super Bowl. 1st, 2nd, 3rd receive prizes.
- Tiebreaker rules TBD.

## 4. Functional requirements

### 4.1 Accounts & league setup
- FR-1 Managers sign in with a low-friction method (email magic link or Google).
- FR-2 Commissioner creates a **season**, invites 9 managers via link, and each manager names their team.
- FR-3 Commissioner sets the scoring rule set for the season and locks it before the draft.
- FR-4 Commissioner sets draft order (manual or randomized) and draft start time.

### 4.2 Player pool
- FR-5 Import the playoff teams and their players from the stats provider once the field is set.
- FR-6 Commissioner can add/remove/edit players in the pool before the draft (e.g. late call-ups, injuries).
- FR-7 Show useful draft info per player: position, NFL team, seed, opponent in Wild Card / bye, injury status, and (if available) a projection or ranking.

### 4.3 Draft
- FR-8 Live snake draft: 10 rounds, order reverses each round.
- FR-9 All participants see picks in real time (under ~1 second).
- FR-10 A pick is only allowed if the player is available **and** the team has an open eligible slot.
- FR-11 Optional pick clock; on expiry, autopick from the manager's queue, else best available eligible player.
- FR-12 Managers can keep a personal **queue** of preferred players.
- FR-13 Commissioner can start, pause, resume, undo the last pick, and make a pick on behalf of a manager.
- FR-14 Draft board view (grid of all picks) and per-team roster view.
- FR-15 A manager who disconnects can rejoin and see the current state immediately.

### 4.4 Scoring
- FR-16 Ingest player stats for every playoff game from the stats API on a schedule, more frequently while games are live.
- FR-17 Compute fantasy points per player per game using the season's rule set.
- FR-18 Show live (provisional) scores during games and final scores afterwards.
- FR-19 Commissioner can override any stat line; overrides survive future data refreshes and are audited.
- FR-20 Commissioner **finalizes** each round after stat corrections settle; finalized rounds are frozen.
- FR-21 Automatically mark NFL teams eliminated when they lose; show each fantasy team's players remaining.

### 4.5 Standings & views
- FR-22 Standings: rank, team, points per round, cumulative points, players still alive.
- FR-23 Team page: each rostered player's status (alive / bye / eliminated) and points per round.
- FR-24 Player page: per-game stat lines and point breakdown (how points were earned).
- FR-25 Final results page with 1st / 2nd / 3rd.

### 4.6 Commissioner & audit
- FR-26 Apply roster exceptions (swap a player) with a recorded reason.
- FR-27 Audit log of all commissioner actions (draft undos, overrides, exceptions, finalizations).
- FR-28 Seasons are archived and viewable in later years.

## 5. Non-functional requirements

| Area | Requirement |
|------|-------------|
| Scale | ~10 users, ~20 concurrent viewers max. No scaling concerns. |
| Realtime | Draft picks propagate to all clients in < 1s. |
| Reliability | Draft must survive client refreshes and server restarts without losing picks. Server is the source of truth. |
| Correctness | Scoring is deterministic and recomputable from raw stats + overrides + rules at any time. |
| Mobile | Fully usable at phone width, especially the draft room. |
| Cost | Fit within free/hobby tiers except the stats API (budget TBD). |
| Security | Only invited users can sign in; only the commissioner can perform admin actions (enforced server-side). |
| Timing | Must be production-ready before the draft window in early-to-mid January 2027. |
