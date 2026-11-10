import type { PositionName } from "@dnp/contract";
import { compareByRank } from "@dnp/domain";
import { useMemo, useState, type FormEvent } from "react";
import { useApi } from "../../api";
import { btnPrimary, ErrorNote, ErrorWithRetry, inputCls, Loading } from "../../components/ui";
import { friendlyError } from "../../lib/messages";
import { useQuery } from "../../useQuery";
import { POSITION_LIST } from "../model";
import { PositionBadge } from "../parts";
import { useAction } from "../useAction";

const SHOW = 100;

export function PoolReview({
  seasonId,
  reloadKey,
  onChanged,
}: {
  seasonId: string;
  /** Changing this refetches the pool (e.g. after an import). */
  reloadKey: number;
  onChanged: () => void;
}) {
  const api = useApi();
  const query = useQuery(`players:${seasonId}:${reloadKey}`, () => api.listPlayers(seasonId));
  const [search, setSearch] = useState("");
  const [position, setPosition] = useState<PositionName | "">("");
  const [excludedOnly, setExcludedOnly] = useState(false);
  const toggle = useAction();

  const rows = useMemo(() => {
    if (query.status !== "ready") return [];
    const q = search.trim().toLowerCase();
    const seeds = new Map(query.data.teams.map((t) => [t.abbr, t.seed]));
    return query.data.players
      .filter(
        (p) =>
          (!q || p.name.toLowerCase().includes(q)) &&
          (!position || p.position === position) &&
          (!excludedOnly || !p.inPool),
      )
      .sort((a, b) => compareByRank(a, b, seeds));
  }, [query, search, position, excludedOnly]);

  if (query.status === "loading") return <Loading label="Loading the player pool…" />;
  if (query.status === "error")
    return <ErrorWithRetry message={friendlyError(query.error)} onRetry={query.reload} />;
  const { players, teams } = query.data;
  const included = players.filter((p) => p.inPool).length;

  return (
    <div className="space-y-2" data-testid="pool-review">
      <h4 className="font-medium">
        Player pool{" "}
        <span className="font-normal text-muted" data-testid="pool-count">
          {included} of {players.length} included
        </span>
      </h4>
      {players.length === 0 ? (
        <p className="text-sm text-muted">The pool is empty. Import the playoff field first.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="search"
              className={`${inputCls} col-span-2`}
              placeholder="Search pool"
              aria-label="Search pool"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              className={inputCls}
              aria-label="Pool position"
              value={position}
              onChange={(e) => setPosition(e.target.value as PositionName | "")}
            >
              <option value="">All positions</option>
              {POSITION_LIST.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={excludedOnly}
                onChange={(e) => setExcludedOnly(e.target.checked)}
              />
              Excluded only
            </label>
          </div>
          {toggle.error && <ErrorNote>{toggle.error}</ErrorNote>}
          <ul className="max-h-80 divide-y divide-border overflow-y-auto" aria-label="Pool players">
            {rows.slice(0, SHOW).map((p) => (
              <li key={p.playerId} className="flex items-center gap-2 py-1.5">
                <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted">
                  {p.rank !== null ? `#${p.rank}` : "—"}
                </span>
                <PositionBadge position={p.position} />
                <span className="min-w-0 flex-1 truncate">
                  {p.name} <span className="text-xs text-muted">{p.nflTeam}</span>
                  {p.draftedByTeamId && <span className="ml-1 text-xs text-muted">drafted</span>}
                </span>
                <label className="flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={p.inPool}
                    disabled={toggle.busy || !!p.draftedByTeamId}
                    aria-label={`Include ${p.name}`}
                    onChange={(e) => {
                      void toggle
                        .run(() => api.setPlayerInPool(seasonId, p.playerId, e.target.checked))
                        .then((r) => {
                          if (r) {
                            query.reload();
                            onChanged();
                          }
                        });
                    }}
                  />
                  In pool
                </label>
              </li>
            ))}
          </ul>
          {rows.length > SHOW && (
            <p className="text-xs text-muted">
              Showing the first {SHOW} of {rows.length}. Narrow the search to see others.
            </p>
          )}
          {rows.length === 0 && <p className="text-sm text-muted">No players match.</p>}
        </>
      )}
      <AddPlayerForm
        seasonId={seasonId}
        nflTeams={teams.map((t) => t.abbr)}
        onAdded={() => {
          query.reload();
          onChanged();
        }}
      />
    </div>
  );
}

function AddPlayerForm({
  seasonId,
  nflTeams,
  onAdded,
}: {
  seasonId: string;
  nflTeams: string[];
  onAdded: () => void;
}) {
  const api = useApi();
  const [name, setName] = useState("");
  const [position, setPosition] = useState<Exclude<PositionName, "DST">>("QB");
  const [team, setTeam] = useState("");
  const { busy, error, run } = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const nflTeam = team || nflTeams[0] || "";
    const added = await run(() => api.addPlayer(seasonId, { name, position, nflTeam }));
    if (added) {
      setName("");
      onAdded();
    }
  }

  return (
    <form
      aria-label="Add player"
      onSubmit={(e) => void submit(e)}
      className="space-y-2 rounded border border-border p-2"
    >
      <h5 className="text-sm font-medium">Add a player (e.g. a late call-up)</h5>
      <div className="grid grid-cols-3 gap-2">
        <input
          className={`${inputCls} col-span-3`}
          placeholder="Player name"
          aria-label="Player name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select
          className={inputCls}
          aria-label="New player position"
          value={position}
          onChange={(e) => setPosition(e.target.value as Exclude<PositionName, "DST">)}
        >
          {POSITION_LIST.filter((p) => p !== "DST").map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <select
          className={`${inputCls} col-span-2`}
          aria-label="New player NFL team"
          value={team || nflTeams[0] || ""}
          onChange={(e) => setTeam(e.target.value)}
        >
          {nflTeams.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </div>
      <button
        type="submit"
        className={btnPrimary}
        disabled={busy || !name.trim() || nflTeams.length === 0}
      >
        Add player
      </button>
      {error && <ErrorNote>{error}</ErrorNote>}
    </form>
  );
}
