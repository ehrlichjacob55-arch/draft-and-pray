import { useEffect, useState } from "react";
import { createBrowserRouter, RouterProvider, type RouteObject } from "react-router";
import { ConfigContext, loadConfig, type AppConfig } from "./config";
import { routes } from "./routes";

export function App({ router }: { router?: ReturnType<typeof createBrowserRouter> }) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [defaultRouter] = useState(() =>
    router ? null : createBrowserRouter(routes as RouteObject[]),
  );

  useEffect(() => {
    loadConfig().then(setConfig, (e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  }, []);

  if (error)
    return (
      <p role="alert" className="p-4 text-error">
        Could not load config: {error}
      </p>
    );
  if (!config) return <p className="p-4 text-muted">Loading…</p>;

  return (
    <ConfigContext.Provider value={config}>
      <RouterProvider router={(router ?? defaultRouter)!} />
    </ConfigContext.Provider>
  );
}
