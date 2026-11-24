import type { IngestResponse } from "@dnp/contract";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useApi } from "../api";
import { useQuery, type QueryState } from "../useQuery";

interface IngestValue {
  query: QueryState<IngestResponse> & { reload: () => void };
  /** The newest state: what the last action returned, or the loaded one. */
  data: IngestResponse | undefined;
  /** Adopts the state an action (finalize, toggle, ...) returned, without refetching. */
  apply: (next: IngestResponse) => void;
}

const Ctx = createContext<IngestValue | null>(null);

/**
 * The Commissioner page's one copy of `GET /seasons/:id/ingest`, shared by the Rounds and Live
 * stats cards so an action in one is reflected in the other.
 */
export function IngestProvider({ seasonId, children }: { seasonId: string; children: ReactNode }) {
  const api = useApi();
  const query = useQuery(`ingest:${seasonId}`, () => api.ingest(seasonId));
  const [latest, setLatest] = useState<IngestResponse | null>(null);
  // A newly loaded state replaces what the last action returned.
  const seen = useRef(query.data);
  useEffect(() => {
    if (query.data !== seen.current) {
      seen.current = query.data;
      setLatest(null);
    }
  }, [query.data]);
  const value = useMemo<IngestValue>(
    () => ({
      query,
      data: latest ?? (query.status === "ready" ? query.data : undefined),
      apply: setLatest,
    }),
    [query, latest],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useIngestState(): IngestValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useIngestState must be used within IngestProvider");
  return v;
}
