import type { DraftSnapshot } from "@dnp/contract";
import { deriveView, teamAtPick, teamName } from "./model";
import { PanelCard, PositionBadge } from "./parts";

/** "On the clock" header: the team picking now, then the next three teams. */
export function OnClockPanel({
  snapshot,
  className = "",
}: {
  snapshot: DraftSnapshot;
  className?: string;
}) {
  const view = deriveView(snapshot);
  const next = [1, 2, 3].flatMap((d) => {
    const t = teamAtPick(snapshot, snapshot.currentPick + d);
    return t ? [{ pick: snapshot.currentPick + d, ...t }] : [];
  });
  const live = snapshot.status === "in_progress" || snapshot.status === "paused";
  return (
    <PanelCard title="On the clock" className={className} testId="on-the-clock">
      {live && snapshot.onClockTeamId ? (
        <>
          <p data-testid="otc-current">
            <span className="text-xs text-muted">Pick {snapshot.currentPick}</span>{" "}
            <strong>{view.onClockName}</strong>
            {view.isMyTurn && <span className="ml-1 text-xs font-semibold text-accent">(you)</span>}
          </p>
          {next.length > 0 && (
            <ol className="mt-1 space-y-0.5 text-sm text-muted" aria-label="Next teams">
              {next.map((t) => (
                <li key={t.pick} data-testid={`otc-next-${t.pick}`}>
                  <span className="text-xs">Pick {t.pick}</span> {t.name}
                  {t.teamId === snapshot.myTeamId && " (you)"}
                </li>
              ))}
            </ol>
          )}
        </>
      ) : (
        <p className="text-sm text-muted">
          {snapshot.status === "complete" ? "The draft is complete." : "The draft has not started."}
        </p>
      )}
    </PanelCard>
  );
}

/** Drafted players, newest first; clicking a pick shows that team's roster on the left. */
export function PicksPanel({
  snapshot,
  onSelectTeam,
  className = "",
}: {
  snapshot: DraftSnapshot;
  onSelectTeam: (teamId: string) => void;
  className?: string;
}) {
  const picks = [...snapshot.picks].sort((a, b) => b.overallPick - a.overallPick);
  return (
    <PanelCard title="Drafted players" className={className} testId="picks">
      {picks.length === 0 ? (
        <p className="text-sm text-muted" data-testid="picks-empty">
          No picks yet.
        </p>
      ) : (
        <ol className="max-h-[50vh] divide-y divide-border overflow-y-auto" aria-label="Picks">
          {picks.map((k) => (
            <li key={k.overallPick} data-testid={`pick-${k.overallPick}`}>
              <button
                type="button"
                className="flex w-full items-center gap-1.5 py-1.5 text-left text-xs hover:bg-bg"
                aria-label={`Show ${teamName(snapshot, k.teamId)} roster (pick ${k.overallPick})`}
                onClick={() => onSelectTeam(k.teamId)}
              >
                <span className="w-7 shrink-0 text-right tabular-nums text-muted">
                  #{k.overallPick}
                </span>
                <span className="w-6 shrink-0 text-muted">R{k.round}</span>
                <span className="w-20 shrink-0 truncate font-medium">
                  {teamName(snapshot, k.teamId)}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">{k.player.name}</span>
                <PositionBadge position={k.player.position} />
                <span className="w-9 shrink-0 text-muted">{k.player.nflTeam}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </PanelCard>
  );
}
