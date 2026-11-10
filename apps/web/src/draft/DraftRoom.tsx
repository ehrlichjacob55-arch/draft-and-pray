import type { AvailablePlayer, DraftSnapshot } from "@dnp/contract";
import type { Slot } from "@dnp/domain";
import { useState } from "react";
import { ApiError, useApi } from "../api";
import { Card, ErrorNote, ErrorWithRetry, Loading } from "../components/ui";
import { friendlyError } from "../lib/messages";
import { useLeague } from "../league/LeagueProvider";
import { DraftSetup } from "./admin/DraftSetup";
import { LiveControls } from "./admin/LiveControls";
import { Banner } from "./Banner";
import { BoardPanel } from "./BoardPanel";
import { ConfirmSheet } from "./ConfirmSheet";
import { Lobby } from "./Lobby";
import { deriveView, eligibilityFor, isLive, isPreDraft, teamName } from "./model";
import { PlayersPanel } from "./PlayersPanel";
import { QueuePanel } from "./QueuePanel";
import { RosterPanel } from "./RosterPanel";
import { useAction } from "./useAction";
import { useDraft, type DraftData } from "./useDraft";

type Tab = "players" | "queue" | "roster" | "board";
const TABS: { id: Tab; label: string }[] = [
  { id: "players", label: "Players" },
  { id: "queue", label: "Queue" },
  { id: "roster", label: "Roster" },
  { id: "board", label: "Board" },
];

export function DraftRoom() {
  const league = useLeague();
  if (league.status === "loading") return <Loading />;
  if (league.status === "error")
    return <ErrorWithRetry message={friendlyError(league.error)} onRetry={league.reload} />;
  if (!league.season) {
    return (
      <section className="space-y-2">
        <h2 className="text-xl font-semibold">Draft room</h2>
        <p className="text-muted">You are not in a league yet.</p>
      </section>
    );
  }
  return <DraftRoomLoaded key={league.season.seasonId} seasonId={league.season.seasonId} />;
}

function DraftRoomLoaded({ seasonId }: { seasonId: string }) {
  const draft = useDraft(seasonId);
  if (draft.status === "loading") return <Loading label="Loading the draft room…" />;
  if (draft.status === "error" || !draft.snapshot)
    return (
      <ErrorWithRetry message={friendlyError(draft.error)} onRetry={() => void draft.refetch()} />
    );
  return <DraftRoomView seasonId={seasonId} snapshot={draft.snapshot} draft={draft} />;
}

interface Pending {
  player: AvailablePlayer;
  slot: Slot;
  forTeamId: string | null;
}

