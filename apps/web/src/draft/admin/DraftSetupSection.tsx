import { Link } from "react-router";
import { useApi } from "../../api";
import { Card, ErrorWithRetry, Loading } from "../../components/ui";
import { friendlyError } from "../../lib/messages";
import { useQuery } from "../../useQuery";
import { isPreDraft } from "../model";
import { DraftSetup } from "./DraftSetup";
import { RedraftControl } from "./RedraftControl";

/** "Draft setup" section of the Commissioner page. */
export function DraftSetupSection({ seasonId }: { seasonId: string }) {
  const api = useApi();
  const query = useQuery(`draft-setup:${seasonId}`, () => api.draft(seasonId));
  return (
    <Card data-testid="draft-setup-section">
      <h3 className="font-semibold">Draft setup</h3>
      <div className="mt-2">
        {query.status === "loading" && <Loading />}
        {query.status === "error" && (
          <ErrorWithRetry message={friendlyError(query.error)} onRetry={query.reload} />
        )}
        {query.status === "ready" &&
          (isPreDraft(query.data) ? (
            <DraftSetup seasonId={seasonId} snapshot={query.data} onChanged={query.reload} />
          ) : (
            <div className="space-y-4">
              <p className="text-sm">
                The draft has started. Use the controls in the{" "}
                <Link to="/draft" className="text-accent underline">
                  draft room
                </Link>
                .
              </p>
              <RedraftControl seasonId={seasonId} snapshot={query.data} onDone={query.reload} />
            </div>
          ))}
      </div>
    </Card>
  );
}
