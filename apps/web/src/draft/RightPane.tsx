import type { DraftSnapshot } from "@dnp/contract";
import { useEffect, useRef } from "react";
import { teamAbbr, teamName } from "./model";
import { PanelCard, PositionBadge } from "./parts";

/** Drafted players in pick order (newest at the bottom, auto-scrolled while the viewer is at the bottom); clicking a pick shows that team's roster on the left. */
export function PicksPanel({
  snapshot,
  onSelectTeam,
  className = "",
}: {
  snapshot: DraftSnapshot;
  onSelectTeam: (teamId: string) => void;
  className?: string;
}) {
  const picks = [...snapshot.picks].sort((a, b) => a.overallPick - b.overallPick);
  const listRef = useRef<HTMLOListElement>(null);
  const stickRef = useRef(true); // first render: start at the bottom
  const count = picks.length;
  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [count]);

  return (
    <PanelCard title="Drafted players" className={className} testId="picks">
      {picks.length === 0 ? (
        <p className="text-sm text-muted" data-testid="picks-empty">
          No picks yet.
        </p>
      ) : (
        <ol
          ref={listRef}
          className="max-h-[50vh] divide-y divide-border overflow-y-auto"
          aria-label="Picks"
          onScroll={(e) => {
            const el = e.currentTarget;
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 40;
          }}
        >
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
                <span
                  className="w-10 shrink-0 truncate font-mono font-semibold"
                  title={teamName(snapshot, k.teamId)}
                >
                  {teamAbbr(snapshot, k.teamId)}
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
