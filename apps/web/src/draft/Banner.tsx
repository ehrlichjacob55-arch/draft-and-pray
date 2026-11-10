import type { DraftSnapshot } from "@dnp/contract";
import { formatClock } from "./clock";
import { deriveView } from "./model";
import { ConnectionDot } from "./parts";
import type { ConnectionStatus } from "../realtime/useDraftChannel";

export function Banner({
  snapshot,
  connection,
  clockRemaining,
  clockExpired,
}: {
  snapshot: DraftSnapshot;
  connection: ConnectionStatus;
  clockRemaining: number | null;
  clockExpired: boolean;
}) {
  const view = deriveView(snapshot);
  const paused = snapshot.status === "paused";
  return (
    <div
      data-testid="draft-banner"
      className={`rounded border p-3 ${view.isMyTurn ? "border-accent bg-accent/10" : "border-border bg-surface"}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">
          <span data-testid="banner-round">Round {snapshot.round}</span> ·{" "}
          <span data-testid="banner-pick">
            Pick {snapshot.currentPick} of {snapshot.totalPicks}
          </span>
        </p>
        <ConnectionDot status={connection} />
      </div>
      <p className="mt-1" data-testid="banner-clock-team">
        On the clock: <strong>{view.onClockName}</strong>
        {view.isMyTurn && <span className="ml-2 font-semibold text-accent">Your pick!</span>}
      </p>
      {!view.isMyTurn && view.picksUntilMyTurn !== null && view.picksUntilMyTurn > 0 && (
        <p className="text-sm text-muted" data-testid="banner-until">
          You pick in {view.picksUntilMyTurn} (pick {view.myNextPick})
        </p>
      )}
      {paused && (
        <p
          role="status"
          className="mt-2 rounded border border-border px-2 py-1 text-sm font-medium"
          data-testid="banner-paused"
        >
          Draft paused by the commissioner.
        </p>
      )}
      {!paused && clockRemaining !== null && (
        <p
          className={`mt-2 text-lg font-semibold tabular-nums ${clockExpired ? "text-error" : ""}`}
          data-testid="banner-countdown"
        >
          {clockExpired ? "Time expired" : formatClock(clockRemaining)}
        </p>
      )}
    </div>
  );
}
