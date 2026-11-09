import { MAX_TEAMS, type JustClaimed } from "@dnp/contract";
import { useState } from "react";
import { Link } from "react-router";
import { useApi } from "../api";
import { TeamNameForm } from "../components/TeamNameForm";
import { btnPrimary, btnSecondary, Card, ErrorWithRetry, Loading } from "../components/ui";
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
          You are not in a league yet. Ask your commissioner to add you; you will get an email with
          a link.
        </p>
      </section>
    );
  }
  const claim = (league.me?.justClaimed ?? []).filter(
    (c) => c.seasonId === league.season?.seasonId,
  );
  return (
    <SeasonHome
      seasonId={league.season.seasonId}
      userId={league.me?.user?.userId ?? ""}
      claim={claim}
    />
  );
}

const CLAIM_KEY = "dnp.welcome.claim";
const dismissedKey = (userId: string, c: JustClaimed) =>
  `dnp.welcome.dismissed.${userId}.${c.seasonId}.${c.teamId}`;

function storageGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the card just reappears after a reload */
  }
}

/**
 * /me only reports justClaimed on the request that did the claim, so remember it for this tab session
 * (team id and name only, no personal data) to survive a reload until dismissed.
 */
function useWelcomeClaim(userId: string, seasonId: string, fresh: JustClaimed[]) {
  const [dismissed, setDismissed] = useState(false);
  let claim: JustClaimed | undefined = fresh[0];
  if (claim) storageSet(`${CLAIM_KEY}.${userId}`, JSON.stringify(claim));
  else {
    try {
      const saved = JSON.parse(
        storageGet(`${CLAIM_KEY}.${userId}`) ?? "null",
      ) as JustClaimed | null;
      if (saved && saved.seasonId === seasonId) claim = saved;
    } catch {
      /* ignore corrupt value */
    }
  }
  const isDismissed =
    dismissed || (claim ? storageGet(dismissedKey(userId, claim)) === "1" : false);
  return {
    claim: isDismissed ? undefined : claim,
    dismiss: () => {
      if (claim) storageSet(dismissedKey(userId, claim), "1");
      setDismissed(true);
    },
  };
}

function SeasonHome({
  seasonId,
  userId,
  claim: fresh,
}: {
  seasonId: string;
  userId: string;
  claim: JustClaimed[];
}) {
  const welcome = useWelcomeClaim(userId, seasonId, fresh);
  const api = useApi();
  const [renaming, setRenaming] = useState(false);
  const query = useQuery(`season:${seasonId}`, () => api.season(seasonId));

  if (query.status === "loading") return <Loading />;
  if (query.status === "error")
    return <ErrorWithRetry message={friendlyError(query.error)} onRetry={query.reload} />;

  const { season, teams, myTeamId, myRole, maxTeams } = query.data;
  const mine = teams.find((t) => t.teamId === myTeamId || t.isMine);

  const welcomed = welcome.claim && teams.find((t) => t.teamId === welcome.claim?.teamId);

  return (
    <section className="space-y-4">
      {welcome.claim && (
        <Card className="space-y-3 border-accent" data-testid="welcome-card">
          <h3 className="text-lg font-semibold">
            Welcome to {season.leagueName} {season.year}! Your team is{" "}
            <strong>{welcomed?.name ?? welcome.claim.teamName}</strong>
          </h3>
          <TeamNameForm
            initial={welcomed?.name ?? welcome.claim.teamName}
            label="Rename your team (optional)"
            submitLabel="Save name"
            onSubmit={async (name) => {
              await api.renameTeam(seasonId, welcome.claim!.teamId, name);
              query.reload();
            }}
          />
          <button type="button" className={btnPrimary} onClick={welcome.dismiss}>
            Looks good
          </button>
        </Card>
      )}
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
            You do not have a team in this season yet. Ask your commissioner to add you.
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
          <p className="mt-1 text-muted">No teams yet. The commissioner adds managers.</p>
        ) : (
          <ul className="mt-2 divide-y divide-border">
            {teams.map((t) => (
              <li key={t.teamId} className="flex justify-between gap-2 py-2">
                <span>{t.name}</span>
                {t.isMine && <span className="text-sm text-muted">you</span>}
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
