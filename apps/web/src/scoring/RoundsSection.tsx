import type { IngestRound } from "@dnp/contract";
import { useCallback, useState } from "react";
import { Link } from "react-router";
import { useApi } from "../api";
import {
  btnPrimary,
  btnSecondary,
  Card,
  ErrorWithRetry,
  inputCls,
  Loading,
} from "../components/ui";
import { friendlyError } from "../lib/messages";
import { Badge, ConfirmDialog } from "./fields";
import { useIngestState } from "./IngestState";
import { ROUND_LABEL, ROUND_NAMES, ROUND_TONE } from "./LiveStatsSection";

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

type Pending = { kind: "finalize" | "unfreeze"; round: IngestRound };

/**
 * "Rounds" card of the Commissioner page (docs/design/06 §7, 04 §6): each round's status and
 * override count, Finalize once a round is final, and Unfreeze (with a reason) once it is frozen.
 */
export function RoundsSection({ seasonId }: { seasonId: string }) {
  const api = useApi();
  const { query, data, apply } = useIngestState();
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable: the dialog refocuses its Cancel button whenever `onCancel` changes.
  const close = useCallback(() => {
    setPending(null);
    setReason("");
    setError(null);
  }, []);

  async function confirm() {
    if (!pending) return;
    if (pending.kind === "unfreeze" && !reason.trim()) {
      setError("Enter a reason for unfreezing.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      apply(
        pending.kind === "finalize"
          ? await api.finalizeRound(seasonId, pending.round.round)
          : await api.unfreezeRound(seasonId, pending.round.round, reason.trim()),
      );
      close();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-testid="rounds-section">
      <h3 className="font-semibold">Rounds</h3>
      <div className="mt-2 space-y-3">
        {query.status === "loading" && <Loading />}
        {query.status === "error" && !data && (
          <ErrorWithRetry message={friendlyError(query.error)} onRetry={query.reload} />
        )}
        {data &&
          (data.rounds.length === 0 ? (
            <p className="text-sm text-muted">Rounds appear after the first stats update.</p>
          ) : (
            <ul className="divide-y divide-border" aria-label="Round status">
              {data.rounds.map((r) => (
                <li key={r.round} className="space-y-1 py-2" data-testid={`round-row-${r.code}`}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <span className="min-w-0 flex-1 basis-40 font-medium">
                      <span className="font-mono text-xs text-muted">{r.code}</span>{" "}
                      {ROUND_NAMES[r.code]}
                    </span>
                    <Badge tone={ROUND_TONE[r.status]}>{ROUND_LABEL[r.status]}</Badge>
                    <span className="text-sm text-muted">
                      {r.overrideCount === 0
                        ? "No overrides"
                        : `${r.overrideCount} override${r.overrideCount === 1 ? "" : "s"}`}
                    </span>
                    {r.status === "final" && (
                      <button
                        type="button"
                        className={btnPrimary}
                        aria-label={`Finalize ${ROUND_NAMES[r.code]}`}
                        onClick={() => setPending({ kind: "finalize", round: r })}
                      >
                        Finalize
                      </button>
                    )}
                    {r.status === "finalized" && (
                      <>
                        {r.finalizedAt && (
                          <span className="text-sm text-muted">Finalized {day(r.finalizedAt)}</span>
                        )}
                        <button
                          type="button"
                          className={btnSecondary}
                          aria-label={`Unfreeze ${ROUND_NAMES[r.code]}`}
                          onClick={() => setPending({ kind: "unfreeze", round: r })}
                        >
                          Unfreeze
                        </button>
                      </>
                    )}
                  </div>
                  {r.status === "finalized" && r.providerChangedAt && (
                    <p role="status" className="text-sm text-error">
                      ESPN changed stats after you finalized this round. Unfreeze it to bring the
                      changes in.
                    </p>
                  )}
                </li>
              ))}
            </ul>
          ))}
        <Link to="/commissioner/overrides" className="inline-block text-sm text-accent underline">
          Stat overrides
        </Link>
      </div>
      {pending?.kind === "finalize" && (
        <ConfirmDialog
          title={`Finalize ${ROUND_NAMES[pending.round.code]}?`}
          confirmLabel="Finalize"
          busy={busy}
          error={error}
          onConfirm={() => void confirm()}
          onCancel={close}
        >
          <p>
            Freeze {ROUND_NAMES[pending.round.code]} points? Late stat changes won&apos;t move them
            until you unfreeze.
          </p>
        </ConfirmDialog>
      )}
      {pending?.kind === "unfreeze" && (
        <ConfirmDialog
          title={`Unfreeze ${ROUND_NAMES[pending.round.code]}?`}
          confirmLabel="Unfreeze"
          busy={busy}
          error={error}
          onConfirm={() => void confirm()}
          onCancel={close}
        >
          <p>
            The round&apos;s points will update again with the latest stats and overrides. This is
            recorded in the audit log.
          </p>
          <label className="block text-sm font-medium">
            Reason
            <input
              className={`${inputCls} mt-1 font-normal`}
              value={reason}
              maxLength={200}
              autoComplete="off"
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        </ConfirmDialog>
      )}
    </Card>
  );
}
