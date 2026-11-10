import type { DraftSnapshot, SlotName } from "@dnp/contract";
import { inputCls } from "../components/ui";
import { SLOT_ORDER, teamName } from "./model";
import { PanelCard } from "./parts";

export function RosterPanel({
  snapshot,
  teamId,
  onTeamChange,
  className = "",
}: {
  snapshot: DraftSnapshot;
  /** Team being viewed (controlled by the draft room). */
  teamId: string | null;
  onTeamChange: (teamId: string) => void;
  className?: string;
}) {
  const teams = snapshot.order.length
    ? snapshot.order.map((o) => ({ teamId: o.teamId, name: o.name }))
    : snapshot.teams;
  const viewing = teamId;
  const roster: Partial<Record<SlotName, string | null>> = viewing
    ? (snapshot.rosters[viewing] ?? {})
    : {};
  const byId = new Map(snapshot.picks.map((p) => [p.playerId, p]));
  const mine = viewing === snapshot.myTeamId;
  return (
    <PanelCard title="Roster" className={className} testId="roster">
      {teams.length > 0 && (
        <label className="mb-2 block text-sm">
          <span className="mb-1 block text-muted">Team</span>
          <select
            className={inputCls}
            aria-label="Team"
            value={viewing ?? ""}
            onChange={(e) => onTeamChange(e.target.value)}
          >
            {teams.map((t) => (
              <option key={t.teamId} value={t.teamId}>
                {t.name}
                {t.teamId === snapshot.myTeamId ? " (you)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="mb-1 text-sm text-muted" data-testid="roster-owner">
        {mine ? "Your roster" : `${teamName(snapshot, viewing)} roster`}
      </p>
      <ul className="divide-y divide-border">
        {SLOT_ORDER.map((slot) => {
          const id = roster[slot];
          const pick = id ? byId.get(id) : undefined;
          return (
            <li
              key={slot}
              data-testid={`slot-${slot}`}
              className="flex items-start justify-between gap-2 py-1.5"
            >
              <span className="w-10 shrink-0 text-xs font-semibold text-muted">
                {slot.replace(/\d+$/, "")}
              </span>
              {pick ? (
                <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                  <span className="min-w-0 break-words text-sm">{pick.player.name}</span>
                  <span className="shrink-0 text-[11px] text-muted">{pick.player.nflTeam}</span>
                  {slot.startsWith("FLEX") && (
                    <span
                      className="shrink-0 rounded border border-border px-1 text-[10px] text-muted"
                      data-testid={`flex-pos-${slot}`}
                    >
                      {pick.player.position}
                    </span>
                  )}
                </span>
              ) : (
                <span className="flex-1 text-sm text-muted">Open</span>
              )}
            </li>
          );
        })}
      </ul>
    </PanelCard>
  );
}
