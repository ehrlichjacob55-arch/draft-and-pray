import type { AvailablePlayer, DraftSnapshot, PositionName } from "@dnp/contract";
import { compareByRank, type Slot } from "@dnp/domain";
import { useMemo, useState } from "react";
import { btnPrimary, btnSecondary, inputCls } from "../components/ui";
import { POSITION_LIST, type Eligibility } from "./model";
import { PanelCard, PositionBadge } from "./parts";
import { colsFor, HEADLINE, statText, statValue, type StatCol } from "./stats";

const PAGE = 100;

const INJURY: Record<string, [string, string]> = {
  questionable: ["Q", "Questionable"],
  doubtful: ["D", "Doubtful"],
  out: ["O", "Out"],
  ir: ["IR", "Injured reserve"],
  pup: ["PUP", "Physically unable to perform"],
  sus: ["SUS", "Suspended"],
};
const injuryShort = (s: string) =>
  INJURY[s.toLowerCase()]?.[0] ?? (s.length > 3 ? s.slice(0, 3) : s);
const injuryWord = (s: string) => INJURY[s.toLowerCase()]?.[1] ?? s;

/** `null` = overall rank ascending (the default). */
type Sort = { col: string; dir: "asc" | "desc" } | null;

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
  onOpenDetail: (player: AvailablePlayer) => void;
  /** Phone layout: compact rows with headline stats instead of the table. */
  compact?: boolean;
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
  onOpenDetail,
  compact = false,
  className = "",
  title = "Players",
}: PlayersPanelProps) {
  const [search, setSearch] = useState("");
  const [position, setPosition] = useState<PositionName | "">("");
  const [nflTeam, setNflTeam] = useState("");
  const [hideIneligible, setHideIneligible] = useState(true);
  const [sort, setSort] = useState<Sort>(null);
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
  const cols = colsFor(position);
  const activeSort =
    sort && (sort.col === "rank" || cols.some((c) => c.id === sort.col)) ? sort : null;

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = snapshot.available.filter(
      (p) =>
        (!q || p.name.toLowerCase().includes(q)) &&
        (!position || p.position === position) &&
        (!nflTeam || p.nflTeam === nflTeam) &&
        (!hideIneligible || !eligibility || eligibility.eligible(p)),
    );
    const byRank = (a: AvailablePlayer, b: AvailablePlayer) => compareByRank(a, b, seeds);
    if (!activeSort) return filtered.sort(byRank);
    if (activeSort.col === "rank") {
      return filtered.sort((a, b) => byRank(b, a));
    }
    const col = cols.find((x) => x.id === activeSort.col)!;
    const sign = activeSort.dir === "desc" ? -1 : 1;
    return filtered.sort((a, b) => {
      const va = statValue(a, col);
      const vb = statValue(b, col);
      if (va === null && vb === null) return byRank(a, b);
      if (va === null) return 1;
      if (vb === null) return -1;
      return va === vb ? byRank(a, b) : sign * (va - vb);
    });
  }, [
    snapshot.available,
    seeds,
    search,
    position,
    nflTeam,
    hideIneligible,
    eligibility,
    activeSort,
    cols,
  ]);

  /** Stat columns: desc, then asc, then back to rank. Rank: toggles best-first / worst-first. */
  function cycleSort(col: string) {
    setLimit(PAGE);
    if (col === "rank") {
      setSort(activeSort?.col === "rank" ? null : { col: "rank", dir: "desc" });
      return;
    }
    if (activeSort?.col !== col) setSort({ col, dir: "desc" });
    else setSort(activeSort.dir === "desc" ? { col, dir: "asc" } : null);
  }
  const ariaSort = (col: string) =>
    activeSort?.col === col
      ? col === "rank"
        ? "descending"
        : activeSort.dir === "desc"
          ? "descending"
          : "ascending"
      : "none";
  const arrow = (col: string) =>
    activeSort?.col !== col ? "" : activeSort.dir === "desc" ? " ▼" : " ▲";

  function actions(p: AvailablePlayer, dense = false) {
    const slot = eligibility?.slotFor(p) ?? null;
    const eligible = eligibility ? eligibility.eligible(p) : false;
    const enabled = canPick && eligible && slot !== null;
    const inQueue = queued.has(p.playerId);
    return (
      <>
        {canQueue && (
          <button
            type="button"
            className={`${btnSecondary} ${dense ? "min-h-8 min-w-8 px-1.5 py-1" : "min-w-10 whitespace-nowrap px-2"}`}
            aria-pressed={inQueue}
            aria-label={inQueue ? `Remove ${p.name} from queue` : `Add ${p.name} to queue`}
            onClick={() => onToggleQueue(p.playerId)}
          >
            {dense ? (inQueue ? "★" : "☆") : inQueue ? "★ Queued" : "★ Queue"}
          </button>
        )}
        <button
          type="button"
          className={dense ? `${btnPrimary} min-h-8 px-2.5 py-1` : btnPrimary}
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
      </>
    );
  }

  const nameButton = (p: AvailablePlayer, wrap = false) => (
    <button
      type="button"
      className={`max-w-full text-left font-medium underline-offset-2 hover:underline ${wrap ? "" : "truncate"}`}
      aria-label={`Details for ${p.name}`}
      onClick={() => onOpenDetail(p)}
    >
      {p.name}
    </button>
  );
  const injuryTag = (p: AvailablePlayer) =>
    p.injuryStatus && (
      <span
        className="ml-1 shrink-0 rounded border border-error px-1 text-[10px] leading-4 text-error"
        title={injuryWord(p.injuryStatus)}
        aria-label={`Injury: ${injuryWord(p.injuryStatus)}`}
      >
        {injuryShort(p.injuryStatus)}
      </span>
    );
  const rankText = (p: AvailablePlayer) => (p.rank !== null ? `#${p.rank}` : "—");

  const headlineCols = (p: AvailablePlayer): StatCol[] =>
    HEADLINE[p.position].flatMap((id) => {
      const col = colsFor(p.position).find((x) => x.id === id);
      return col ? [col] : [];
    });

  const shown = rows.slice(0, limit);
  const statsSeason = snapshot.statsSeason;

  return (
    <PanelCard title={title} className={className} testId="players">
      <p className="-mt-1 mb-2 text-xs text-muted" data-testid="stats-note">
        {statsSeason ? `Stats: ${statsSeason} regular season` : "Stats: not imported yet"}
      </p>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-[2fr_1fr_1fr_auto] lg:items-center">
        <label className="col-span-2 text-sm lg:col-span-1">
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
        <label className="col-span-2 flex items-center gap-2 text-sm lg:col-span-1">
          <input
            type="checkbox"
            checked={hideIneligible}
            onChange={(e) => setHideIneligible(e.target.checked)}
          />
          Hide ineligible
        </label>
        {compact && (
          <label className="col-span-2 text-sm">
            <span className="sr-only">Sort by</span>
            <select
              className={inputCls}
              aria-label="Sort by"
              value={activeSort ? `${activeSort.col}:${activeSort.dir}` : ""}
              onChange={(e) => {
                const [col, dir] = e.target.value.split(":");
                setSort(col ? { col, dir: dir === "asc" ? "asc" : "desc" } : null);
              }}
            >
              <option value="">Sort: rank</option>
              {cols.map((col) => (
                <option key={col.id} value={`${col.id}:desc`}>
                  {col.label} (high to low)
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted" data-testid="players-empty">
          {snapshot.available.length === 0
            ? "No players are available."
            : "No players match these filters."}
        </p>
      ) : compact ? (
        <ul className="mt-3 divide-y divide-border" aria-label="Available players">
          {shown.map((p) => {
            const eligible = eligibility ? eligibility.eligible(p) : false;
            return (
              <li
                key={p.playerId}
                data-testid={`player-${p.playerId}`}
                className={`space-y-1 py-2 ${eligibility && !eligible ? "opacity-60" : ""}`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="w-9 shrink-0 text-right text-xs tabular-nums text-muted"
                    data-testid={`rank-${p.playerId}`}
                    title="Overall rank"
                  >
                    {rankText(p)}
                  </span>
                  <PositionBadge position={p.position} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate">
                      {nameButton(p)}
                      {injuryTag(p)}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {p.nflTeam}
                      {" · "}
                      {headlineCols(p)
                        .map((col) => `${col.label} ${statText(p, col)}`)
                        .join(" · ")}
                    </p>
                  </div>
                </div>
                <div className="flex justify-end gap-2">{actions(p)}</div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="mt-3 max-h-[65vh] overflow-auto" data-testid="players-scroll">
          <table className="w-full border-collapse text-sm" aria-label="Available players">
            <thead className="sticky top-0 bg-surface text-left text-xs text-muted">
              <tr>
                <th
                  scope="col"
                  className="px-1 py-1 text-right align-bottom"
                  aria-sort={ariaSort("rank")}
                >
                  <button type="button" className="font-semibold" onClick={() => cycleSort("rank")}>
                    Rank{arrow("rank")}
                  </button>
                </th>
                <th scope="col" className="px-1 py-1">
                  Player
                </th>
                <th scope="col" className="px-1 py-1">
                  Pos
                </th>
                <th scope="col" className="px-1 py-1">
                  Team
                </th>
                {cols.map((col) => (
                  <th
                    key={col.id}
                    scope="col"
                    className="px-1.5 py-1 text-right align-bottom"
                    aria-sort={ariaSort(col.id)}
                  >
                    <button
                      type="button"
                      className="max-w-14 text-right font-semibold leading-tight"
                      onClick={() => cycleSort(col.id)}
                    >
                      {col.label}
                      {arrow(col.id)}
                    </button>
                  </th>
                ))}
                <th scope="col" className="sticky right-0 bg-surface px-1 py-1 text-right">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {shown.map((p) => {
                const eligible = eligibility ? eligibility.eligible(p) : false;
                return (
                  <tr
                    key={p.playerId}
                    data-testid={`player-${p.playerId}`}
                    className={eligibility && !eligible ? "opacity-60" : ""}
                  >
                    <td
                      className="px-1 py-1.5 text-right text-xs tabular-nums text-muted"
                      data-testid={`rank-${p.playerId}`}
                      title="Overall rank"
                    >
                      {rankText(p)}
                    </td>
                    <td className="min-w-28 px-1 py-1.5">
                      <span className="flex flex-wrap items-center">
                        {nameButton(p, true)}
                        {injuryTag(p)}
                      </span>
                    </td>
                    <td className="px-1 py-1.5">
                      <PositionBadge position={p.position} />
                    </td>
                    <td className="whitespace-nowrap px-1 py-1.5 text-xs">{p.nflTeam}</td>
                    {cols.map((col) => (
                      <td
                        key={col.id}
                        data-testid={`stat-${p.playerId}-${col.id}`}
                        className="px-1.5 py-1.5 text-right text-xs tabular-nums"
                      >
                        {statText(p, col)}
                      </td>
                    ))}
                    <td className="sticky right-0 bg-surface px-1 py-1.5">
                      <div className="flex justify-end gap-1">{actions(p, true)}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
