import { MAX_TEAMS } from "@dnp/contract";
import { useState } from "react";
import { Link } from "react-router";
import { useApi } from "../api";
import { TeamNameForm } from "../components/TeamNameForm";
import { btnSecondary, Card, ErrorWithRetry, Loading } from "../components/ui";
import { friendlyError } from "../lib/messages";
import { useLeague } from "../league/LeagueProvider";
import { useQuery } from "../useQuery";

const STATUS_LABEL = {
  setup: "Setup",
  drafting: "Draft in progress",
  in_progress: "Playoffs in progress",
  complete: "Complete",
} as const;

export function LeagueHome() {
  const league = useLeague();
  if (league.status === "loading") return <Loading />;
  if (league.status === "error")
    return <ErrorWithRetry message={friendlyError(league.error)} onRetry={league.reload} />;
  if (!league.league || !league.season) {
    return (
      <section className="space-y-2">
        <h2 className="text-xl font-semibold">League home</h2>
        <p>
          You are not in a league yet. Ask your commissioner for an invite link and open it to join.
        </p>
      </section>
    );
  }
  return <SeasonHome seasonId={league.season.seasonId} />;
}

function SeasonHome({ seasonId }: { seasonId: string }) {
  const api = useApi();
  const [renaming, setRenaming] = useState(false);
  const query = useQuery(`season:${seasonId}`, () => api.season(seasonId));

  if (query.status === "loading") return <Loading />;
  if (query.status === "error")
    return <ErrorWithRetry message={friendlyError(query.error)} onRetry={query.reload} />;

  const { season, teams, myTeamId, myRole, maxTeams } = query.data;
  const mine = teams.find((t) => t.teamId === myTeamId);

  return (
    <section className="space-y-4">
      <Card>
        <h2 className="text-xl font-semibold">{season.leagueName}</h2>
        <p className="text-sm text-muted">
          {season.year} season ·{" "}
          <span data-testid="season-status">{STATUS_LABEL[season.status]}</span>
        </p>
      </Card>

      <Card>
        <h3 className="font-semibold">Your team</h3>
        {mine ? (
          renaming ? (
            <div className="mt-2">
              <TeamNameForm
                initial={mine.name}
                label="New team name"
                submitLabel="Save"
                onCancel={() => setRenaming(false)}
                onSubmit={async (name) => {
                  await api.renameTeam(seasonId, mine.teamId, name);
                  setRenaming(false);
                  query.reload();
                }}
              />
            </div>
          ) : (
            <p className="mt-1 flex items-center justify-between gap-2">
              <span>
                Your team: <strong>{mine.name}</strong>
              </span>
              <button type="button" className={btnSecondary} onClick={() => setRenaming(true)}>
                Rename
              </button>
            </p>
          )
        ) : (
          <p className="mt-1 text-muted">
            You have not joined this season with a team yet. Open your invite link to join.
          </p>
        )}
      </Card>

      <Card>
        <h3 className="font-semibold">
          Teams{" "}
          <span className="font-normal text-muted" data-testid="team-count">
            {teams.length}/{maxTeams ?? MAX_TEAMS}
          </span>
        </h3>
        {teams.length === 0 ? (
          <p className="mt-1 text-muted">No teams yet. Invites go out from the commissioner.</p>
        ) : (
          <ul className="mt-2 divide-y divide-border">
            {teams.map((t) => (
              <li key={t.teamId} className="flex justify-between gap-2 py-2">
                <span>{t.name}</span>
                <span className="text-sm text-muted">{t.managerDisplayName ?? "—"}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {myRole === "commissioner" && (
        <p>
          <Link to="/commissioner" className="text-accent underline">
            Open the commissioner page
          </Link>
        </p>
      )}
    </section>
  );
}
