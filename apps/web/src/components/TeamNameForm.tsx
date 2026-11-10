import { TEAM_NAME_MAX, teamAbbrSchema } from "@dnp/contract";
import { useId, useState, type FormEvent } from "react";
import { friendlyError } from "../lib/messages";
import { btnPrimary, btnSecondary, ErrorNote, inputCls } from "./ui";

/**
 * Team-name input used for joining (accept) and renaming. With `initialAbbr` it also edits the
 * team abbreviation; `onSubmit` receives the abbreviation only when the user changed it, so an
 * untouched auto-default keeps following the name.
 */
export function TeamNameForm({
  initial = "",
  initialAbbr,
  label = "Team name",
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: string;
  initialAbbr?: string;
  label?: string;
  submitLabel: string;
  onSubmit: (name: string, abbr?: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const id = useId();
  const abbrId = useId();
  const [name, setName] = useState(initial);
  const [abbr, setAbbr] = useState(initialAbbr ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return setError("Enter a team name.");
    let changedAbbr: string | undefined;
    if (initialAbbr !== undefined && abbr.trim().toUpperCase() !== initialAbbr) {
      const parsed = teamAbbrSchema.safeParse(abbr);
      if (!parsed.success) return setError("Abbreviation must be 2 to 4 letters or digits.");
      changedAbbr = parsed.data;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed, changedAbbr);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor={id} className="mb-1 block text-sm font-medium">
            {label}
          </label>
          <input
            id={id}
            className={inputCls}
            value={name}
            maxLength={TEAM_NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
          />
        </div>
        {initialAbbr !== undefined && (
          <div className="w-20 shrink-0">
            <label htmlFor={abbrId} className="mb-1 block text-sm font-medium">
              Abbr.
            </label>
            <input
              id={abbrId}
              className={`${inputCls} text-center font-mono uppercase`}
              value={abbr}
              maxLength={4}
              onChange={(e) => setAbbr(e.target.value.toUpperCase())}
              autoComplete="off"
              spellCheck={false}
              aria-label="Team abbreviation"
            />
          </div>
        )}
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex gap-2">
        <button type="submit" className={btnPrimary} disabled={busy}>
          {busy ? "Saving…" : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className={btnSecondary} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
