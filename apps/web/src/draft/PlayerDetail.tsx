import type { AvailablePlayer } from "@dnp/contract";
import { useEffect, useRef, useState } from "react";
import { btnPrimary, btnSecondary } from "../components/ui";
import { PositionBadge } from "./parts";
import { colsFor, statText } from "./stats";

export interface PlayerDetailProps {
  player: AvailablePlayer;
  statsSeason: number | null | undefined;
  inQueue: boolean;
  canQueue: boolean;
  /** Draft is allowed right now for this player. */
  canDraft: boolean;
  /** False once the draft is complete: there is nothing left to draft. */
  showDraft?: boolean;
  draftHint?: string;
  onToggleQueue: () => void;
  onDraft: () => void;
  onClose: () => void;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]!;
  const last = parts.length > 1 ? parts[parts.length - 1]! : "";
  return (first[0]! + (last[0] ?? "")).toUpperCase();
}

/** Large headshot (or team logo); an initials avatar when there is no image or it fails to load. */
function Avatar({ url, name }: { url: string | null | undefined; name: string }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed)
    return (
      <div
        data-testid="avatar-fallback"
        aria-hidden="true"
        className="flex size-24 shrink-0 items-center justify-center rounded-lg bg-bg text-2xl font-semibold text-muted"
      >
        {initials(name)}
      </div>
    );
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      data-testid="avatar-img"
      className="size-24 shrink-0 rounded-lg bg-bg object-cover object-top"
      onError={() => setFailed(true)}
    />
  );
}

const FOCUSABLE =
  "button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

/**
 * Side drawer on desktop, bottom sheet on phones. Focus moves in on open, Tab is kept inside,
 * Esc / the close button / the backdrop close it and focus returns to what opened it.
 */
export function PlayerDetail({
  player,
  statsSeason,
  inQueue,
  canQueue,
  canDraft,
  showDraft = true,
  draftHint,
  onToggleQueue,
  onDraft,
  onClose,
}: PlayerDetailProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const items = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panelRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panelRef.current.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const cols = colsFor(player.position);
  const gp = player.stats ? (player.stats.gp ?? 0) : null;
  const schedule =
    player.seed === 1
      ? "BYE (first-round bye)"
      : player.opponent
        ? `Wild Card vs ${player.opponent}`
        : "Wild Card opponent not set";

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center md:items-stretch md:justify-end">
      <div className="absolute inset-0 bg-black/40" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Player details: ${player.name}`}
        data-testid="player-detail"
        className="relative max-h-[85vh] w-full space-y-3 overflow-y-auto rounded-t-lg border border-border bg-surface p-4 md:max-h-none md:w-96 md:rounded-none md:rounded-l-lg"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3" data-testid="face-card">
            <Avatar key={player.headshotUrl ?? ""} url={player.headshotUrl} name={player.name} />
            <div className="min-w-0">
              <h3 className="break-words text-lg font-semibold leading-tight">{player.name}</h3>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
                <PositionBadge position={player.position} />
                <span>
                  {player.nflTeam}
                  {player.seed !== null && ` (#${player.seed} seed)`}
                </span>
              </p>
              {player.injuryStatus && (
                <span
                  className="mt-1 inline-block rounded border border-error px-1 text-xs leading-5 text-error"
                  data-testid="face-injury"
                >
                  {player.injuryStatus}
                </span>
              )}
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            className={btnSecondary}
            aria-label="Close player details"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm" data-testid="detail-info">
          <dt className="text-muted">Overall rank</dt>
          <dd>{player.rank !== null ? `#${player.rank}` : "Unranked"}</dd>
          <dt className="text-muted">Games played</dt>
          <dd>{gp === null ? "—" : gp}</dd>
          <dt className="text-muted">Injury</dt>
          <dd>{player.injuryStatus ?? "Healthy"}</dd>
          <dt className="text-muted">Playoffs</dt>
          <dd>{schedule}</dd>
        </dl>

        <div>
          <h4 className="mb-1 text-sm font-semibold">
            {statsSeason ? `${statsSeason} regular season` : "Last season"}
          </h4>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm" data-testid="detail-stats">
            {cols
              .filter((c) => c.id !== "gp")
              .map((c) => (
                <div key={c.id} className="contents">
                  <dt className="text-muted">{c.label}</dt>
                  <dd className="tabular-nums">{statText(player, c)}</dd>
                </div>
              ))}
          </dl>
        </div>

        <div className="flex flex-wrap gap-2">
          {canQueue && (
            <button
              type="button"
              className={btnSecondary}
              aria-pressed={inQueue}
              onClick={onToggleQueue}
            >
              {inQueue ? "★ Queued" : "★ Queue"}
            </button>
          )}
          {showDraft && (
            <button
              type="button"
              className={btnPrimary}
              disabled={!canDraft}
              title={canDraft ? undefined : draftHint}
              onClick={onDraft}
            >
              Draft
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
