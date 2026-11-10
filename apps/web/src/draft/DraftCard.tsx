import { Link } from "react-router";
import { useApi } from "../api";
import { btnPrimary, Card } from "../components/ui";
import { useQuery } from "../useQuery";
import { isPreDraft, teamName } from "./model";

/** League-home card linking to the draft room with a one-line status. */
export function DraftCard({ seasonId }: { seasonId: string }) {
  const api = useApi();
  const query = useQuery(`draft-card:${seasonId}`, () => api.draft(seasonId));
  let status = "";
  if (query.status === "ready") {
    const s = query.data;
    if (isPreDraft(s)) status = "Lobby: waiting for the commissioner to start.";
    else if (s.status === "complete") status = "Draft complete.";
    else if (s.status === "resetting") status = "The commissioner is resetting the draft.";
    else
      status = `${s.status === "paused" ? "Paused. " : ""}Pick ${s.currentPick} — ${teamName(s, s.onClockTeamId)} on the clock`;
  }
  return (
    <Card data-testid="draft-card">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold">Draft</h3>
          <p className="text-sm text-muted" data-testid="draft-card-status">
            {query.status === "loading" ? "Loading…" : status || "Open the draft room."}
          </p>
        </div>
        <Link to="/draft" className={btnPrimary}>
          Draft room
        </Link>
      </div>
    </Card>
  );
}
