import type { ReactNode } from "react";

export const btnPrimary =
  "inline-flex min-h-10 items-center justify-center rounded bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50";
export const btnSecondary =
  "inline-flex min-h-10 items-center justify-center rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-text disabled:opacity-50";
export const inputCls =
  "w-full rounded border border-border bg-surface px-3 py-2 text-base text-text";

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p role="status" className="text-muted">
      {label}
    </p>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded border border-error px-3 py-2 text-sm text-error">
      {children}
    </p>
  );
}

export function ErrorWithRetry({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="space-y-2">
      <ErrorNote>{message}</ErrorNote>
      <button type="button" className={btnSecondary} onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded border border-border bg-surface p-4 ${className}`}>{children}</div>
  );
}
