import {
  MAX_TEAMS,
  normalizeEmail,
  type ManagerStatus,
  type ManagerView,
  type ManagerWithDelivery,
} from "@dnp/contract";
import { useId, useState, type FormEvent } from "react";
import { useApi } from "../api";
import { DraftSetupSection } from "../draft/admin/DraftSetupSection";
import { TeamNameForm } from "../components/TeamNameForm";
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

const CHIP: Record<ManagerStatus, string> = {
  invited: "border-accent text-accent",
  joined: "border-ok text-ok",
  expired: "border-error text-error",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The commissioner-facing result of an add/resend (names and emails are fine on this screen). */
export function deliveryNote(m: Pick<ManagerWithDelivery, "firstName" | "email" | "emailSent">) {
  return m.emailSent
    ? `Invitation email sent to ${m.email}.`
    : `${m.firstName} already has an account — they'll be added at their next sign-in.`;
}

export function Commissioner() {
  const league = useLeague();
  if (league.status === "loading") return <Loading />;
  if (league.status === "error")
    return <ErrorWithRetry message={friendlyError(league.error)} onRetry={league.reload} />;
  if (!league.isCommissioner || !league.season) {
    return (
      <section className="space-y-2">
        <h2 className="text-xl font-semibold">Commissioner</h2>
        <p role="alert" className="text-muted">
          Only the commissioner can see this page.
        </p>
      </section>
    );
  }
  return <CommissionerConsole seasonId={league.season.seasonId} />;
}

function CommissionerConsole({ seasonId }: { seasonId: string }) {
  const api = useApi();
  const season = useQuery(`season:${seasonId}`, () => api.season(seasonId));
  const managers = useQuery(`managers:${seasonId}`, () => api.listManagers(seasonId));
  const [notice, setNotice] = useState<string | null>(null);
  const count = managers.status === "ready" ? managers.data.length : null;

  function reloadAll() {
    managers.reload();
    season.reload();
  }

  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold">Commissioner</h2>
      <Card>
        <h3 className="font-semibold">
          Managers{" "}
          <span className="font-normal text-muted" data-testid="manager-count">
            {count ?? "…"}/{MAX_TEAMS}
          </span>
        </h3>
        <p className="mt-1 text-sm text-muted">
          Each manager gets one email with a link. Their team is created now as “Team &lt;Last
          name&gt;” and they can rename it.
        </p>
        <AddManagerForm
          disabled={count !== null && count >= MAX_TEAMS}
          onAdd={async (body) => {
            const added = await api.addManager(seasonId, body);
            setNotice(deliveryNote(added));
            reloadAll();
          }}
          onBulkDone={(msg) => {
            setNotice(msg);
            reloadAll();
          }}
        />
        {notice && (
          <p role="status" className="mt-3 rounded border border-ok px-3 py-2 text-sm text-ok">
            {notice}
          </p>
        )}
        <div className="mt-4">
          {managers.status === "loading" && <Loading />}
          {managers.status === "error" && (
            <ErrorWithRetry message={friendlyError(managers.error)} onRetry={managers.reload} />
          )}
          {managers.status === "ready" && (
            <ManagerList
              managers={managers.data}
              onResend={async (m) => {
                const res = await api.resendManager(seasonId, m.teamId);
                setNotice(deliveryNote(res));
                managers.reload();
              }}
              onEdit={async (m, body) => {
                const res = await api.updateManager(seasonId, m.teamId, body);
                setNotice(
                  res.emailSent ? deliveryNote(res) : `Updated ${res.firstName} ${res.lastName}.`,
                );
                reloadAll();
              }}
              onRemove={async (m) => {
                await api.removeManager(seasonId, m.teamId);
                setNotice(`Removed ${m.firstName} ${m.lastName}.`);
                reloadAll();
              }}
            />
          )}
        </div>
      </Card>

      <DraftSetupSection seasonId={seasonId} />

      <Card>
        <h3 className="font-semibold">Team names</h3>
        {season.status === "loading" && <Loading />}
        {season.status === "error" && (
          <ErrorWithRetry message={friendlyError(season.error)} onRetry={season.reload} />
        )}
        {season.status === "ready" && (
          <TeamsTable
            teams={season.data.teams}
            onRename={async (teamId, name) => {
              await api.renameTeam(seasonId, teamId, name);
              reloadAll();
            }}
          />
        )}
      </Card>
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  autoComplete = "off",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoComplete?: string;
}) {
  const id = useId();
  return (
    <div className="min-w-0 flex-1 basis-40">
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        type={type}
        className={inputCls}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
      />
    </div>
  );
}

