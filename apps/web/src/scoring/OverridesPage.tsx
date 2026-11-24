import type { GameLine, GameLinesResponse, IngestGame, IngestRound } from "@dnp/contract";
import { overrideKeysFor, type Position } from "@dnp/domain";
import { useId, useState } from "react";
import { Link } from "react-router";
import { useApi } from "../api";
import {
  btnPrimary,
  btnSecondary,
  Card,
  ErrorNote,
  ErrorWithRetry,
  inputCls,
  Loading,
} from "../components/ui";
import { friendlyError } from "../lib/messages";
import { useLeague } from "../league/LeagueProvider";
import { useQuery } from "../useQuery";
import { STAT_LABELS } from "./catalog";
import { Badge } from "./fields";
import { gameLine, ROUND_LABEL, ROUND_NAMES, ROUND_TONE } from "./LiveStatsSection";

/** Plain name for a stat key (the scoring editor's labels); unknown keys show as-is. */
const statLabel = (key: string): string => (STAT_LABELS as Record<string, string>)[key] ?? key;

const pts = (n: number | null) => (n === null ? "—" : String(Math.round(n * 100) / 100));

/** `/commissioner/overrides` (docs/design/06 §7, 04 §7): correct a player's stats for one game. */
export function OverridesPage() {
  const league = useLeague();
  if (league.status === "loading") return <Loading />;
  if (league.status === "error")
    return <ErrorWithRetry message={friendlyError(league.error)} onRetry={league.reload} />;
  if (!league.isCommissioner || !league.season)
    return (
      <section className="space-y-2">
        <h2 className="text-xl font-semibold">Stat overrides</h2>
        <p role="alert" className="text-muted">
          Only the commissioner can see this page.
        </p>
      </section>
    );
  return <Overrides seasonId={league.season.seasonId} />;
}

function Overrides({ seasonId }: { seasonId: string }) {
  const api = useApi();
  const ingest = useQuery(`ingest:${seasonId}`, () => api.ingest(seasonId));
  const [roundPick, setRoundPick] = useState<number | null>(null);
  const [gamePick, setGamePick] = useState<string | null>(null);

  const rounds = ingest.status === "ready" ? ingest.data.rounds : [];
  const round =
    rounds.find((r) => r.round === roundPick) ?? rounds.find((r) => r.games.length > 0) ?? null;
  const game = round?.games.find((g) => g.gameId === gamePick) ?? null;

  return (
    <section className="space-y-4">
      <div>
        <Link to="/commissioner" className="text-sm text-accent underline">
          ← Commissioner
        </Link>
        <h2 className="mt-1 text-xl font-semibold">Stat overrides</h2>
        <p className="text-sm text-muted">
          Correct a stat for one game. Overrides stay in place when ESPN updates, and every change
          is recorded in the audit log.
        </p>
      </div>
      {ingest.status === "loading" && <Loading />}
      {ingest.status === "error" && (
        <ErrorWithRetry message={friendlyError(ingest.error)} onRetry={ingest.reload} />
      )}
      {ingest.status === "ready" && rounds.every((r) => r.games.length === 0) && (
        <p className="text-muted">No games yet. They appear after the first stats update.</p>
      )}
      {round && (
        <Card>
          <div role="group" aria-label="Round" className="flex flex-wrap gap-2">
            {rounds.map((r) => (
              <button
                key={r.round}
                type="button"
                aria-pressed={r.round === round.round}
                className={r.round === round.round ? btnPrimary : btnSecondary}
                onClick={() => {
                  setRoundPick(r.round);
                  setGamePick(null);
                }}
              >
                {r.code}
              </button>
            ))}
          </div>
          <p className="mt-3 flex flex-wrap items-center gap-2 text-sm font-medium">
            <span>{ROUND_NAMES[round.code]}</span>
            <Badge tone={ROUND_TONE[round.status]}>{ROUND_LABEL[round.status]}</Badge>
          </p>
          <GameList round={round} selected={game?.gameId ?? null} onPick={setGamePick} />
        </Card>
      )}
      {round && game && (
        <GameLines key={game.gameId} seasonId={seasonId} game={game} round={round} />
      )}
    </section>
  );
}

function GameList({
  round,
  selected,
  onPick,
}: {
  round: IngestRound;
  selected: string | null;
  onPick: (gameId: string) => void;
}) {
  if (round.games.length === 0)
    return <p className="mt-2 text-sm text-muted">No games listed yet</p>;
  return (
    <ul aria-label="Games" className="mt-2 space-y-2">
      {round.games.map((g: IngestGame) => (
        <li key={g.gameId}>
          <button
            type="button"
            aria-pressed={g.gameId === selected}
            className={`${g.gameId === selected ? btnPrimary : btnSecondary} w-full justify-start text-left`}
            onClick={() => onPick(g.gameId)}
          >
            {gameLine(g)}
          </button>
        </li>
      ))}
    </ul>
  );
}

