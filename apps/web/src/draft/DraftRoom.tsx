import type { AvailablePlayer, DraftSnapshot } from "@dnp/contract";
import { useState } from "react";
import { Link } from "react-router";
import { ApiError, useApi } from "../api";
import { Card, ErrorNote, ErrorWithRetry, Loading } from "../components/ui";
import { friendlyError } from "../lib/messages";
import { useLeague } from "../league/LeagueProvider";
import { DraftSetup } from "./admin/DraftSetup";
import { LiveControls } from "./admin/LiveControls";
import { Banner } from "./Banner";
import { BoardPanel } from "./BoardPanel";
import { Lobby } from "./Lobby";
import { deriveView, eligibilityFor, isLive, isPreDraft, isResetting } from "./model";
import { PlayerDetail } from "./PlayerDetail";
import { PlayersPanel } from "./PlayersPanel";
import { QueuePanel } from "./QueuePanel";
import { OnTheClockStrip } from "./OnTheClockStrip";
import { PicksPanel } from "./RightPane";
import { RosterPanel } from "./RosterPanel";
import { useTurnAlert } from "./turnAlert";
import { useRoomSounds } from "./useRoomSounds";
import { useMediaQuery } from "./useMediaQuery";
import { useAction } from "./useAction";
import { useDraft, type DraftData } from "./useDraft";