function validate(first: string, last: string, email: string): string | null {
  if (!first.trim() || !last.trim()) return "Enter a first and last name.";
  if (!EMAIL_RE.test(normalizeEmail(email))) return "Enter a valid email.";
  return null;
}

/** Parses `First,Last,email` lines; returns rows or an error naming the bad line. */
export function parseBulk(
  text: string,
): { rows: { firstName: string; lastName: string; email: string }[] } | { error: string } {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return { error: "Paste one manager per line: First,Last,email." };
  if (lines.length > MAX_TEAMS) return { error: `At most ${MAX_TEAMS} lines.` };
  const rows = [];
  for (const [i, line] of lines.entries()) {
    const parts = line.split(",").map((p) => p.trim());
    const [firstName, lastName, email] = parts;
    if (parts.length !== 3 || !firstName || !lastName || !email || !EMAIL_RE.test(email))
      return { error: `Line ${i + 1} should look like: First,Last,email.` };
    rows.push({ firstName, lastName, email: normalizeEmail(email) });
  }
  return { rows };
}

function AddManagerForm({
  disabled,
  onAdd,
  onBulkDone,
}: {
  disabled: boolean;
  onAdd: (body: { firstName: string; lastName: string; email: string }) => Promise<void>;
  onBulkDone: (message: string) => void;
}) {
  const api = useApi();
  const league = useLeague();
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bulk, setBulk] = useState(false);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<ReturnType<typeof parseBulk> | null>(null);
  const bulkId = useId();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = validate(first, last, email);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await onAdd({ firstName: first.trim(), lastName: last.trim(), email: normalizeEmail(email) });
      setFirst("");
      setLast("");
      setEmail("");
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function addAll(rows: { firstName: string; lastName: string; email: string }[]) {
    const seasonId = league.season?.seasonId;
    if (!seasonId) return;
    setBusy(true);
    setError(null);
    let added = 0;
    try {
      for (const row of rows) {
        await api.addManager(seasonId, row);
        added++;
      }
      setText("");
      setPreview(null);
      setBulk(false);
    } catch (err) {
      setError(`Added ${added} of ${rows.length}, then stopped: ${friendlyError(err)}`);
    } finally {
      setBusy(false);
      if (added > 0) onBulkDone(`Added ${added} manager${added === 1 ? "" : "s"}.`);
    }
  }

  return (
    <div className="mt-3 space-y-3">
      <form onSubmit={submit} className="space-y-2" aria-label="Add manager">
        <div className="flex flex-wrap gap-2">
          <Field label="First name" value={first} onChange={setFirst} />
          <Field label="Last name" value={last} onChange={setLast} />
          <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="off" />
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={btnPrimary} disabled={busy || disabled}>
            {busy ? "Adding…" : "Add manager"}
          </button>
          <button type="button" className={btnSecondary} onClick={() => setBulk((b) => !b)}>
            {bulk ? "Hide bulk add" : "Bulk add"}
          </button>
        </div>
        {disabled && <p className="text-sm text-muted">All {MAX_TEAMS} teams are taken.</p>}
        {error && <ErrorNote>{error}</ErrorNote>}
      </form>
      {bulk && (
        <div className="space-y-2">
          <label htmlFor={bulkId} className="block text-sm font-medium">
            Paste up to {MAX_TEAMS} lines of First,Last,email
          </label>
          <textarea
            id={bulkId}
            className={`${inputCls} font-mono`}
            rows={4}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setPreview(null);
            }}
          />
          <button
            type="button"
            className={btnSecondary}
            onClick={() => setPreview(parseBulk(text))}
            disabled={busy}
          >
            Preview
          </button>
          {preview && "error" in preview && <ErrorNote>{preview.error}</ErrorNote>}
          {preview && "rows" in preview && (
            <div className="space-y-2">
              <ul aria-label="Bulk preview" className="divide-y divide-border text-sm">
                {preview.rows.map((r) => (
                  <li key={r.email} className="py-1">
                    {r.firstName} {r.lastName} · {r.email}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className={btnPrimary}
                disabled={busy}
                onClick={() => void addAll(preview.rows)}
              >
                {busy ? "Adding…" : `Add ${preview.rows.length}`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ManagerList({
  managers,
  onResend,
  onEdit,
  onRemove,
}: {
  managers: ManagerView[];
  onResend: (m: ManagerView) => Promise<void>;
  onEdit: (
    m: ManagerView,
    body: { firstName: string; lastName: string; email: string },
  ) => Promise<void>;
  onRemove: (m: ManagerView) => Promise<void>;
}) {
  if (managers.length === 0)
    return <p className="text-muted">No managers yet. Add the first one above.</p>;
  return (
    <ul aria-label="Managers" className="divide-y divide-border">
      {managers.map((m) => (
        <ManagerRow
          key={m.teamId}
          manager={m}
          onResend={onResend}
          onEdit={onEdit}
          onRemove={onRemove}
        />
      ))}
    </ul>
  );
}

function ManagerRow({
  manager: m,
  onResend,
  onEdit,
  onRemove,
}: {
  manager: ManagerView;
  onResend: (m: ManagerView) => Promise<void>;
  onEdit: (
    m: ManagerView,
    body: { firstName: string; lastName: string; email: string },
  ) => Promise<void>;
  onRemove: (m: ManagerView) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [first, setFirst] = useState(m.firstName);
  const [last, setLast] = useState(m.lastName);
  const [email, setEmail] = useState(m.email);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const full = `${m.firstName} ${m.lastName}`;

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(friendlyError(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const problem = validate(first, last, email);
    if (problem) return setError(problem);
    const ok = await act(() =>
      onEdit(m, { firstName: first.trim(), lastName: last.trim(), email: normalizeEmail(email) }),
    );
    if (ok) setEditing(false);
  }

  function remove() {
    if (!window.confirm(`Remove ${full} and their team “${m.teamName}”? This cannot be undone.`))
      return;
    void act(() => onRemove(m));
  }

  return (
    <li className="space-y-2 py-3">
      {editing ? (
        <form onSubmit={save} className="space-y-2" aria-label={`Edit ${full}`}>
          <div className="flex flex-wrap gap-2">
            <Field label="First name" value={first} onChange={setFirst} />
            <Field label="Last name" value={last} onChange={setLast} />
            <Field label="Email" type="email" value={email} onChange={setEmail} />
          </div>
          <div className="flex gap-2">
            <button type="submit" className={btnPrimary} disabled={busy}>
              Save
            </button>
            <button
              type="button"
              className={btnSecondary}
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="font-medium">{m.teamName}</div>
            <div className="text-sm">{full}</div>
            <div className="break-all text-sm text-muted">{m.email}</div>
            <span
              className={`mt-1 inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${CHIP[m.status]}`}
              data-testid="manager-status"
            >
              {m.status}
            </span>
          </div>
          {m.status !== "joined" && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={btnSecondary}
                aria-label={`Resend to ${full}`}
                disabled={busy}
                onClick={() => void act(() => onResend(m))}
              >
                Resend
              </button>
              <button
                type="button"
                className={btnSecondary}
                aria-label={`Edit ${full}`}
                disabled={busy}
                onClick={() => setEditing(true)}
              >
                Edit
              </button>
              <button
                type="button"
                className={btnSecondary}
                aria-label={`Remove ${full}`}
                disabled={busy}
                onClick={remove}
              >
                Remove
              </button>
            </div>
          )}
        </div>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </li>
  );
}

function TeamsTable({
  teams,
  onRename,
}: {
  teams: { teamId: string; name: string }[];
  onRename: (teamId: string, name: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  if (teams.length === 0) return <p className="mt-1 text-muted">No teams yet.</p>;
  return (
    <ul aria-label="Teams" className="mt-2 divide-y divide-border">
      {teams.map((t) => (
        <li key={t.teamId} className="py-2">
          {editing === t.teamId ? (
            <TeamNameForm
              initial={t.name}
              label={`New name for ${t.name}`}
              submitLabel="Save"
              onCancel={() => setEditing(null)}
              onSubmit={async (name) => {
                await onRename(t.teamId, name);
                setEditing(null);
              }}
            />
          ) : (
            <div className="flex items-center justify-between gap-2">
              <span>{t.name}</span>
              <button
                type="button"
                className={btnSecondary}
                aria-label={`Rename ${t.name}`}
                onClick={() => setEditing(t.teamId)}
              >
                Rename
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
