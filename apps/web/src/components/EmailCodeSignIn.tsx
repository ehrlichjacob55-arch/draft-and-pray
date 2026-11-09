import { normalizeEmail } from "@dnp/contract";
import { useId, useState, type FormEvent } from "react";
import { authErrorMessage, useAuth } from "../auth";
import { friendlyError } from "../lib/messages";
import { ApiError } from "../api";
import { btnPrimary, btnSecondary, ErrorNote, inputCls } from "./ui";

/**
 * Email -> emailed code sign-in (Cognito), or email-only "Dev sign-in" locally.
 * `beforeSend` runs after the email is entered and before the code is requested
 * (the join flow registers the email on the invite there).
 */
export function EmailCodeSignIn({
  beforeSend,
  onSignedIn,
}: {
  beforeSend?: (email: string) => Promise<void>;
  onSignedIn?: () => void;
}) {
  const auth = useAuth();
  const emailId = useId();
  const codeId = useId();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const local = auth.mode === "local";

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? friendlyError(err) : authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function submitEmail(e: FormEvent) {
    e.preventDefault();
    const normalized = normalizeEmail(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return setError("Enter a valid email.");
    void run(async () => {
      await beforeSend?.(normalized);
      if (local) {
        auth.devSignIn(normalized);
        onSignedIn?.();
        return;
      }
      const next = await auth.startSignIn(normalized);
      if (next === "done") onSignedIn?.();
      else {
        setStep("code");
        setNotice(`We emailed a code to ${normalized}.`);
      }
    });
  }

  function submitCode(e: FormEvent) {
    e.preventDefault();
    if (!code.trim()) return setError("Enter the code from your email.");
    void run(async () => {
      await auth.confirmCode(code);
      onSignedIn?.();
    });
  }

  function resend() {
    void run(async () => {
      await auth.resendCode();
      setCode("");
      setNotice("A new code is on its way.");
    });
  }

  if (step === "code") {
    return (
      <form onSubmit={submitCode} className="space-y-3">
        {notice && (
          <p role="status" className="text-sm text-muted">
            {notice}
          </p>
        )}
        <div>
          <label htmlFor={codeId} className="mb-1 block text-sm font-medium">
            6-digit code
          </label>
          <input
            id={codeId}
            className={inputCls}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
          />
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={btnPrimary} disabled={busy}>
            {busy ? "Checking…" : "Sign in"}
          </button>
          <button type="button" className={btnSecondary} onClick={resend} disabled={busy}>
            Resend code
          </button>
          <button
            type="button"
            className={btnSecondary}
            onClick={() => {
              setStep("email");
              setError(null);
              setNotice(null);
            }}
            disabled={busy}
          >
            Use a different email
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={submitEmail} className="space-y-3">
      {local && (
        <p className="text-sm text-muted">
          Dev sign-in (local only): no code is sent. Enter any email.
        </p>
      )}
      <div>
        <label htmlFor={emailId} className="mb-1 block text-sm font-medium">
          Email
        </label>
        <input
          id={emailId}
          type="email"
          className={inputCls}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
        />
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <button type="submit" className={btnPrimary} disabled={busy}>
        {busy ? "Working…" : local ? "Dev sign in" : "Send code"}
      </button>
    </form>
  );
}
