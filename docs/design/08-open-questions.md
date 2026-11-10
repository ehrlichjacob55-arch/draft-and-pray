# 08 — Open Questions

Decisions the league still needs to make. Each one notes what in the design depends on it and the default the design assumes until decided.

| # | Question | Affects | Default assumed |
|---|----------|---------|-----------------|
| Q1 | **Scoring rules** — full list of stat categories, point values, bonuses, DST and K rules. | 04 scoring config | Placeholder ruleset; engine is fully configurable |
| Q2 | **Roster exceptions** — when may a team add a player after the draft? (e.g. season-ending injury before playing a snap, player traded/released, any other cases) Can the replacement come from any playoff team? Does it apply only before Wild Card kickoff? | Roster transactions, commissioner console | Commissioner-only manual swap with a reason; no self-service |
| Q3 | ✅ **Decided 2026-11-09: RB/WR/TE.** **FLEX eligibility** — RB/WR/TE only, or can QB go in FLEX (superflex)? | Draft validation | RB/WR/TE |
| Q4 | **Tiebreakers** for 1st/2nd/3rd — e.g. most Super Bowl round points, most players alive at the end, highest single-player score, or split the prize? | Standings | Shared rank, flagged for commissioner |
| Q5 | ✅ **Decided 2026-11-09: commissioner sets it manually.** **Draft order** — random lottery, reverse of last year's finish, or commissioner-set? | Draft setup | Commissioner sets, with a "randomize" button |
| Q6 | ✅ **Decided 2026-11-09: no clock by default; commissioner can start a 90 s alert-only clock (no autopick on expiry), see doc 14.** **Pick clock** — length (e.g. 60s / 90s / 2 min)? What happens on expiry — autopick or skip? | Draft timer | 90 seconds, autopick from queue then best available |
| Q7 | ✅ **Decided 2026-11-09: ESPN (free, unofficial) for stats + playoff field, Sleeper for rosters; see doc 12.** **Stats provider budget** — free/unofficial source acceptable, or pay for a reliable API for one month? | Architecture, ingestion | Evaluate in Phase 0 |
| Q8 | **Draft date/time** — the window is between the end of the regular season and the first Wild Card kickoff (~1 week). Which evening works? | Plan | Mid-week evening before Wild Card weekend |
| Q9 | ✅ **Decided 2026-11-09: all active QB/RB/WR/TE/K + DST; commissioner can include/exclude.** **Player pool scope** — every rostered player on the 14 teams, or only those above a depth-chart cutoff? Include practice-squad call-ups? | Import | All active roster players at QB/RB/WR/TE/K + DST; commissioner can add more |
| Q10 | **Stat correction cutoff** — how long after a round should the commissioner wait before finalizing (NFL stat corrections typically land within a few days)? | Finalization | Finalize manually, recommended before the next round kicks off |
| Q11 | ✅ **Decided 2026-11-09: yes, via doc 13 self-add.** **Is the commissioner also a manager?** If so, who approves the commissioner's own exceptions/overrides? | Permissions | Commissioner may manage a team; all actions visible in audit log |
| Q12 | **Spectator link** — wanted? | Auth | Optional, off by default |
| Q13 | **Two-point conversions, return TDs, fumble-recovery TDs** — scored for the player, DST, both? | Scoring config | Part of Q1 |