function GameLines({
  seasonId,
  game,
  round,
}: {
  seasonId: string;
  game: IngestGame;
  round: IngestRound;
}) {
  const api = useApi();
  const query = useQuery(`lines:${seasonId}:${game.gameId}`, () =>
    api.gameLines(seasonId, game.gameId),
  );
  const [latest, setLatest] = useState<GameLinesResponse | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const data = latest ?? (query.status === "ready" ? query.data : undefined);
  // The round may have been finalized since the page loaded: trust the freshest status.
  const frozen = (data?.game.roundStatus ?? round.status) === "finalized";

  return (
    <Card data-testid="game-lines">
      <h3 className="font-semibold">{gameLine(game)}</h3>
      {query.status === "loading" && <Loading />}
      {query.status === "error" && !data && (
        <ErrorWithRetry message={friendlyError(query.error)} onRetry={query.reload} />
      )}
      {data && (
        <div className="mt-2 space-y-3">
          {frozen && (
            <p role="status" className="rounded border border-border px-3 py-2 text-sm text-muted">
              This round is finalized, so its stats are read-only. Unfreeze it on the Commissioner
              page to make changes.
            </p>
          )}
          {data.lines.length === 0 ? (
            <p className="text-sm text-muted">No stats for this game yet.</p>
          ) : (
            <ul aria-label="Player lines" className="divide-y divide-border">
              {data.lines.map((line) => (
                <li key={line.playerId} className="py-2" data-testid={`line-${line.playerId}`}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="min-w-0 flex-1 basis-40">
                      <span className="font-medium">{line.name}</span>{" "}
                      <span className="text-xs text-muted">
                        {line.position} · {line.nflTeam}
                      </span>
                      {line.overrides.length > 0 && (
                        <span className="ml-2">
                          <Badge tone="accent">Edited</Badge>
                        </span>
                      )}
                    </span>
                    <span className="w-16 text-right font-mono text-sm" aria-label="Points">
                      {pts(line.points)}
                    </span>
                    {!frozen && (
                      <button
                        type="button"
                        className={btnSecondary}
                        aria-label={`Edit ${line.name}`}
                        aria-expanded={editing === line.playerId}
                        onClick={() => setEditing(editing === line.playerId ? null : line.playerId)}
                      >
                        {editing === line.playerId ? "Close" : "Edit"}
                      </button>
                    )}
                  </div>
                  {line.issue && <p className="mt-1 text-sm text-error">{line.issue}</p>}
                  {(frozen || editing !== line.playerId) && line.overrides.length > 0 && (
                    <OverrideSummary line={line} />
                  )}
                  {!frozen && editing === line.playerId && (
                    <LineEditor
                      key={line.playerId}
                      line={line}
                      onSave={async (statKey, value, reason) =>
                        setLatest(
                          await api.setOverride(seasonId, {
                            gameId: game.gameId,
                            playerId: line.playerId,
                            statKey,
                            value,
                            reason,
                          }),
                        )
                      }
                      onClear={async (statKey) =>
                        setLatest(
                          await api.clearOverride(seasonId, game.gameId, line.playerId, statKey),
                        )
                      }
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

function OverrideSummary({ line }: { line: GameLine }) {
  return (
    <ul className="mt-1 space-y-0.5 text-sm text-muted" aria-label={`${line.name} overrides`}>
      {line.overrides.map((o) => (
        <li key={o.statKey}>
          <span>{statLabel(o.statKey)}</span> {line.provider?.counts[o.statKey] ?? 0} →{" "}
          <span className="font-semibold text-text">{o.value}</span> · {o.reason}
        </li>
      ))}
    </ul>
  );
}

function LineEditor({
  line,
  onSave,
  onClear,
}: {
  line: GameLine;
  onSave: (statKey: string, value: number, reason: string) => Promise<void>;
  onClear: (statKey: string) => Promise<void>;
}) {
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keys = [
    ...new Set([
      ...overrideKeysFor(line.position as Position),
      ...line.overrides.map((o) => o.statKey),
    ]),
  ];

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  function save(key: string) {
    const text = (drafts[key] ?? "").trim();
    if (!/^\d+$/.test(text)) return setError(`Enter a whole number of 0 or more for ${statLabel(key)}.`);
    if (!reason.trim()) return setError("Enter a reason for the change.");
    void run(key, async () => {
      await onSave(key, Number(text), reason.trim());
      setDrafts((d) => ({ ...d, [key]: "" }));
      setReason("");
    });
  }

  return (
    <div className="mt-2 space-y-3 rounded border border-border p-3" data-testid="line-editor">
      <div>
        <label htmlFor={reasonId} className="mb-1 block text-sm font-medium">
          Reason (required, shown in the audit log)
        </label>
        <input
          id={reasonId}
          className={inputCls}
          value={reason}
          maxLength={200}
          autoComplete="off"
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <ul aria-label={`${line.name} stats`} className="divide-y divide-border">
        {keys.map((key) => {
          const provider = line.provider?.counts[key] ?? 0;
          const override = line.overrides.find((o) => o.statKey === key);
          return (
            <li key={key} className="space-y-1 py-2" data-testid={`stat-${key}`}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="min-w-0 flex-1 basis-32">
                  {statLabel(key)}
                  {override && <span className="ml-1 text-accent">*</span>}
                </span>
                <span className="text-muted">ESPN {provider}</span>
                <span className={override ? "font-semibold" : "text-muted"}>
                  {override ? `Override ${override.value}` : "No override"}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  aria-label={`${key} override`}
                  inputMode="numeric"
                  autoComplete="off"
                  className={`${inputCls.replace("w-full", "w-24")} min-w-0`}
                  value={drafts[key] ?? ""}
                  placeholder={String(override?.value ?? provider)}
                  onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                />
                <button
                  type="button"
                  className={btnPrimary}
                  aria-label={`Save ${key}`}
                  disabled={busy !== null}
                  onClick={() => save(key)}
                >
                  {busy === key ? "Saving…" : "Save"}
                </button>
                {override && (
                  <button
                    type="button"
                    className={btnSecondary}
                    aria-label={`Clear ${key}`}
                    disabled={busy !== null}
                    onClick={() => void run(key, () => onClear(key))}
                  >
                    Clear
                  </button>
                )}
              </div>
              {override && <p className="text-xs text-muted">{override.reason}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
