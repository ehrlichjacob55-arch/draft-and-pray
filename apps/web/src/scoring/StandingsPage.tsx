import type { StandingsResponse, StandingsRowView } from "@dnp/contract";
import { useEffect } from "react";
import { useApi } from "../api";
import { ErrorWithRetry, Loading } from "../components/ui";
import { friendlyError } from "../lib/messages";
import { useLeague } from "../league/LeagueProvider";
import { useDraftChannel } from "../realtime/useDraftChannel";
import { useQuery } from "../useQuery";
import { ROUND_LABEL, ROUND_NAMES } from "./LiveStatsSection";

/** While a round is live and the realtime socket is down, refetch this often. */
export const POLL_MS = 60_000;
const MEDALS = { 1: "🥇", 2: "🥈", 3: "🥉" } as const;

/** Up to two decimals, no trailing zeros. */
export const fmt = (n: number): string => String(Math.round(n * 100) / 100);

/** `/standings` (docs/design/06 §5): cumulative points per round, rank, players alive. */
export function StandingsPage() {
  const league = useLeague();
  if (league.status === "loading")
    return (
      <section className="space-y-2">
        <h2 className="text-xl font-semibold">Standings</h2>
        <Loading />
      </section>
    );
  if (league.status === "error")
    return <ErrorWithRetry message={friendlyError(league.error)} onRetry={league.reload} />;
  if (!league.season)
    return (
      <section className="space-y-2">
        <h2 className="text-xl font-semibold">Standings</h2>
        <p className="text-muted">There is no season yet.</p>
      </section>
    );
  return <Standings seasonId={league.season.seasonId} />;
}

function Standings({ seasonId }: { seasonId: string }) {
  const api = useApi();
  const query = useQuery(`standings:${seasonId}`, () => api.standings(seasonId));
  const { reload } = query;
  const live = query.status === "ready" && query.data.rounds.some((r) => r.status === "live");

  // Scores change on the season's realtime channel; poll only while a round is live and the
  // socket is down.
  const connection = useDraftChannel(seasonId, {
    onEvent: () => {},
    onConnected: reload,
    onScoresUpdated: reload,
  });
  useEffect(() => {
    if (!live || connection === "connected") return;
    const id = setInterval(reload, POLL_MS);
    return () => clearInterval(id);
  }, [live, connection, reload]);

  return (
    <section className="space-y-3">
      <Header data={query.status === "ready" ? query.data : undefined} />
      {query.status === "loading" && <Loading />}
      {query.status === "error" && (
        <ErrorWithRetry message={friendlyError(query.error)} onRetry={query.reload} />
      )}
      {query.status === "ready" && <StandingsTable data={query.data} />}
    </section>
  );
}

function Header({ data }: { data?: StandingsResponse }) {
  const current = data?.rounds.find((r) => r.round === data.asOf);
  return (
    <h2 className="text-xl font-semibold">
      Standings
      {current && ` · ${ROUND_NAMES[current.code]} ${ROUND_LABEL[current.status]}`}
    </h2>
  );
}

const placeOf = (data: StandingsResponse, teamId: string) =>
  data.placings?.find((p) => p.teamId === teamId)?.place;

function roundCell(r: StandingsRowView["rounds"][number]) {
  return r.points === null ? "—" : `${fmt(r.points)}${r.provisional ? "*" : ""}`;
}

function StandingsTable({ data }: { data: StandingsResponse }) {
  if (data.rows.length === 0) return <p className="text-muted">No teams yet.</p>;
  const provisional = data.rows.some((r) => r.rounds.some((x) => x.provisional));
  return (
    <>
      <div className="overflow-x-auto rounded border border-border bg-surface">
        <table className="w-full text-sm" aria-label="Standings">
          <thead className="text-left text-xs text-muted">
            <tr className="border-b border-border">
              <th scope="col" className="px-2 py-2">
                #
              </th>
              <th scope="col" className="px-2 py-2">
                Team
              </th>
              {data.rounds.map((r) => (
                <th
                  key={r.round}
                  scope="col"
                  className="hidden px-2 py-2 text-right sm:table-cell"
                  data-col="round"
                >
                  {r.code}
                </th>
              ))}
              <th scope="col" className="px-2 py-2 text-right">
                Total
              </th>
              <th scope="col" className="px-2 py-2 text-right">
                Alive
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.rows.map((row) => (
              <TeamRow key={row.teamId} row={row} place={placeOf(data, row.teamId)} data={data} />
            ))}
          </tbody>
        </table>
      </div>
      {provisional && (
        <p className="text-xs text-muted">* provisional until the round is finalized</p>
      )}
    </>
  );
}

function TeamRow({
  row,
  place,
  data,
}: {
  row: StandingsRowView;
  place: 1 | 2 | 3 | undefined;
  data: StandingsResponse;
}) {
  return (
    <tr data-testid={`standing-${row.teamId}`}>
      <td className="whitespace-nowrap px-2 py-2 font-medium">
        {row.tied ? `T-${row.rank}` : row.rank}
      </td>
      <td className="px-2 py-2">
        <span className="font-medium">
          {place && (
            <span role="img" aria-label={`Place ${place}`} className="mr-1">
              {MEDALS[place]}
            </span>
          )}
          {row.teamName}
        </span>
        {/* Narrow screens: the per-round points move under the team name. */}
        <span className="mt-0.5 block text-xs text-muted sm:hidden" data-testid="rounds-inline">
          {row.rounds
            .map((r, i) => `${data.rounds[i]?.code ?? r.round} ${roundCell(r)}`)
            .join(" · ")}
        </span>
      </td>
      {row.rounds.map((r) => (
        <td
          key={r.round}
          className="hidden px-2 py-2 text-right font-mono sm:table-cell"
          data-col="round"
        >
          {roundCell(r)}
        </td>
      ))}
      <td className="px-2 py-2 text-right font-mono font-semibold">{fmt(row.total)}</td>
      <td className="whitespace-nowrap px-2 py-2 text-right">
        {row.playersAlive}/{row.playersTotal}
      </td>
    </tr>
  );
}
