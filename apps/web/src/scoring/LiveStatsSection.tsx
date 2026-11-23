import { useEffect, useRef, useState } from "react";
import type { IngestGame, IngestResponse, IngestRound } from "@dnp/contract";
import { useApi } from "../api";
import {
  btnPrimary,
  btnSecondary,
  Card,
  ErrorNote,
  ErrorWithRetry,
  Loading,
} from "../components/ui";
import { friendlyError } from "../lib/messages";
import { useQuery } from "../useQuery";
import { Badge } from "./fields";

const ROUND_NAMES: Record<IngestRound["code"], string> = {
  WC: "Wild Card",
  DIV: "Divisional",
  CONF: "Conference",
  SB: "Super Bowl",
};
const ROUND_TONE = { upcoming: "muted", live: "accent", final: "ok", finalized: "ok" } as const;
const ROUND_LABEL = {
  upcoming: "Upcoming",
  live: "Live",
  final: "Final",
  finalized: "Finalized",
} as const;
/** More warnings than this start collapsed. */
const WARNINGS_OPEN_MAX = 5;

/** "5 min ago" / "in 2 min" / "in 6 h". Past and future, coarse on purpose. */
export function relativeTime(iso: string, now: Date): string {
  const ms = Date.parse(iso) - now.getTime();
  const abs = Math.abs(ms);
  const minutes = Math.round(abs / 60_000);
  let text: string;
  if (abs < 45_000) return ms > 0 ? "in a moment" : "just now";
  if (minutes < 60) text = `${minutes} min`;
  else if (minutes < 48 * 60) text = `${Math.round(minutes / 60)} h`;
  else text = `${Math.round(minutes / (24 * 60))} days`;
  return ms > 0 ? `in ${text}` : `${text} ago`;
}

/** For something that already happened: a server clock slightly ahead of ours still reads as past. */
export const relativePast = (iso: string, now: Date): string =>
  relativeTime(new Date(Math.min(Date.parse(iso), now.getTime())).toISOString(), now);

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

/** `AWY 24 @ HOME 31 · Final`, or the kickoff time before the game starts. */
export function gameLine(g: IngestGame): string {
  if (g.status === "scheduled") return `${g.away} @ ${g.home} · ${when(g.kickoff)}`;
  return `${g.away} ${g.awayScore} @ ${g.home} ${g.homeScore} · ${g.status === "final" ? "Final" : "Live"}`;
}

/**
 * "Live stats" card of the Commissioner page (docs/design/12): the on/off switch for the ESPN
 * stats updates, when they last/next ran, every round with its games, and warnings.
 */
export function LiveStatsSection({ seasonId }: { seasonId: string }) {
  const api = useApi();
  const query = useQuery(`ingest:${seasonId}`, () => api.ingest(seasonId));
  const [latest, setLatest] = useState<IngestResponse | null>(null);
  const [busy, setBusy] = useState<"toggle" | "run" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  // A newly loaded state replaces what the last action returned.
  const seen = useRef(query.data);
  useEffect(() => {
    if (query.data !== seen.current) {
      seen.current = query.data;
      setLatest(null);
    }
  }, [query.data]);
  // Keep "5 min ago" honest without refetching.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  const data = latest ?? (query.status === "ready" ? query.data : undefined);

  async function act(kind: "toggle" | "run", call: () => Promise<IngestResponse>) {
    setBusy(kind);
    setError(null);
    try {
      setLatest(await call());
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card data-testid="live-stats-section">
      <h3 className="font-semibold">Live stats</h3>
      <div className="mt-2 space-y-4">
        {query.status === "loading" && <Loading />}
        {query.status === "error" && !latest && (
          <ErrorWithRetry message={friendlyError(query.error)} onRetry={query.reload} />
        )}
        {data && (
          <>
            <div className="space-y-1 text-sm" data-testid="live-stats-status">
              <p className="font-medium">Live stats are {data.enabled ? "on" : "off"}</p>
              <p className="text-muted">
                {data.lastSuccessAt
                  ? `Last updated ${relativePast(data.lastSuccessAt, now)}`
                  : "Not updated yet"}
                {data.enabled &&
                  (data.nextPollAt
                    ? ` · Next check ${relativeTime(data.nextPollAt, now)}`
                    : " · No more checks scheduled")}
              </p>
            </div>
            {data.lastError && (
              <ErrorNote>
                The last update did not work: {data.lastError}
                {data.lastRunAt ? ` (${relativePast(data.lastRunAt, now)})` : ""}
              </ErrorNote>
            )}
            {error && <ErrorNote>{error}</ErrorNote>}
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                className={data.enabled ? btnSecondary : btnPrimary}
                disabled={busy !== null}
                onClick={() => void act("toggle", () => api.setIngest(seasonId, !data.enabled))}
              >
                {data.enabled ? "Turn off" : "Turn on"}
              </button>
              <button
                type="button"
                className={btnSecondary}
                disabled={busy !== null}
                onClick={() => void act("run", () => api.runIngest(seasonId))}
              >
                {busy === "run" ? "Refreshing…" : "Refresh now"}
              </button>
            </div>
            <Rounds rounds={data.rounds} />
            <Warnings warnings={data.warnings} />
          </>
        )}
      </div>
    </Card>
  );
}

function Rounds({ rounds }: { rounds: IngestRound[] }) {
  if (rounds.length === 0)
    return <p className="text-sm text-muted">No games yet. They appear after the first update.</p>;
  return (
    <ul className="space-y-3" aria-label="Rounds">
      {rounds.map((r) => (
        <li key={r.round} data-testid={`live-round-${r.code}`}>
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
            <span>{ROUND_NAMES[r.code]}</span>
            <Badge tone={ROUND_TONE[r.status]}>{ROUND_LABEL[r.status]}</Badge>
          </p>
          {r.games.length === 0 ? (
            <p className="text-sm text-muted">No games listed yet</p>
          ) : (
            <ul className="mt-1 space-y-0.5 text-sm">
              {r.games.map((g) => (
                <li key={g.gameId}>{gameLine(g)}</li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

function Warnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <details open={warnings.length <= WARNINGS_OPEN_MAX} data-testid="live-warnings">
      <summary className="cursor-pointer text-sm font-medium">
        {warnings.length} warning{warnings.length === 1 ? "" : "s"}
      </summary>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
        {warnings.map((w) => (
          <li key={w} className="break-words">
            {w}
          </li>
        ))}
      </ul>
    </details>
  );
}
