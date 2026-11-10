import { useEffect, useRef } from "react";
import { btnPrimary, btnSecondary, ErrorNote } from "../components/ui";

export interface ConfirmSheetProps {
  title: string;
  /** e.g. "Draft Jane Doe → RB1?" */
  message: string;
  confirmLabel: string;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Bottom sheet on phones, centred on desktop. */
export function ConfirmSheet({
  title,
  message,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onCancel,
}: ConfirmSheetProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef(onCancel);
  useEffect(() => {
    cancelRef.current = onCancel;
  });
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 md:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-md space-y-3 rounded-t-lg border border-border bg-surface p-4 md:rounded-lg"
      >
        <p className="text-lg font-semibold" data-testid="confirm-message">
          {message}
        </p>
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="flex gap-2">
          <button
            ref={ref}
            type="button"
            className={btnPrimary}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
          <button type="button" className={btnSecondary} disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
