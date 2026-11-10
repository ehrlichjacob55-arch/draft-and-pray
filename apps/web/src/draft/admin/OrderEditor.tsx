import type { DraftSnapshot } from "@dnp/contract";
import { useState } from "react";
import { useApi } from "../../api";
import { btnPrimary, btnSecondary, ErrorNote } from "../../components/ui";
import { useAction } from "../useAction";

interface Row {
  teamId: string;
  name: string;
}

function initialRows(s: DraftSnapshot): Row[] {
  if (s.order.length > 0) return [...s.order].sort((a, b) => a.position - b.position);
  return s.teams.map((t) => ({ teamId: t.teamId, name: t.name }));
}

/** Arrange the 9 teams by draft position. Mount with a `key` that changes when the saved order does. */
export function OrderEditor({
  seasonId,
  snapshot,
  onSaved,
}: {
  seasonId: string;
  snapshot: DraftSnapshot;
  onSaved: () => void;
}) {
  const api = useApi();
  const [rows, setRows] = useState<Row[]>(() => initialRows(snapshot));
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();

  const move = (i: number, delta: -1 | 1) => {
    const j = i + delta;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setRows(next);
    setDirty(true);
    setSaved(false);
  };

  async function save() {
    const res = await run(() =>
      api.setDraftOrder(
        seasonId,
        rows.map((r) => r.teamId),
      ),
    );
    if (res) {
      setDirty(false);
      setSaved(true);
      onSaved();
    }
  }

  if (rows.length === 0) return <p className="text-sm text-muted">No teams yet.</p>;
  return (
    <div className="space-y-2" data-testid="order-editor">
      <h4 className="font-medium">Draft order</h4>
      <ol className="divide-y divide-border" aria-label="Draft order">
        {rows.map((r, i) => (
          <li key={r.teamId} className="flex items-center gap-2 py-1.5">
            <span className="w-5 text-right text-muted">{i + 1}.</span>
            <span className="min-w-0 flex-1 truncate">{r.name}</span>
            <button
              type="button"
              className={`${btnSecondary} px-2`}
              aria-label={`Move ${r.name} up`}
              disabled={i === 0}
              onClick={() => move(i, -1)}
            >
              ↑
            </button>
            <button
              type="button"
              className={`${btnSecondary} px-2`}
              aria-label={`Move ${r.name} down`}
              disabled={i === rows.length - 1}
              onClick={() => move(i, 1)}
            >
              ↓
            </button>
          </li>
        ))}
      </ol>
      <button
        type="button"
        className={btnPrimary}
        disabled={busy || (!dirty && snapshot.order.length > 0)}
        onClick={() => void save()}
      >
        Save order
      </button>
      {saved && (
        <span role="status" className="ml-2 text-sm text-ok">
          Order saved.
        </span>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}
