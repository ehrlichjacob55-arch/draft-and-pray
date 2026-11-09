import { MAX_TEAMS, type InviteStatus, type InviteView } from "@dnp/contract";
import { useId, useState, type FormEvent } from "react";
import { useApi } from "../api";
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

const CHIP: Record<InviteStatus, string> = {
  open: "border-accent text-accent",
  pending: "border-border text-text",
  used: "border-ok text-ok",
  revoked: "border-error text-error",
  expired: "border-border text-muted",
};

export function inviteLink(token: string): string {
  return `${window.location.origin}/join/${token}`;
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
  const invites = useQuery(`invites:${seasonId}`, () => api.listInvites(seasonId));

  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold">Commissioner</h2>
      <Card>
        <h3 className="font-semibold">Invite links</h3>
        <CreateInvites
          onCreate={async (count) => {
            await api.createInvites(seasonId, count);
            invites.reload();
          }}
        />
        <div className="mt-4">
          {invites.status === "loading" && <Loading />}
          {invites.status === "error" && (
            <ErrorWithRetry message={friendlyError(invites.error)} onRetry={invites.reload} />
          )}
          {invites.status === "ready" && (
            <InviteTable
              invites={invites.data}
              onRevoke={async (token) => {
                await api.revokeInvite(seasonId, token);
                invites.reload();
              }}
            />
          )}
        </div>
      </Card>

      <Card>
        <h3 className="font-semibold">Teams</h3>
        {season.status === "loading" && <Loading />}
        {season.status === "error" && (
          <ErrorWithRetry message={friendlyError(season.error)} onRetry={season.reload} />
        )}
        {season.status === "ready" && (
          <TeamsTable
            teams={season.data.teams}
            onRename={async (teamId, name) => {
              await api.renameTeam(seasonId, teamId, name);
              season.reload();
            }}
          />
        )}
      </Card>
    </section>
  );
}

function CreateInvites({ onCreate }: { onCreate: (count: number) => Promise<void> }) {
  const id = useId();
  const [count, setCount] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > MAX_TEAMS)
      return setError(`Choose a number from 1 to ${MAX_TEAMS}.`);
    setBusy(true);
    setError(null);
    try {
      await onCreate(n);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-2 space-y-2">
      <div className="flex items-end gap-2">
        <div className="w-24">
          <label htmlFor={id} className="mb-1 block text-sm font-medium">
            How many
          </label>
          <input
            id={id}
            type="number"
            min={1}
            max={MAX_TEAMS}
            className={inputCls}
            value={count}
            onChange={(e) => setCount(e.target.value)}
          />
        </div>
        <button type="submit" className={btnPrimary} disabled={busy}>
          {busy ? "Creating…" : "Create invites"}
        </button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
    </form>
  );
}

function InviteRow({
  invite,
  onRevoke,
}: {
  invite: InviteView;
  onRevoke: (token: string) => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = invite.status === "open" || invite.status === "pending";

  async function copy() {
    const url = inviteLink(invite.token);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setLink(null);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setLink(url); // clipboard blocked: show the link so it can be copied by hand
    }
  }

  async function revoke() {
    if (!window.confirm("Revoke this invite? The link will stop working.")) return;
    setBusy(true);
    setError(null);
    try {
      await onRevoke(invite.token);
    } catch (err) {
      setError(friendlyError(err));
      setBusy(false);
    }
  }

  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <span
            className={`rounded-full border px-2 py-0.5 text-xs font-medium ${CHIP[invite.status]}`}
            data-testid="invite-status"
          >
            {invite.status}
          </span>
          <span className="ml-2 text-sm text-muted">
            {invite.usedByDisplayName ?? invite.pendingEmail ?? "…" + invite.token.slice(-6)}
          </span>
        </div>
        {active && (
          <div className="flex gap-2">
            <button type="button" className={btnSecondary} onClick={() => void copy()}>
              {copied ? "Copied!" : "Copy link"}
            </button>
            <button
              type="button"
              className={btnSecondary}
              onClick={() => void revoke()}
              disabled={busy}
            >
              Revoke
            </button>
          </div>
        )}
      </div>
      {link && (
        <p className="break-all rounded bg-bg p-2 text-sm" data-testid="manual-link">
          Copy this link: {link}
        </p>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </li>
  );
}

function InviteTable({
  invites,
  onRevoke,
}: {
  invites: InviteView[];
  onRevoke: (token: string) => Promise<void>;
}) {
  if (invites.length === 0) return <p className="text-muted">No invites yet. Create some above.</p>;
  return (
    <ul aria-label="Invites" className="divide-y divide-border">
      {invites.map((i) => (
        <InviteRow key={i.token} invite={i} onRevoke={onRevoke} />
      ))}
    </ul>
  );
}

function TeamsTable({
  teams,
  onRename,
}: {
  teams: { teamId: string; name: string; managerDisplayName: string | null }[];
  onRename: (teamId: string, name: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  if (teams.length === 0) return <p className="mt-1 text-muted">No teams have joined yet.</p>;
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
              <div>
                <div>{t.name}</div>
                <div className="text-sm text-muted">{t.managerDisplayName ?? "—"}</div>
              </div>
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
