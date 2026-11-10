import type { DraftSnapshot } from "@dnp/contract";
import { blockerText } from "./model";
import { PanelCard } from "./parts";

export function Lobby({ snapshot }: { snapshot: DraftSnapshot }) {
  const ordered = snapshot.order.length > 0;
  const rows = ordered
    ? snapshot.order.map((o) => ({
        key: o.teamId,
        position: o.position as number | null,
        name: o.name,
        teamId: o.teamId,
      }))
    : snapshot.teams.map((t) => ({
        key: t.teamId,
        position: null as number | null,
        name: t.name,
        teamId: t.teamId,
      }));
  const joined = new Map(snapshot.teams.map((t) => [t.teamId, t.joined]));
  return (
    <div className="space-y-3" data-testid="draft-lobby">
      <PanelCard title="Draft lobby">
        <p className="text-muted">Waiting for the commissioner to start the draft.</p>
        {!ordered && (
          <p className="mt-2 text-sm" data-testid="order-not-set">
            Draft order not set yet.
          </p>
        )}
        <ol className="mt-3 divide-y divide-border" aria-label="Teams">
          {rows.map((r) => (
            <li key={r.key} className="flex items-center justify-between gap-2 py-2">
              <span>
                {r.position !== null && (
                  <span className="mr-2 inline-block w-5 text-right text-muted">{r.position}.</span>
                )}
                {r.name}
                {r.teamId === snapshot.myTeamId && (
                  <span className="ml-2 text-sm text-muted">you</span>
                )}
              </span>
              <span className={`text-sm ${joined.get(r.teamId) ? "text-ok" : "text-muted"}`}>
                {joined.get(r.teamId) ? "Joined" : "Not joined yet"}
              </span>
            </li>
          ))}
        </ol>
      </PanelCard>
      {snapshot.startBlockers.length > 0 && (
        <PanelCard title="Still needed before the draft can start" testId="start-blockers">
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {snapshot.startBlockers.map((b) => (
              <li key={b}>{blockerText(b)}</li>
            ))}
          </ul>
        </PanelCard>
      )}
    </div>
  );
}
