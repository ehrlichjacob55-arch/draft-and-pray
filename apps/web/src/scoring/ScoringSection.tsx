import { useEffect, useMemo, useState } from "react";
import { useBlocker } from "react-router";
import type {
  ActiveScoring,
  RuleError,
  ScoringResponse,
  ScoringVersionSummary,
} from "@dnp/contract";
import { ApiError, useApi } from "../api";
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
import { useQuery } from "../useQuery";
import { Badge, ConfirmDialog } from "./fields";
import {
  draftFromJson,
  draftOf,
  previewRows,
  sameDraft,
  toJsonText,
  validateDraft,
  type Draft,
} from "./model";
import { Preview } from "./Preview";
import { RulesetEditor } from "./RulesetEditor";

/** "Scoring" section of the Commissioner page (docs/design/06 §7, 04 §2 lifecycle). */
export function ScoringSection({ seasonId }: { seasonId: string }) {
  const api = useApi();
  const query = useQuery(`scoring:${seasonId}`, () => api.scoring(seasonId));
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <Card data-testid="scoring-section">
      <h3 className="font-semibold">Scoring</h3>
      <div className="mt-2 space-y-4">
        {notice && (
          <p role="status" className="rounded border border-ok px-3 py-2 text-sm text-ok">
            {notice}
          </p>
        )}
        {query.status === "loading" && <Loading />}
        {query.status === "error" && (
          <ErrorWithRetry message={friendlyError(query.error)} onRetry={query.reload} />
        )}
        {query.status === "ready" &&
          (query.data.active ? (
            <ScoringEditor
              // A saved/activated/locked version is a new baseline: start the form over from it.
              key={`${query.data.active.version}:${query.data.active.locked}:${JSON.stringify([query.data.active.rounding, query.data.active.rules])}`}
              seasonId={seasonId}
              data={query.data}
              active={query.data.active}
              onChanged={(message) => {
                setNotice(message);
                query.reload();
              }}
            />
          ) : (
            <SeedPrompt
              seasonId={seasonId}
              onChanged={(message) => {
                setNotice(message);
                query.reload();
              }}
            />
          ))}
      </div>
    </Card>
  );
}

