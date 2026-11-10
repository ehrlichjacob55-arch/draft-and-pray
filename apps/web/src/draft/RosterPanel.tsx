import type { DraftSnapshot, SlotName } from "@dnp/contract";
import { useState } from "react";
import { inputCls } from "../components/ui";
import { SLOT_ORDER, teamName } from "./model";
import { PanelCard, PositionBadge } from "./parts";

export function RosterPanel({
  snapshot,
  className = "",
}: {
  snapshot: DraftSnapshot;
  className?: string;
}) {
  const teams = snapshot.order.length
    ? snapshot.order.map((o) => ({ teamId: o.teamId, name: o.name }))
    : snapshot.teams;
  const [picked, setPicked] = useState<string | null>(null);
  const viewing = picked ?? snapshot.myTeamId ?? teams[0]?.teamId ?? null;
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
            value={viewing ?? ""}
            onChange={(e) => setPicked(e.target.value)}
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
              className="flex items-center justify-between gap-2 py-1.5"
            >
              <span className="w-12 text-xs font-semibold text-muted">{slot}</span>
              {pick ? (
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <PositionBadge position={pick.player.position} />
                  <span className="truncate">{pick.player.name}</span>
                  <span className="text-xs text-muted">{pick.player.nflTeam}</span>
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
