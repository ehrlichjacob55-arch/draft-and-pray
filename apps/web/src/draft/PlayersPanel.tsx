import type { AvailablePlayer, DraftSnapshot, PositionName } from "@dnp/contract";
import { compareByRank, type Slot } from "@dnp/domain";
import { useMemo, useState } from "react";
import { btnPrimary, btnSecondary, inputCls } from "../components/ui";
import { POSITION_LIST, type Eligibility } from "./model";
import { PanelCard, PositionBadge } from "./parts";

const PAGE = 100;

export interface PlayersPanelProps {
  snapshot: DraftSnapshot;
  /** Eligibility for the team that would be picking (null: nobody picks from here). */
  eligibility: Eligibility | null;
  /** The viewer (or commissioner mode) may make the current pick. */
  canPick: boolean;
  /** Why Draft is disabled, shown on the button. */
  blockedReason?: string;
  queueIds: string[];
  canQueue: boolean;
  onToggleQueue: (playerId: string) => void;
  onDraft: (player: AvailablePlayer, slot: Slot) => void;
  className?: string;
  title?: string;
}

export function PlayersPanel({
  snapshot,
  eligibility,
  canPick,
  blockedReason,
  queueIds,
  canQueue,
  onToggleQueue,
  onDraft,
  className = "",
  title = "Players",
}: PlayersPanelProps) {
  const [search, setSearch] = useState("");
  const [position, setPosition] = useState<PositionName | "">("");
  const [nflTeam, setNflTeam] = useState("");
  const [hideIneligible, setHideIneligible] = useState(true);
  const [limit, setLimit] = useState(PAGE);

  // The playoff field: teams of available players plus teams of already-drafted players.
  const nflTeams = useMemo(
    () =>
      [
        ...new Set([
          ...snapshot.available.map((p) => p.nflTeam),
          ...snapshot.picks.map((k) => k.player.nflTeam),
        ]),
      ].sort(),
    [snapshot.available, snapshot.picks],
  );
  const seeds = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of snapshot.available) if (p.seed !== null) m.set(p.nflTeam, p.seed);
    return m;
  }, [snapshot.available]);
  const queued = useMemo(() => new Set(queueIds), [queueIds]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return snapshot.available
      .filter(
        (p) =>
          (!q || p.name.toLowerCase().includes(q)) &&
          (!position || p.position === position) &&
          (!nflTeam || p.nflTeam === nflTeam) &&
          (!hideIneligible || !eligibility || eligibility.eligible(p)),
      )
      .sort((a, b) => compareByRank(a, b, seeds));
  }, [snapshot.available, seeds, search, position, nflTeam, hideIneligible, eligibility]);

  return (
    <PanelCard title={title} className={className} testId="players">
      <div className="grid grid-cols-2 gap-2">
        <label className="col-span-2 text-sm">
          <span className="sr-only">Search players</span>
          <input
            type="search"
            className={inputCls}
            placeholder="Search players"
            aria-label="Search players"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setLimit(PAGE);
            }}
          />
        </label>
        <label className="text-sm">
          <span className="sr-only">Position</span>
          <select
            className={inputCls}
            aria-label="Position"
            value={position}
            onChange={(e) => {
              setPosition(e.target.value as PositionName | "");
              setLimit(PAGE);
            }}
          >
            <option value="">All positions</option>
            {POSITION_LIST.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="sr-only">NFL team</span>
          <select
            className={inputCls}
            aria-label="NFL team"
            value={nflTeam}
            onChange={(e) => {
              setNflTeam(e.target.value);
              setLimit(PAGE);
            }}
          >
            <option value="">All NFL teams</option>
            {nflTeams.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="col-span-2 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={hideIneligible}
            onChange={(e) => setHideIneligible(e.target.checked)}
          />
          Hide ineligible
        </label>
      </div>

      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted" data-testid="players-empty">
          {snapshot.available.length === 0
            ? "No players are available."
            : "No players match these filters."}
        </p>
      ) : (
        <ul
          className="mt-3 max-h-[60vh] divide-y divide-border overflow-y-auto"
          aria-label="Available players"
        >
          {rows.slice(0, limit).map((p) => {
            const slot = eligibility?.slotFor(p) ?? null;
            const eligible = eligibility ? eligibility.eligible(p) : false;
            const enabled = canPick && eligible && slot !== null;
            const inQueue = queued.has(p.playerId);
            return (
              <li
                key={p.playerId}
                data-testid={`player-${p.playerId}`}
                className={`flex items-center gap-2 py-2 ${eligibility && !eligible ? "opacity-60" : ""}`}
              >
                <span
                  className="w-10 shrink-0 text-right text-xs tabular-nums text-muted"
                  data-testid={`rank-${p.playerId}`}
                  title="Overall rank"
                >
                  {p.rank !== null ? `#${p.rank}` : "—"}
                </span>
                <PositionBadge position={p.position} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{p.name}</p>
                  <p className="truncate text-xs text-muted">
                    {p.nflTeam}
                    {p.seed !== null && ` (#${p.seed})`}
                    {p.opponent && ` · vs ${p.opponent}`}
                    {p.injuryStatus && (
                      <span className="ml-1 rounded border border-error px-1 text-error">
                        {p.injuryStatus}
                      </span>
                    )}
                  </p>
                </div>
                {canQueue && (
                  <button
                    type="button"
                    className={`${btnSecondary} min-w-10 px-2`}
                    aria-pressed={inQueue}
                    aria-label={inQueue ? `Remove ${p.name} from queue` : `Add ${p.name} to queue`}
                    onClick={() => onToggleQueue(p.playerId)}
                  >
                    {inQueue ? "★" : "☆"}
                  </button>
                )}
                <button
                  type="button"
                  className={btnPrimary}
                  disabled={!enabled}
                  aria-label={`Draft ${p.name}`}
                  title={
                    enabled
                      ? undefined
                      : eligibility && !eligible
                        ? "No open roster spot for this position"
                        : blockedReason
                  }
                  onClick={() => slot && onDraft(p, slot)}
                >
                  Draft
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {rows.length > limit && (
        <button
          type="button"
          className={`${btnSecondary} mt-2 w-full`}
          onClick={() => setLimit((l) => l + PAGE)}
        >
          Show more ({rows.length - limit} more)
        </button>
      )}
    </PanelCard>
  );
}
