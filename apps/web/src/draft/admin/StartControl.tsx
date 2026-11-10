import type { DraftSnapshot } from "@dnp/contract";
import { useState } from "react";
import { ApiError, useApi } from "../../api";
import { btnPrimary, ErrorNote } from "../../components/ui";
import { friendlyError } from "../../lib/messages";
import { blockerText } from "../model";

export function StartControl({
  seasonId,
  snapshot,
  onStarted,
}: {
  seasonId: string;
  snapshot: DraftSnapshot;
  onStarted: () => void;
}) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [reasons, setReasons] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setReasons([]);
    setError(null);
    try {
      await api.startDraft(seasonId);
      onStarted();
    } catch (e) {
      if (e instanceof ApiError && e.code === "draft_not_ready" && e.reasons.length > 0)
        setReasons(e.reasons);
      else setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2" data-testid="start-control">
      <h4 className="font-medium">Start the draft</h4>
      {snapshot.startBlockers.length > 0 && (
        <p className="text-sm text-muted">
          Not ready yet: {snapshot.startBlockers.map(blockerText).join(" ")}
        </p>
      )}
      <button type="button" className={btnPrimary} disabled={busy} onClick={() => void start()}>
        {busy ? "Starting…" : "Start draft"}
      </button>
      {reasons.length > 0 && (
        <div role="alert" className="rounded border border-error px-3 py-2 text-sm text-error">
          <p className="font-medium">The draft cannot start yet:</p>
          <ul className="list-disc pl-5">
            {reasons.map((r) => (
              <li key={r}>{blockerText(r)}</li>
            ))}
          </ul>
        </div>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}
