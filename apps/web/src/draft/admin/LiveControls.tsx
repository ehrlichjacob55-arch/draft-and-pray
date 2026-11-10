import type { DraftSnapshot } from "@dnp/contract";
import { useState } from "react";
import { useApi } from "../../api";
import { btnPrimary, btnSecondary, ErrorNote } from "../../components/ui";
import { deriveView } from "../model";
import { useAction } from "../useAction";
import { PoolReview } from "./PoolReview";

export function LiveControls({
  seasonId,
  snapshot,
  commishPick,
  onCommishPick,
  onChanged,
}: {
  seasonId: string;
  snapshot: DraftSnapshot;
  commishPick: boolean;
  onCommishPick: (on: boolean) => void;
  onChanged: () => void;
}) {
  const api = useApi();
  const { busy, error, run } = useAction();
  const [confirmUndo, setConfirmUndo] = useState(false);
  const view = deriveView(snapshot);
  const live = snapshot.status === "in_progress";
  const paused = snapshot.status === "paused";
  const complete = snapshot.status === "complete";
  const last = snapshot.picks.length > 0 ? snapshot.picks[snapshot.picks.length - 1]! : null;

  const act = async (fn: () => Promise<unknown>) => {
    const ok = await run(fn);
    onChanged();
    return ok;
  };

  return (
    <div className="space-y-4" data-testid="live-controls">
      {!complete && (
        <div className="flex flex-wrap gap-2">
          {live && (
            <button
              type="button"
              className={btnSecondary}
              disabled={busy}
              onClick={() => void act(() => api.pauseDraft(seasonId))}
            >
              Pause draft
            </button>
          )}
          {paused && (
            <button
              type="button"
              className={btnPrimary}
              disabled={busy}
              onClick={() => void act(() => api.resumeDraft(seasonId))}
            >
              Resume draft
            </button>
          )}
          {live && !snapshot.clock && (
            <button
              type="button"
              className={btnSecondary}
              disabled={busy}
              onClick={() => void act(() => api.startClock(seasonId, snapshot.currentPick))}
            >
              Start 90 s clock
            </button>
          )}
          {live && snapshot.clock && (
            <button
              type="button"
              className={btnSecondary}
              disabled={busy}
              onClick={() => void act(() => api.clearClock(seasonId))}
            >
              Clear clock
            </button>
          )}
          {live && (
            <button
              type="button"
              className={btnSecondary}
              disabled={busy}
              onClick={() => void act(() => api.autopick(seasonId, snapshot.currentPick))}
            >
              Autopick for {view.onClockName}
            </button>
          )}
        </div>
      )}

      {live && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={commishPick}
            onChange={(e) => onCommishPick(e.target.checked)}
          />
          <span>
            <span className="font-medium">Make the pick for {view.onClockName}</span>
            <span className="block text-muted">
              Turns the Players list into commissioner mode: Draft picks for the team on the clock.
            </span>
          </span>
        </label>
      )}

      {(live || paused || complete) && last && (
        <div>
          {confirmUndo ? (
            <div
              role="group"
              aria-label="Confirm undo"
              className="space-y-2 rounded border border-error p-2"
            >
              <p className="text-sm">
                Undo pick {last.overallPick} ({last.player.name})? The pick returns to the board.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={btnPrimary}
                  disabled={busy}
                  onClick={() =>
                    void act(() => api.undoPick(seasonId)).then(() => setConfirmUndo(false))
                  }
                >
                  Confirm undo
                </button>
                <button
                  type="button"
                  className={btnSecondary}
                  onClick={() => setConfirmUndo(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className={btnSecondary} onClick={() => setConfirmUndo(true)}>
              Undo last pick
            </button>
          )}
        </div>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}

      {paused && (
        <details>
          <summary className="cursor-pointer font-medium">Player pool (while paused)</summary>
          <div className="mt-2">
            <PoolReview seasonId={seasonId} reloadKey={0} onChanged={onChanged} />
          </div>
        </details>
      )}
    </div>
  );
}
