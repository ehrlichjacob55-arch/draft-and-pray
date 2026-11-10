import type { PreviewRow } from "./model";

const fmt = (n: number | null): string => (n === null ? "–" : String(n));

/** The golden-fixture players scored under the saved rules and under the unsaved edits. */
export function Preview({ rows, editedValid }: { rows: PreviewRow[]; editedValid: boolean }) {
  return (
    <div className="space-y-2" data-testid="scoring-preview">
      <h4 className="font-medium">Preview</h4>
      <p className="text-xs text-muted">
        Real stat lines from the 2025–26 Wild Card game (Rams 34, Panthers 31), scored with the
        saved rules and with your edits.
      </p>
      {!editedValid && (
        <p role="status" className="text-sm text-error">
          Fix the problems above to preview your edits.
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted">
              <th className="py-1 pr-2 font-medium">Player</th>
              <th className="px-2 py-1 text-right font-medium">Saved</th>
              <th className="px-2 py-1 text-right font-medium">Edited</th>
              <th className="py-1 pl-2 text-right font-medium">Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const delta =
                r.saved !== null && r.edited !== null
                  ? Number((r.edited - r.saved).toFixed(4))
                  : null;
              return (
                <tr
                  key={r.name}
                  className="border-b border-border last:border-0"
                  data-testid="preview-row"
                >
                  <td className="py-1 pr-2">{r.name}</td>
                  <td className="px-2 py-1 text-right tabular-nums" data-col="saved">
                    {fmt(r.saved)}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums" data-col="edited">
                    {fmt(r.edited)}
                  </td>
                  <td
                    className={`py-1 pl-2 text-right tabular-nums ${delta ? "font-medium text-accent" : "text-muted"}`}
                    data-col="delta"
                  >
                    {delta === null ? "–" : delta > 0 ? `+${delta}` : String(delta)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
