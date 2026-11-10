import type { AvailablePlayer } from "@dnp/contract";
import { btnSecondary } from "../components/ui";
import { PanelCard, PositionBadge } from "./parts";

export interface QueuePanelProps {
  queue: AvailablePlayer[];
  autoDraft: boolean;
  busy: boolean;
  onMove: (playerId: string, delta: -1 | 1) => void;
  onRemove: (playerId: string) => void;
  onToggleAuto: (enabled: boolean) => void;
  className?: string;
}

export function QueuePanel({
  queue,
  autoDraft,
  busy,
  onMove,
  onRemove,
  onToggleAuto,
  className = "",
}: QueuePanelProps) {
  return (
    <PanelCard title="Queue" className={className} testId="queue">
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={autoDraft}
          disabled={busy}
          onChange={(e) => onToggleAuto(e.target.checked)}
        />
        <span>
          <span className="font-medium">Auto-draft my team</span>
          <span className="block text-muted">
            When it is your turn we pick for you: the top available, eligible player in your queue,
            otherwise by position order (#1 seeds first). You can turn it off at any time.
          </span>
        </span>
      </label>
      {queue.length === 0 ? (
        <p className="mt-3 text-sm text-muted" data-testid="queue-empty">
          Your queue is empty. Tap ☆ on a player to add them.
        </p>
      ) : (
        <ol className="mt-3 divide-y divide-border" aria-label="My queue">
          {queue.map((p, i) => (
            <li
              key={p.playerId}
              className="flex items-center gap-2 py-2"
              data-testid={`queued-${p.playerId}`}
            >
              <span className="w-5 text-right text-xs text-muted">{i + 1}</span>
              <PositionBadge position={p.position} />
              <span className="min-w-0 flex-1 truncate">
                {p.name} <span className="text-xs text-muted">{p.nflTeam}</span>
              </span>
              <button
                type="button"
                className={`${btnSecondary} px-2`}
                aria-label={`Move ${p.name} up`}
                disabled={i === 0}
                onClick={() => onMove(p.playerId, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className={`${btnSecondary} px-2`}
                aria-label={`Move ${p.name} down`}
                disabled={i === queue.length - 1}
                onClick={() => onMove(p.playerId, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className={`${btnSecondary} px-2`}
                aria-label={`Remove ${p.name} from queue`}
                onClick={() => onRemove(p.playerId)}
              >
                ✕
              </button>
            </li>
          ))}
        </ol>
      )}
    </PanelCard>
  );
}
