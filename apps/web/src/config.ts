import { createContext, useContext } from "react";

export interface AppConfig {
  apiBaseUrl: string;
  wsUrl: string;
  cognitoUserPoolId: string;
  cognitoClientId: string;
  region: string;
  env: string;
}

let cached: Promise<AppConfig> | undefined;

/** Fetches /config.json once per page load (one build serves every environment). */
export function loadConfig(): Promise<AppConfig> {
  cached ??= fetch("/config.json", { cache: "no-store" }).then((res) => {
    if (!res.ok) throw new Error(`Failed to load config.json (${res.status})`);
    return res.json() as Promise<AppConfig>;
  });
  cached.catch(() => {
    cached = undefined;
  });
  return cached;
}

export const ConfigContext = createContext<AppConfig | null>(null);

export function useConfig(): AppConfig {
  const value = useContext(ConfigContext);
  if (!value) throw new Error("useConfig must be used within ConfigContext.Provider");
  return value;
}
