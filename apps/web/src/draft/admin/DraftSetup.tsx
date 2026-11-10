import type { DraftSnapshot } from "@dnp/contract";
import { useState } from "react";
import { ImportPool } from "./ImportPool";
import { OrderEditor } from "./OrderEditor";
import { PoolReview } from "./PoolReview";
import { StartControl } from "./StartControl";

/** Everything the commissioner does before the draft starts. */
export function DraftSetup({
  seasonId,
  snapshot,
  onChanged,
}: {
  seasonId: string;
  snapshot: DraftSnapshot;
  onChanged: () => void;
}) {
  const [poolKey, setPoolKey] = useState(0);
  const orderSig = snapshot.order.map((o) => o.teamId).join(",");
  return (
    <div className="space-y-5" data-testid="draft-setup">
      <ImportPool
        seasonId={seasonId}
        onDone={() => {
          setPoolKey((k) => k + 1);
          onChanged();
        }}
      />
      <PoolReview seasonId={seasonId} reloadKey={poolKey} onChanged={onChanged} />
      <OrderEditor
        key={`${orderSig}:${snapshot.teams.length}`}
        seasonId={seasonId}
        snapshot={snapshot}
        onSaved={onChanged}
      />
      <StartControl seasonId={seasonId} snapshot={snapshot} onStarted={onChanged} />
    </div>
  );
}
