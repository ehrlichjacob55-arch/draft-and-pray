import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { btnDanger, btnSecondary, ErrorNote, inputCls } from "../components/ui";

const show = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

/**
 * Number input that keeps what the user is typing ("1.", "-") while it commits a number upward.
 * Empty commits `undefined`; text that is not a number commits the raw text so validation flags it.
 */
export function NumberField({
  label,
  value,
  onChange,
  className = "",
  placeholder,
}: {
  label: string;
  value: unknown;
  onChange: (v: number | string | undefined) => void;
  className?: string;
  placeholder?: string;
}) {
  const [text, setText] = useState(show(value));
  const last = useRef(value);
  useEffect(() => {
    // Adopt outside changes (Discard, the JSON box, another row) but not our own echo.
    if (value !== last.current) {
      last.current = value;
      setText(show(value));
    }
  }, [value]);
  return (
    <input
      aria-label={label}
      inputMode="decimal"
      autoComplete="off"
      placeholder={placeholder}
      className={`${inputCls} w-24 min-w-0 ${className}`}
      value={text}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        const trimmed = t.trim();
        const next =
          trimmed === "" ? undefined : Number.isFinite(Number(trimmed)) ? Number(trimmed) : t;
        last.current = next;
        onChange(next);
      }}
    />
  );
}

export function Badge({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "ok" | "accent" | "muted";
}) {
  const cls = {
    ok: "border-ok text-ok",
    accent: "border-accent text-accent",
    muted: "border-border text-muted",
  }[tone];
  return (
    <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {children}
    </span>
  );
}

/** Modal confirm. Escape and the backdrop-free Cancel button both dismiss it. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  busy = false,
  error,
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  error?: string | null;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-md space-y-3 rounded border border-border bg-surface p-4"
      >
        <h3 id={titleId} className="text-lg font-semibold">
          {title}
        </h3>
        <div className="space-y-2 text-sm">{children}</div>
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            className={btnSecondary}
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className={
              danger
                ? btnDanger
                : "inline-flex min-h-10 items-center justify-center rounded bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
            }
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