function DraftRoomView({
  seasonId,
  snapshot,
  draft,
}: {
  seasonId: string;
  snapshot: DraftSnapshot;
  draft: DraftData;
}) {
  const api = useApi();
  const { connection, clockRemaining, clockExpired, refetch } = draft;
  const view = deriveView(snapshot);
  const isCommissioner = snapshot.myRole === "commissioner";
  const [tab, setTab] = useState<Tab>("players");
  const [commishPick, setCommishPick] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [queueOverride, setQueueOverride] = useState<{ version: number; ids: string[] } | null>(
    null,
  );
  const queueAction = useAction();
  const autoAction = useAction();

  const live = isLive(snapshot);
  const complete = snapshot.status === "complete";
  const commishMode = isCommissioner && commishPick && snapshot.status === "in_progress";
  const pickingTeamId = commishMode ? snapshot.onClockTeamId : snapshot.myTeamId;
  const eligibility = eligibilityFor(snapshot, pickingTeamId);
  const canPick = snapshot.status === "in_progress" && (view.isMyTurn || commishMode);
  const blockedReason =
    snapshot.status === "paused"
      ? "The draft is paused"
      : !canPick
        ? "It is not your turn"
        : undefined;

  const queueIds =
    queueOverride && queueOverride.version === snapshot.version
      ? queueOverride.ids
      : snapshot.myQueue;
  const byId = new Map(snapshot.available.map((p) => [p.playerId, p]));
  const queue = queueIds.flatMap((id) => {
    const p = byId.get(id);
    return p ? [p] : [];
  });

  async function saveQueue(ids: string[]) {
    setQueueOverride({ version: snapshot.version, ids });
    const res = await queueAction.run(() => api.saveQueue(seasonId, ids));
    if (!res) setQueueOverride(null);
    await refetch();
  }

  async function confirmPick() {
    if (!pending) return;
    setPicking(true);
    setPickError(null);
    try {
      await api.makePick(seasonId, {
        playerId: pending.player.playerId,
        expectedPick: snapshot.currentPick,
        ...(commishMode && pending.forTeamId ? { teamId: pending.forTeamId } : {}),
      });
      setPending(null);
      await refetch();
    } catch (e) {
      setPickError(friendlyError(e));
      if (
        e instanceof ApiError &&
        ["stale_pick", "player_taken", "not_your_turn"].includes(e.code)
      ) {
        await refetch();
        if (e.code === "stale_pick") setPending(null);
      }
    } finally {
      setPicking(false);
    }
  }

  const stalePickNotice = pickError && !pending;
  const showCommissioner = isCommissioner;

  return (
    <section className="space-y-3" aria-label="Draft room">
      <h2 className="text-xl font-semibold">Draft room</h2>

      {isPreDraft(snapshot) ? (
        <Lobby snapshot={snapshot} />
      ) : complete ? (
        <Card data-testid="draft-complete">
          <h3 className="text-lg font-semibold">Draft complete</h3>
          <p className="text-sm text-muted">
            All {snapshot.totalPicks} picks are in. Final rosters and the board are below.
          </p>
        </Card>
      ) : (
        <Banner
          snapshot={snapshot}
          connection={connection}
          clockRemaining={clockRemaining}
          clockExpired={clockExpired}
        />
      )}

      {stalePickNotice && <ErrorNote>{pickError}</ErrorNote>}

      {showCommissioner && (
        <details
          className="rounded border border-border bg-surface p-3"
          open={isPreDraft(snapshot)}
        >
          <summary className="cursor-pointer font-semibold">Commissioner controls</summary>
          <div className="mt-3">
            {isPreDraft(snapshot) ? (
              <DraftSetup
                seasonId={seasonId}
                snapshot={snapshot}
                onChanged={() => void refetch()}
              />
            ) : (
              <LiveControls
                seasonId={seasonId}
                snapshot={snapshot}
                commishPick={commishMode}
                onCommishPick={setCommishPick}
                onChanged={() => void refetch()}
              />
            )}
          </div>
        </details>
      )}

      {(live || complete) && (
        <>
          <div role="tablist" aria-label="Draft sections" className="flex gap-1 md:hidden">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`panel-${t.id}`}
                className={`min-h-10 flex-1 rounded px-2 text-sm ${tab === t.id ? "bg-accent text-accent-fg" : "border border-border"}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div
            className={`grid gap-3 ${complete ? "md:grid-cols-[minmax(0,1.6fr)_minmax(0,0.8fr)]" : "md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,0.8fr)]"}`}
          >
            {!complete && (
              <>
                <div
                  id="panel-players"
                  role="tabpanel"
                  aria-labelledby="tab-players"
                  className={`${tab === "players" ? "" : "hidden"} md:col-start-1 md:row-start-1 md:block`}
                >
                  <PlayersPanel
                    snapshot={snapshot}
                    eligibility={eligibility}
                    canPick={canPick}
                    blockedReason={blockedReason}
                    queueIds={queueIds}
                    canQueue={!!snapshot.myTeamId}
                    onToggleQueue={(id) =>
                      void saveQueue(
                        queueIds.includes(id)
                          ? queueIds.filter((x) => x !== id)
                          : [...queueIds, id],
                      )
                    }
                    onDraft={(player, slot) => {
                      setPickError(null);
                      setPending({ player, slot, forTeamId: pickingTeamId });
                    }}
                    title={commishMode ? `Players (picking for ${view.onClockName})` : "Players"}
                  />
                </div>
                {snapshot.myTeamId && (
                  <div
                    id="panel-queue"
                    role="tabpanel"
                    aria-labelledby="tab-queue"
                    className={`${tab === "queue" ? "" : "hidden"} md:col-start-1 md:row-start-2 md:block`}
                  >
                    <QueuePanel
                      queue={queue}
                      autoDraft={snapshot.myAutoDraft}
                      busy={autoAction.busy}
                      onMove={(id, delta) => {
                        const i = queueIds.indexOf(id);
                        const j = i + delta;
                        if (i < 0 || j < 0 || j >= queueIds.length) return;
                        const next = [...queueIds];
                        [next[i], next[j]] = [next[j]!, next[i]!];
                        void saveQueue(next);
                      }}
                      onRemove={(id) => void saveQueue(queueIds.filter((x) => x !== id))}
                      onToggleAuto={(enabled) =>
                        void autoAction
                          .run(() => api.setAutoDraft(seasonId, enabled))
                          .then(() => refetch())
                      }
                    />
                    {(queueAction.error || autoAction.error) && (
                      <div className="mt-2">
                        <ErrorNote>{queueAction.error ?? autoAction.error}</ErrorNote>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
            <div
              id="panel-board"
              role="tabpanel"
              aria-labelledby="tab-board"
              className={`${tab === "board" ? "" : "hidden"} md:row-span-2 md:row-start-1 md:block ${complete ? "md:col-start-1" : "md:col-start-2"}`}
            >
              <BoardPanel snapshot={snapshot} />
            </div>
            <div
              id="panel-roster"
              role="tabpanel"
              aria-labelledby="tab-roster"
              className={`${tab === "roster" ? "" : "hidden"} md:row-span-2 md:row-start-1 md:block ${complete ? "md:col-start-2" : "md:col-start-3"}`}
            >
              <RosterPanel snapshot={snapshot} />
            </div>
          </div>
        </>
      )}

      {pending && (
        <ConfirmSheet
          title="Confirm pick"
          message={
            commishMode && pending.forTeamId
              ? `Draft ${pending.player.name} → ${pending.slot} for ${teamName(snapshot, pending.forTeamId)}?`
              : `Draft ${pending.player.name} → ${pending.slot}?`
          }
          confirmLabel="Confirm pick"
          busy={picking}
          error={pickError}
          onConfirm={() => void confirmPick()}
          onCancel={() => {
            setPending(null);
            setPickError(null);
          }}
        />
      )}
    </section>
  );
}