type Tab = "players" | "board" | "roster" | "queue" | "picks";
const TABS: { id: Tab; label: string }[] = [
  { id: "players", label: "Players" },
  { id: "board", label: "Board" },
  { id: "roster", label: "Roster" },
  { id: "queue", label: "Queue" },
  { id: "picks", label: "Picks" },
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
  const desktop = useMediaQuery("(min-width: 768px)", true);
  const complete = snapshot.status === "complete";
  const [tab, setTab] = useState<Tab>(complete ? "board" : "players");
  const [center, setCenter] = useState<"players" | "board">(complete ? "board" : "players");
  const [wasComplete, setWasComplete] = useState(complete);
  if (complete !== wasComplete) {
    // After completion the board is the default view.
    setWasComplete(complete);
    if (complete) {
      setCenter("board");
      setTab("board");
    }
  }
  const [rosterTeam, setRosterTeam] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [commishPick, setCommishPick] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [queueOverride, setQueueOverride] = useState<{ version: number; ids: string[] } | null>(
    null,
  );
  const queueAction = useAction();
  const autoAction = useAction();
  const { sound, setSound } = useTurnAlert(snapshot);
  useRoomSounds(snapshot, clockExpired, sound);

  const live = isLive(snapshot);
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
  const detailPlayer = detailId ? (byId.get(detailId) ?? null) : null;

  // Roster pane: mine by default; the commissioner (no team) starts on the on-clock team.
  const teamList = snapshot.order.length
    ? snapshot.order.map((o) => o.teamId)
    : snapshot.teams.map((t) => t.teamId);
  const viewingTeam =
    rosterTeam ?? snapshot.myTeamId ?? snapshot.onClockTeamId ?? teamList[0] ?? null;

  async function saveQueue(ids: string[]) {
    setQueueOverride({ version: snapshot.version, ids });
    const res = await queueAction.run(() => api.saveQueue(seasonId, ids));
    if (!res) setQueueOverride(null);
    await refetch();
  }

  const toggleQueue = (id: string) =>
    void saveQueue(queueIds.includes(id) ? queueIds.filter((x) => x !== id) : [...queueIds, id]);
  /** Submits the pick immediately (no confirmation); `picking` blocks a double click. */
  async function draftPlayer(player: AvailablePlayer) {
    if (picking) return;
    setPicking(true);
    setPickError(null);
    setDetailId(null);
    try {
      await api.makePick(seasonId, {
        playerId: player.playerId,
        expectedPick: snapshot.currentPick,
        ...(commishMode && pickingTeamId ? { teamId: pickingTeamId } : {}),
      });
      await refetch();
    } catch (e) {
      setPickError(friendlyError(e));
      if (e instanceof ApiError && ["stale_pick", "player_taken", "not_your_turn"].includes(e.code))
        await refetch();
    } finally {
      setPicking(false);
    }
  }

  const showPlayers = desktop ? center === "players" : tab === "players";
  const showBoard = desktop ? center === "board" : tab === "board";

  const playersPane = (
    // Stays mounted while hidden so filters and sorting survive switching to the board.
    <div hidden={!showPlayers}>
      <PlayersPanel
        snapshot={snapshot}
        eligibility={eligibility}
        canPick={canPick && !picking}
        blockedReason={blockedReason}
        queueIds={queueIds}
        canQueue={!!snapshot.myTeamId}
        compact={!desktop}
        onToggleQueue={toggleQueue}
        onDraft={(p) => void draftPlayer(p)}
        onOpenDetail={(p) => setDetailId(p.playerId)}
        title={commishMode ? `Players (picking for ${view.onClockName})` : "Players"}
      />
    </div>
  );
  const rosterPane = (
    <RosterPanel snapshot={snapshot} teamId={viewingTeam} onTeamChange={setRosterTeam} />
  );
  const queuePane = snapshot.myTeamId ? (
    <div>
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
          void autoAction.run(() => api.setAutoDraft(seasonId, enabled)).then(() => refetch())
        }
      />
      {(queueAction.error || autoAction.error) && (
        <div className="mt-2">
          <ErrorNote>{queueAction.error ?? autoAction.error}</ErrorNote>
        </div>
      )}
    </div>
  ) : (
    <Card>
      <p className="text-sm text-muted">Only teams have a queue.</p>
    </Card>
  );
  const picksPane = (
    <PicksPanel
      snapshot={snapshot}
      onSelectTeam={(teamId) => {
        setRosterTeam(teamId);
        if (!desktop) setTab("roster");
      }}
    />
  );

  return (
    <section className="space-y-3" aria-label="Draft room">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold">Draft room</h2>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={sound}
            onChange={(e) => setSound(e.target.checked)}
            aria-label="Sound"
          />
          {sound ? "Sound on" : "Sound off"}
        </label>
      </div>

      {isPreDraft(snapshot) ? (
        <Lobby snapshot={snapshot} />
      ) : complete ? (
        <Card data-testid="draft-complete">
          <h3 className="text-lg font-semibold">Draft complete</h3>
          <p className="text-sm text-muted">
            All {snapshot.totalPicks} picks are in. Final rosters and the board are below.
          </p>
          {isCommissioner && (
            <Link
              to="/commissioner"
              className="mt-2 inline-block text-sm text-accent underline"
              data-testid="draft-again"
            >
              Draft again
            </Link>
          )}
        </Card>
      ) : isResetting(snapshot) ? (
        <Card data-testid="draft-resetting">
          <h3 className="text-lg font-semibold">Resetting the draft</h3>
          <p className="text-sm text-muted" role="status">
            The commissioner is clearing the picks to run the draft again. This page updates when
            the draft is back in the lobby.
          </p>
          {isCommissioner && (
            <Link to="/commissioner" className="mt-2 inline-block text-sm text-accent underline">
              Commissioner tab (finish the reset)
            </Link>
          )}
        </Card>
      ) : (
        <Banner
          snapshot={snapshot}
          connection={connection}
          clockRemaining={clockRemaining}
          clockExpired={clockExpired}
        />
      )}

      {live && (
        <OnTheClockStrip
          snapshot={snapshot}
          clockRemaining={clockRemaining}
          clockExpired={clockExpired}
          selectedTeamId={viewingTeam}
          onSelectTeam={(teamId) => {
            setRosterTeam(teamId);
            if (!desktop) setTab("roster");
          }}
        />
      )}

      {pickError && <ErrorNote>{pickError}</ErrorNote>}

      {isCommissioner && !isResetting(snapshot) && (
        <details
          className="rounded border border-border bg-surface p-3"
          open={isPreDraft(snapshot)}
          data-testid="commissioner-bar"
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

      {(live || complete) &&
        (desktop ? (
          <div
            className="grid grid-cols-[200px_minmax(0,1fr)_240px] lg:grid-cols-[210px_minmax(0,1fr)_270px] items-start gap-3"
            data-testid="draft-columns"
          >
            <div data-testid="col-left">{rosterPane}</div>
            <div className="space-y-3" data-testid="col-center">
              <button
                type="button"
                className="flex min-h-11 w-full items-center justify-center gap-2 rounded border-2 border-accent bg-surface px-4 py-2 text-base font-semibold"
                aria-label="Players ⇄ Board"
                title="Switch between the player list and the draft board"
                aria-pressed={center === "board"}
                onClick={() => setCenter(center === "players" ? "board" : "players")}
              >
                <span className={center === "players" ? "text-accent underline" : "text-muted"}>
                  Players
                </span>
                <span aria-hidden="true">⇄</span>
                <span className={center === "board" ? "text-accent underline" : "text-muted"}>
                  Board
                </span>
              </button>
              {playersPane}
              {showBoard && <BoardPanel snapshot={snapshot} />}
            </div>
            <div className="space-y-3" data-testid="col-right">
              {!complete && queuePane}
              {picksPane}
            </div>
          </div>
        ) : (
          <>
            <div role="tablist" aria-label="Draft sections" className="flex gap-1">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`tab-${t.id}`}
                  aria-selected={tab === t.id}
                  aria-controls="draft-tabpanel"
                  className={`min-h-10 flex-1 rounded px-1 text-xs ${tab === t.id ? "bg-accent text-accent-fg" : "border border-border"}`}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div id="draft-tabpanel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
              {playersPane}
              {tab === "board" && <BoardPanel snapshot={snapshot} />}
              {tab === "roster" && rosterPane}
              {tab === "queue" && <div className="space-y-3">{queuePane}</div>}
              {tab === "picks" && picksPane}
            </div>
          </>
        ))}

      {detailPlayer && (
        <PlayerDetail
          player={detailPlayer}
          statsSeason={snapshot.statsSeason}
          inQueue={queueIds.includes(detailPlayer.playerId)}
          canQueue={!!snapshot.myTeamId}
          showDraft={!complete}
          canDraft={
            canPick &&
            !picking &&
            !!eligibility?.eligible(detailPlayer) &&
            eligibility.slotFor(detailPlayer) !== null
          }
          draftHint={blockedReason ?? "No open roster spot for this position"}
          onToggleQueue={() => toggleQueue(detailPlayer.playerId)}
          onDraft={() => void draftPlayer(detailPlayer)}
          onClose={() => setDetailId(null)}
        />
      )}
    </section>
  );
}
