import type { MeResponse } from "@dnp/contract";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useApi } from "../api";
import { useAuth } from "../auth";
import { useQuery } from "../useQuery";

type MeLeague = MeResponse["leagues"][number];

export interface LeagueContextValue {
  status: "loading" | "error" | "ready";
  error?: unknown;
  me: MeResponse | null;
  /** v1: a single league per user; the first one. */
  league: MeLeague | null;
  /** The league's most recent season. */
  season: MeLeague["seasons"][number] | null;
  isCommissioner: boolean;
  reload: () => void;
}

const LeagueContext = createContext<LeagueContextValue | null>(null);

export function LeagueProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const { status: authStatus, email } = useAuth();
  const query = useQuery(authStatus === "signedIn" ? `me:${email ?? ""}` : null, () => api.me());

  const value = useMemo<LeagueContextValue>(() => {
    const me = query.status === "ready" ? query.data : null;
    const league = me?.leagues[0] ?? null;
    const season = league ? ([...league.seasons].sort((a, b) => b.year - a.year)[0] ?? null) : null;
    return {
      status: query.status,
      error: query.error,
      me,
      league,
      season,
      isCommissioner: league?.role === "commissioner",
      reload: query.reload,
    };
  }, [query.status, query.data, query.error, query.reload]);

  return <LeagueContext.Provider value={value}>{children}</LeagueContext.Provider>;
}

/** Season selection for v1: the first league's most recent season from /me. */
export function useLeague(): LeagueContextValue {
  const value = useContext(LeagueContext);
  if (!value) throw new Error("useLeague must be used within LeagueProvider");
  return value;
}
