import type { DraftSnapshot } from "@dnp/contract";
import { pickAt, POSITION_CLASS } from "./model";
import { PanelCard } from "./parts";

export function BoardPanel({
  snapshot,
  className = "",
}: {
  snapshot: DraftSnapshot;
  className?: string;
}) {
  const byPick = new Map(snapshot.picks.map((p) => [p.overallPick, p]));
  const auto = new Set(snapshot.autoDraftTeamIds);
  const complete = snapshot.status === "complete";
  const rounds = Array.from({ length: 10 }, (_, i) => i + 1);
  return (
    <PanelCard title="Board" className={className} testId="board">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] table-fixed border-separate border-spacing-1 text-xs">
          <thead>
            <tr>
              <th scope="col" className="w-8 text-muted">
                Rd
              </th>
              {snapshot.order.map((o) => (
                <th key={o.teamId} scope="col" className="px-1 pb-1 text-left align-bottom">
                  <span className="block truncate font-semibold" title={o.name}>
                    <span aria-hidden="true">{o.abbr}</span>
                    <span className="sr-only">{o.name}</span>
                  </span>
                  {auto.has(o.teamId) && (
                    <span
                      className="mt-0.5 inline-block rounded border border-accent px-1 text-[10px] text-accent"
                      data-testid={`auto-badge-${o.teamId}`}
                    >
                      Auto
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rounds.map((r) => (
              <tr key={r}>
                <th scope="row" className="text-muted">
                  {r}
                </th>
                {snapshot.order.map((o) => {
                  const n = pickAt(r, o.position);
                  const pick = byPick.get(n);
                  const current = !complete && n === snapshot.currentPick;
                  return (
                    <td
                      key={o.teamId}
                      data-testid={`board-cell-${n}`}
                      aria-current={current ? "true" : undefined}
                      className={`h-12 overflow-hidden rounded border px-1 py-0.5 align-top ${
                        pick ? POSITION_CLASS[pick.player.position] : ""
                      } ${current ? "border-2 border-accent" : "border-border"}`}
                    >
                      {pick ? (
                        <>
                          <span className="block truncate font-medium" title={pick.player.name}>
                            {pick.player.name}
                          </span>
                          <span className="block truncate opacity-80">
                            {pick.player.position} · {pick.player.nflTeam}
                          </span>
                        </>
                      ) : (
                        <span className="text-muted">{n}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PanelCard>
  );
}
