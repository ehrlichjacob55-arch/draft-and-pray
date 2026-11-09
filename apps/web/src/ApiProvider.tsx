import { useMemo, type ReactNode } from "react";
import { ApiContext, createApi } from "./api";
import { DEV_EMAIL_HEADER, readDevEmail, useAuth } from "./auth";
import { useConfig } from "./config";

/** Wires the API client to the config and the current session (Bearer token, or dev header locally). */
export function ApiProvider({ children }: { children: ReactNode }) {
  const config = useConfig();
  const { mode, getIdToken } = useAuth();
  const api = useMemo(
    () =>
      createApi({
        baseUrl: config.apiBaseUrl,
        getAuthHeaders: async (): Promise<Record<string, string>> => {
          if (mode === "local") {
            const email = readDevEmail();
            return email ? { [DEV_EMAIL_HEADER]: email } : {};
          }
          const token = await getIdToken();
          return token ? { Authorization: `Bearer ${token}` } : {};
        },
      }),
    [config.apiBaseUrl, mode, getIdToken],
  );
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}
