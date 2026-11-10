import type { ActiveScoring } from "@dnp/contract";
import { safeParseRuleset, type Rule } from "@dnp/domain";
import { Link } from "react-router";
import { useApi } from "../api";
import { ErrorWithRetry, Loading } from "../components/ui";
import { friendlyError } from "../lib/messages";
import { useLeague } from "../league/LeagueProvider";
import { useQuery } from "../useQuery";
import { groupFor, pts, rangeText, statLabel, unitOf, GROUPS } from "./catalog";
import { Badge } from "./fields";

const scope = (r: Rule): string => (r.positions ? ` (${r.positions.join(", ")} only)` : "");

/** One plain-sentence line for a rule that is not a table. */
export function ruleSentence(r: Rule): string {
  const name = statLabel(r.stat);
  switch (r.kind) {
    case "per_unit":
      return `${name}: ${pts(r.points)} per ${r.per}${unitOf(r.stat) || " units"} (${
        r.fractional ? "fractional" : "whole units only"
      })${scope(r)}`;
    case "per_event":
      return `${name}: ${pts(r.points)} each${scope(r)}`;
    case "bonus":
      return `${name}: ${r.points >= 0 ? "+" : ""}${pts(r.points)} bonus for ${r.gte}${unitOf(r.stat) || ""} or more${scope(r)}`;
    default:
      return name;
  }
}

function TierTable({ rule }: { rule: Extract<Rule, { tiers: unknown }> }) {
  const distance = rule.kind === "distance_tiers";
  const name = distance ? `${statLabel(rule.stat)}, by distance` : statLabel(rule.stat);
  return (
    <div>
      <p>
        {name}
        {scope(rule)}
      </p>
      <table className="mt-1 text-sm" aria-label={name}>
        <thead>
          <tr className="text-left text-xs text-muted">
            <th className="pr-6 font-medium">{distance ? "Distance" : "Total"}</th>
            <th className="font-medium">Points</th>
          </tr>
        </thead>
        <tbody>
          {rule.tiers.map((t) => (
            <tr key={t.min}>
              <td className="pr-6 tabular-nums">
                {rangeText(t.min, t.max)}
                {distance ? " yds" : ""}
              </td>
              <td className="tabular-nums">{Number(t.points.toFixed(4))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Read-only, plain-language rendering of a ruleset (members' Rules page). */
export function RulesetView({ active }: { active: ActiveScoring }) {
  const parsed = safeParseRuleset({
    version: active.version,
    rounding: active.rounding,
    rules: active.rules,
  });
  if (!parsed.ok) return <p className="text-muted">The scoring rules can’t be shown right now.</p>;
  const { ruleset } = parsed;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Version {active.version}</span>
        {active.locked ? (
          <Badge tone="ok">Locked</Badge>
        ) : (
          <Badge tone="muted">Not locked yet</Badge>
        )}
      </div>
      {GROUPS.map((g) => {
        const rules = ruleset.rules.filter((r) => groupFor(r.stat, r.kind) === g.id);
        if (rules.length === 0) return null;
        return (
          <section key={g.id} aria-labelledby={`rules-${g.id}`}>
            <h3 id={`rules-${g.id}`} className="mb-1 font-semibold">
              {g.title}
            </h3>
            <ul className="space-y-2 text-sm">
              {rules.map((r, i) => (
                <li key={i}>
                  {r.kind === "tiers" || r.kind === "distance_tiers" ? (
                    <TierTable rule={r} />
                  ) : (
                    ruleSentence(r)
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <p className="text-sm text-muted">
        Each player’s total for a game is rounded to {ruleset.rounding} decimal place
        {ruleset.rounding === 1 ? "" : "s"}.
      </p>
    </div>
  );
}

/** `/rules`: the active scoring ruleset, for every league member. */
export function RulesPage() {
  const league = useLeague();
  if (league.status === "loading") return <Loading />;
  if (league.status === "error")
    return <ErrorWithRetry message={friendlyError(league.error)} onRetry={league.reload} />;
  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold">Rules &amp; scoring</h2>
      {league.season ? (
        <ActiveRules seasonId={league.season.seasonId} commissioner={league.isCommissioner} />
      ) : (
        <p className="text-muted">{"Scoring rules haven't been set yet."}</p>
      )}
    </section>
  );
}

function ActiveRules({ seasonId, commissioner }: { seasonId: string; commissioner: boolean }) {
  const api = useApi();
  const query = useQuery(`scoring:${seasonId}`, () => api.scoring(seasonId));
  if (query.status === "loading") return <Loading />;
  if (query.status === "error")
    return <ErrorWithRetry message={friendlyError(query.error)} onRetry={query.reload} />;
  if (!query.data.active)
    return (
      <div className="space-y-2">
        <p className="text-muted">{"Scoring rules haven't been set yet."}</p>
        {commissioner && (
          <Link to="/commissioner" className="text-sm text-accent underline">
            Set them up on the Commissioner page
          </Link>
        )}
      </div>
    );
  return <RulesetView active={query.data.active} />;
}
