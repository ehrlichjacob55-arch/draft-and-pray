import type { ImportPoolResponse } from "@dnp/contract";
import { useState, type FormEvent } from "react";
import { useApi } from "../../api";
import { btnPrimary, ErrorNote, inputCls } from "../../components/ui";
import { useAction } from "../useAction";

/** Default NFL season to import for now (last real playoff field; see docs/design/14 §3). */
export const DEFAULT_IMPORT_YEAR = 2025;

export function ImportPool({ seasonId, onDone }: { seasonId: string; onDone: () => void }) {
  const api = useApi();
  const [year, setYear] = useState(String(DEFAULT_IMPORT_YEAR));
  const [result, setResult] = useState<ImportPoolResponse | null>(null);
  const { busy, error, run } = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const seasonYear = Number(year);
    const res = await run(() => api.importPool(seasonId, seasonYear));
    if (res) {
      setResult(res);
      onDone();
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} aria-label="Import playoff field" className="space-y-2">
      <h4 className="font-medium">Import playoff field</h4>
      <label className="block text-sm">
        <span className="mb-1 block text-muted">NFL season year</span>
        <input
          className={`${inputCls} max-w-32`}
          inputMode="numeric"
          value={year}
          onChange={(e) => setYear(e.target.value)}
        />
      </label>
      <p className="text-xs text-muted">
        Use 2025 for now: it imports last season&apos;s real playoff field for mock drafts.
        Re-running keeps your include/exclude choices.
      </p>
      <button type="submit" className={btnPrimary} disabled={busy || !/^\d{4}$/.test(year)}>
        {busy ? "Importing…" : "Import playoff field"}
      </button>
      {error && <ErrorNote>{error}</ErrorNote>}
      {result && (
        <p
          role="status"
          className="rounded border border-ok px-3 py-2 text-sm text-ok"
          data-testid="import-result"
        >
          Imported {result.counts.players} players from {result.counts.teams} teams (
          {result.counts.added} added, {result.counts.updated} updated, {result.counts.removed}{" "}
          removed).
        </p>
      )}
    </form>
  );
}
