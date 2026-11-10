import type { PositionName } from "@dnp/contract";
import type { ConnectionStatus } from "../realtime/useDraftChannel";
import { POSITION_CLASS } from "./model";

export function PositionBadge({ position }: { position: PositionName }) {
  return (
    <span
      className={`inline-block min-w-9 rounded px-1.5 py-0.5 text-center text-xs font-semibold ${POSITION_CLASS[position]}`}
    >
      {position}
    </span>
  );
}

const CONNECTION: Record<ConnectionStatus, { label: string; dot: string }> = {
  connected: { label: "Live", dot: "bg-ok" },
  connecting: { label: "Connecting…", dot: "bg-amber-500" },
  disconnected: { label: "Offline: refreshing every 5 s", dot: "bg-error" },
};

export function ConnectionDot({ status }: { status: ConnectionStatus }) {
  const c = CONNECTION[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted" data-testid="connection">
      <span aria-hidden="true" className={`inline-block size-2.5 rounded-full ${c.dot}`} />
      <span>{c.label}</span>
    </span>
  );
}

export function PanelCard({
  title,
  children,
  className = "",
  testId,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section
      aria-label={title}
      data-testid={testId}
      className={`rounded border border-border bg-surface p-3 ${className}`}
    >
      <h3 className="mb-2 font-semibold">{title}</h3>
      {children}
    </section>
  );
}
