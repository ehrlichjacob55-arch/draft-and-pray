import type { DraftSnapshot } from "@dnp/contract";
import { Fragment } from "react";
import { formatClock } from "./clock";
import { teamAtPick } from "./model";

const BOXES = 9;

/**
 * Between the banner and the panes: the on-clock pick (box 1, highlighted) and the next 8 picks
 * in snake order, with a divider where the round changes. Clicking a box shows that team's roster.
 */
export function OnTheClockStrip({
  snapshot,
  clockRemaining,
  clockExpired,
  selectedTeamId,
  onSelectTeam,
}: {
  snapshot: DraftSnapshot;
  clockRemaining: number | null;
  clockExpired: boolean;
  selectedTeamId: string | null;
  onSelectTeam: (teamId: string) => void;
}) {
  const paused = snapshot.status === "paused";
  const boxes = Array.from({ length: BOXES }, (_, i) => snapshot.currentPick + i).flatMap((n) => {
    const team = teamAtPick(snapshot, n);
    return team ? [{ n, round: Math.ceil(n / snapshot.order.length), ...team }] : [];
  });
  if (boxes.length === 0) return null;

  return (
    <nav aria-label="On the clock" data-testid="otc-strip">
      <ol className="flex items-stretch gap-1.5 overflow-x-auto pb-1">
        {boxes.map((b, i) => {
          const current = i === 0;
          const mine = b.teamId === snapshot.myTeamId;
          const dividerBefore = i > 0 && b.round !== boxes[i - 1]!.round;
          const selected = b.teamId === selectedTeamId;
          return (
            <Fragment key={b.n}>
              {dividerBefore && (
                <li
                  role="separator"
                  aria-label={`Round ${b.round}`}
                  data-testid="otc-round-divider"
                  className="flex shrink-0 flex-col items-center justify-center gap-0.5 px-0.5 text-[10px] font-semibold uppercase text-muted"
                >
                  <span className="h-full w-px flex-1 bg-border" aria-hidden="true" />
                  <span>R{b.round}</span>
                  <span className="h-full w-px flex-1 bg-border" aria-hidden="true" />
                </li>
              )}
              <li
                data-testid={current ? "otc-current" : `otc-next-${b.n}`}
                className={current ? "shrink-0" : "min-w-[4.25rem] flex-1 shrink-0"}
              >
                <button
                  type="button"
                  aria-label={`Pick ${b.n}, ${b.name}${current ? ", on the clock" : ""}${mine ? ", yours" : ""}. Show roster`}
                  aria-current={current ? "step" : undefined}
                  title={b.name}
                  onClick={() => onSelectTeam(b.teamId)}
                  className={`flex h-full w-full flex-col rounded border px-2 py-1 text-left ${
                    current
                      ? "min-w-44 border-2 border-accent bg-accent/10 py-1.5"
                      : "border-border bg-surface text-sm"
                  } ${selected ? "ring-2 ring-accent/40" : ""}`}
                >
                  <span className="flex items-baseline gap-1.5">
                    <span className="text-xs tabular-nums text-muted">#{b.n}</span>
                    <span className="font-mono font-bold">{b.abbr}</span>
                    {mine && !current && (
                      <span
                        className="ml-auto rounded bg-accent px-1 text-[10px] font-semibold text-accent-fg"
                        data-testid={`otc-mine-${b.n}`}
                      >
                        You
                      </span>
                    )}
                  </span>
                  {current && (
                    <>
                      <span className="truncate text-sm" data-testid="otc-name">
                        {b.name}
                      </span>
                      <span className="flex items-center gap-2">
                        {paused ? (
                          <span className="text-sm text-muted">Paused</span>
                        ) : (
                          clockRemaining !== null && (
                            <span
                              className={`text-base font-semibold tabular-nums ${clockExpired ? "text-error" : ""}`}
                              data-testid="otc-clock"
                            >
                              {clockExpired ? "Time expired" : formatClock(clockRemaining)}
                            </span>
                          )
                        )}
                        {mine && (
                          <span
                            className="ml-auto rounded bg-accent px-1.5 text-xs font-semibold text-accent-fg"
                            data-testid="otc-mine-current"
                          >
                            You
                          </span>
                        )}
                      </span>
                    </>
                  )}
                </button>
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