function SeedPrompt({
  seasonId,
  onChanged,
}: {
  seasonId: string;
  onChanged: (message: string) => void;
}) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function seed(name: "league" | "placeholder") {
    setBusy(true);
    setError(null);
    try {
      await api.seedScoring(seasonId, name);
      onChanged(
        name === "league" ? "Loaded the league’s scoring rules." : "Loaded the placeholder rules.",
      );
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3" data-testid="scoring-seed">
      <p className="text-sm">
        No scoring rules are set for this season yet. Load the league’s rules to start from what the
        league sent you, then adjust anything that needs changing and lock them before the draft.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={btnPrimary}
          disabled={busy}
          onClick={() => void seed("league")}
        >
          Load league rules
        </button>
        <button
          type="button"
          className="text-sm text-muted underline disabled:opacity-50"
          disabled={busy}
          onClick={() => void seed("placeholder")}
        >
          Load placeholder rules
        </button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}

function serverIssues(errors: RuleError[]) {
  const general: string[] = [];
  const byRule = new Map<number, string[]>();
  for (const e of errors) {
    if (e.ruleIndex === null) general.push(e.message);
    else byRule.set(e.ruleIndex, [...(byRule.get(e.ruleIndex) ?? []), e.message]);
  }
  return { general, byRule };
}

type Confirm = { kind: "lock" } | { kind: "activate"; version: number } | null;

function ScoringEditor({
  seasonId,
  data,
  active,
  onChanged,
}: {
  seasonId: string;
  data: ScoringResponse;
  active: ActiveScoring;
  onChanged: (message: string) => void;
}) {
  const api = useApi();
  const base = useMemo(() => draftOf(active), [active]);
  const [draft, setDraft] = useState<Draft>(base);
  const [jsonText, setJsonText] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<RuleError[]>([]);
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = !sameDraft(draft, base);
  const validation = useMemo(() => validateDraft(draft), [draft]);
  const saved = useMemo(() => validateDraft(base), [base]);
  const rows = useMemo(
    () => previewRows(saved.ruleset, validation.ruleset),
    [saved.ruleset, validation.ruleset],
  );
  const shown = validation.issues.length > 0 ? validation : serverIssues(serverErrors);
  const nextVersion = Math.max(...data.versions.map((v) => v.version)) + 1;

  function update(next: Draft) {
    setDraft(next);
    setJsonText(null);
    setJsonError(null);
    setServerErrors([]);
    setError(null);
  }
  function discard() {
    update(base);
    setNote("");
  }

  // Leaving with unsaved edits: block in-app navigation and warn on reload/close.
  const blocker = useBlocker(dirty);
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty]);

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setError(null);
    try {
      const message = await action();
      setConfirm(null);
      onChanged(message);
    } catch (err) {
      if (err instanceof ApiError && err.ruleErrors.length > 0) setServerErrors(err.ruleErrors);
      setConfirm(null);
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  const body = { rules: draft.rules, rounding: draft.rounding };
  const save = () =>
    run(async () => {
      if (!active.locked) {
        await api.updateScoringVersion(seasonId, active.version, body);
        return `Saved changes to version ${active.version}.`;
      }
      const trimmed = note.trim();
      await api.createScoringVersion(seasonId, {
        ...body,
        ...(trimmed ? { note: trimmed } : {}),
        activate: true,
      });
      return `Saved as version ${nextVersion} and made it active.`;
    });

  const canSave = dirty && validation.ruleset !== null && !busy;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Version {active.version}</span>
        <Badge tone="accent">Active</Badge>
        {active.locked ? <Badge tone="ok">Locked</Badge> : <Badge tone="muted">Not locked</Badge>}
        {dirty && (
          <span role="status" data-testid="unsaved" className="text-sm font-medium text-accent">
            Unsaved changes
          </span>
        )}
      </div>
      {active.name && <p className="-mt-3 text-xs text-muted">{active.name}</p>}
      {active.locked ? (
        <p className="text-sm text-muted">
          These rules are locked. Changes are saved as a new version (v{nextVersion}) that becomes
          the active one.
        </p>
      ) : (
        <p className="text-sm text-muted">
          Edit the rules below. Nothing changes for the league until you save.
        </p>
      )}

      <RulesetEditor
        draft={draft}
        byRule={shown.byRule}
        general={shown.general}
        onChange={update}
      />

      <details className="rounded border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">Advanced: edit JSON</summary>
        <div className="mt-2 space-y-2">
          <p className="text-xs text-muted">
            The same rules as data. Changes here update the form when you click out of the box.
          </p>
          <textarea
            aria-label="Rules as JSON"
            spellCheck={false}
            rows={12}
            className={`${inputCls} font-mono text-sm`}
            value={jsonText ?? toJsonText(draft)}
            onChange={(e) => {
              setJsonText(e.target.value);
              setJsonError(null);
            }}
            onBlur={() => {
              if (jsonText === null) return;
              const r = draftFromJson(jsonText);
              if ("error" in r) return setJsonError(r.error);
              update(r.draft);
            }}
          />
          {jsonError && <ErrorNote>{jsonError}</ErrorNote>}
        </div>
      </details>

      <Preview rows={rows} editedValid={validation.ruleset !== null} />

      <div className="space-y-3 border-t border-border pt-4">
        {active.locked && (
          <label className="block text-sm">
            Note for the new version (optional)
            <input
              className={`${inputCls} mt-1`}
              value={note}
              maxLength={200}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={btnPrimary}
            disabled={!canSave}
            onClick={() => void save()}
          >
            {active.locked ? "Save as new version" : "Save changes"}
          </button>
          <button
            type="button"
            className={btnSecondary}
            disabled={!dirty || busy}
            onClick={discard}
          >
            Discard
          </button>
        </div>
      </div>

      {!active.locked && (
        <div className="space-y-2 border-t border-border pt-4">
          <h4 className="font-medium">Lock rules</h4>
          <p className="text-sm text-muted">
            Lock the rules before the draft so nobody can change them quietly. A locked version
            never changes; later changes become a new version.
          </p>
          <button
            type="button"
            className={btnSecondary}
            disabled={dirty || busy}
            onClick={() => setConfirm({ kind: "lock" })}
          >
            Lock rules
          </button>
          {dirty && <p className="text-xs text-muted">Save or discard your changes first.</p>}
        </div>
      )}

      <VersionHistory
        versions={data.versions}
        disabled={dirty || busy}
        onActivate={(version) => setConfirm({ kind: "activate", version })}
      />

      {confirm?.kind === "lock" && (
        <ConfirmDialog
          title={`Lock version ${active.version}?`}
          confirmLabel="Lock rules"
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() =>
            void run(async () => {
              await api.lockScoringVersion(seasonId, active.version);
              return `Locked version ${active.version}.`;
            })
          }
        >
          <p>
            Locked rules can no longer be edited. To change them later you save a new version, which
            becomes the active one and recalculates scores for rounds that are not finalized.
          </p>
        </ConfirmDialog>
      )}
      {confirm?.kind === "activate" && (
        <ConfirmDialog
          title={`Make version ${confirm.version} active?`}
          confirmLabel="Make active"
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() =>
            void run(async () => {
              await api.activateScoringVersion(seasonId, confirm.version);
              return `Version ${confirm.version} is now active.`;
            })
          }
        >
          <p>
            The league will be scored with version {confirm.version}. Scores for rounds that are not
            finalized will be recalculated.
          </p>
        </ConfirmDialog>
      )}
      {blocker.state === "blocked" && (
        <ConfirmDialog
          title="Leave without saving?"
          confirmLabel="Leave"
          danger
          onCancel={() => blocker.reset()}
          onConfirm={() => blocker.proceed()}
        >
          <p>You have unsaved scoring changes. If you leave now they will be lost.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

const dateText = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

function VersionHistory({
  versions,
  disabled,
  onActivate,
}: {
  versions: ScoringVersionSummary[];
  disabled: boolean;
  onActivate: (version: number) => void;
}) {
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  return (
    <div className="space-y-2 border-t border-border pt-4">
      <h4 className="font-medium">Version history</h4>
      <ul aria-label="Version history" className="space-y-2">
        {sorted.map((v) => (
          <li
            key={v.version}
            data-testid={`version-${v.version}`}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-border px-3 py-2 text-sm"
          >
            <span className="font-medium">v{v.version}</span>
            <span className="text-muted">{dateText(v.createdAt)}</span>
            {v.by === "commissioner" && <span className="text-muted">by commissioner</span>}
            {v.active && <Badge tone="accent">Active</Badge>}
            {v.locked && <Badge tone="ok">Locked</Badge>}
            {v.note && (
              <span className="min-w-0 basis-full text-muted sm:basis-auto">{v.note}</span>
            )}
            {!v.active && (
              <button
                type="button"
                className={`${btnSecondary} ml-auto`}
                disabled={disabled}
                aria-label={`Make version ${v.version} active`}
                onClick={() => onActivate(v.version)}
              >
                Make active
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
