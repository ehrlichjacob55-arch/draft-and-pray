import { normalizeEmail } from "@dnp/contract";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { authErrorMessage, useAuth } from "../auth";
import { btnPrimary, btnSecondary, Card, ErrorNote, inputCls, Loading } from "../components/ui";

/**
 * Parses `#u=<cognito-username>&c=<temporary-code>` (docs/design/13 §1.3). `u` is whatever sits between
 * `u=` and `&c=`; `c` is everything after `&c=` (the code may itself contain odd characters, so it is
 * not split on `&` or decoded). Returns null when either part is missing.
 */
export function parseWelcomeFragment(hash: string): { u: string; c: string } | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw.startsWith("u=")) return null;
  const at = raw.indexOf("&c=");
  if (at < 0) return null;
  const u = raw.slice(2, at).trim();
  const c = raw.slice(at + 3).trim();
  return u && c ? { u, c } : null;
}

const EXPIRED_TEXT =
  "This link has expired or was already used. Ask your commissioner to resend it.";

/** Cognito error names that mean "the code is no longer good". */
const EXPIRED_ERRORS = new Set([
  "NotAuthorizedException",
  "ExpiredCodeException",
  "UserNotFoundException",
  "CodeMismatchException",
]);

type View = "working" | "expired" | "failed" | "form";

export function Welcome() {
  const auth = useAuth();
  const navigate = useNavigate();
  const local = auth.mode === "local";
  // Read once; the fragment is stripped from the address bar in the effect below (never put in state
  // beyond this component, never logged).
  const [fragment] = useState(() => parseWelcomeFragment(window.location.hash));
  const [view, setView] = useState<View>(local || !fragment ? "form" : "working");
  const [message, setMessage] = useState<string | null>(null);
  const started = useRef(false);
  const { welcomeSignIn } = auth;

  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname + window.location.search,
      );
    }
  }, []);

  const run = useCallback(
    async (u: string, c: string): Promise<void> => {
      setView("working");
      setMessage(null);
      try {
        await welcomeSignIn(u, c);
        void navigate("/", { replace: true });
      } catch (err) {
        if (err instanceof Error && EXPIRED_ERRORS.has(err.name)) {
          setView("expired");
        } else {
          setView("failed");
          setMessage(authErrorMessage(err));
        }
      }
    },
    [welcomeSignIn, navigate],
  );

  useEffect(() => {
    if (local || !fragment || started.current || auth.status === "loading") return;
    started.current = true;
    void run(fragment.u, fragment.c);
  }, [local, fragment, auth.status, run]);

  if (view === "working") return <Loading label="Setting up your account…" />;

  return (
    <section className="mx-auto max-w-sm space-y-4">
      <h2 className="text-xl font-semibold">Welcome to Draft &amp; Pray</h2>
      {view === "expired" && (
        <div className="space-y-3">
          <ErrorNote>{EXPIRED_TEXT}</ErrorNote>
          <Link to="/signin" className={btnSecondary}>
            Sign in with email code
          </Link>
        </div>
      )}
      {view === "failed" && message && <ErrorNote>{message}</ErrorNote>}
      {local ? (
        <SimulateInvite
          onSubmit={(email) => {
            auth.devSignIn(email);
            void navigate("/", { replace: true });
          }}
        />
      ) : (
        <>
          {view === "form" && (
            <p className="text-sm text-muted">
              Open the link in your invitation email, or enter your email and the code from it.
            </p>
          )}
          <CodeForm onSubmit={(email, code) => void run(email, code)} />
        </>
      )}
    </section>
  );
}

function SimulateInvite({ onSubmit }: { onSubmit: (email: string) => void }) {
  const id = useId();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  function submit(e: FormEvent) {
    e.preventDefault();
    const normalized = normalizeEmail(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return setError("Enter a valid email.");
    onSubmit(normalized);
  }
  return (
    <Card>
      <form onSubmit={submit} className="space-y-3">
        <h3 className="font-semibold">Simulate invite link (local only)</h3>
        <p className="text-sm text-muted">
          Local mode has no Cognito. Enter the email the commissioner added to sign in as that
          person; their team is assigned on arrival.
        </p>
        <div>
          <label htmlFor={id} className="mb-1 block text-sm font-medium">
            Email
          </label>
          <input
            id={id}
            type="email"
            className={inputCls}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
        <button type="submit" className={btnPrimary}>
          Simulate invite link
        </button>
      </form>
    </Card>
  );
}

function CodeForm({ onSubmit }: { onSubmit: (email: string, code: string) => void }) {
  const emailId = useId();
  const codeId = useId();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  function submit(e: FormEvent) {
    e.preventDefault();
    const normalized = normalizeEmail(email);
    if (!normalized || !code.trim())
      return setError("Enter your email and the code from the email.");
    onSubmit(normalized, code.trim());
  }
  return (
    <Card>
      <form onSubmit={submit} className="space-y-3">
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
        <div>
          <label htmlFor={codeId} className="mb-1 block text-sm font-medium">
            Code from the email
          </label>
          <input
            id={codeId}
            className={inputCls}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
        <button type="submit" className={btnPrimary}>
          Continue
        </button>
      </form>
    </Card>
  );
}
