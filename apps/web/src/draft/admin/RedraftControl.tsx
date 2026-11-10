import { REDRAFT_CONFIRMATION, type DraftSnapshot } from "@dnp/contract";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useApi } from "../../api";
import { btnDanger, btnSecondary, ErrorNote, inputCls } from "../../components/ui";
import { friendlyError } from "../../lib/messages";

/**
 * Redraft (docs/design/14 §4a): a danger button plus a confirm dialog that needs the word REDRAFT.
 * Shown to the commissioner once the draft has started; `resetting` (an interrupted reset) can be
 * resumed with the same button.
 */
export function RedraftControl({
  seasonId,
  snapshot,
  onDone,
}: {
  seasonId: string;
  snapshot: DraftSnapshot;
  onDone: () => void;
}) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const n = snapshot.picks.length;
  const confirmed = typed === REDRAFT_CONFIRMATION;

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy]);

  function close() {
    setOpen(false);
    setTyped("");
    setError(null);
    opener.current?.focus();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!confirmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.resetDraft(seasonId);
      setOpen(false);
      setTyped("");
      onDone();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2" data-testid="redraft-control">
      <h4 className="font-medium">Redraft</h4>
      <p className="text-sm text-muted">
        Clears all {n} picks and returns the draft to the lobby. Order, teams, queues and auto-draft
        settings are kept.
      </p>
      <button ref={opener} type="button" className={btnDanger} onClick={() => setOpen(true)}>
        Redraft
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          data-testid="redraft-backdrop"
        >
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="w-full max-w-md space-y-3 rounded border border-error bg-surface p-4"
            onSubmit={(e) => void submit(e)}
          >
            <h3 id={titleId} className="text-lg font-semibold">
              Redraft the league?
            </h3>
            <p className="text-sm">
              This removes all {n} picks and every roster, and makes every drafted player available
              again. It cannot be undone.
            </p>
            <label className="block text-sm">
              Type <strong>{REDRAFT_CONFIRMATION}</strong> to confirm
              <input
                ref={inputRef}
                className={`${inputCls} mt-1`}
                value={typed}
                autoComplete="off"
                onChange={(e) => setTyped(e.target.value)}
              />
            </label>
            {error && <ErrorNote>{error}</ErrorNote>}
            <div className="flex justify-end gap-2">
              <button type="button" className={btnSecondary} disabled={busy} onClick={close}>
                Cancel
              </button>
              <button type="submit" className={btnDanger} disabled={!confirmed || busy}>
                {busy ? "Resetting…" : "Redraft now"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
