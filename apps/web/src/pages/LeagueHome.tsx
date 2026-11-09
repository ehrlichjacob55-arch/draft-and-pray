import { useEffect, useState } from "react";
import { useConfig } from "../config";

type Health = { status: "loading" } | { status: "ok"; env: string } | { status: "error" };

export function LeagueHome() {
  const { apiBaseUrl } = useConfig();
  const [health, setHealth] = useState<Health>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBaseUrl}/health`)
      .then(async (res) => {
        const body = (await res.json()) as { status: string; env: string; db: string };
        if (!cancelled) {
          setHealth(
            res.ok && body.status === "ok" && body.db === "ok"
              ? { status: "ok", env: body.env }
              : { status: "error" },
          );
        }
      })
      .catch(() => {
        if (!cancelled) setHealth({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl]);

  return (
    <section>
      <h2 className="text-xl font-semibold">League home</h2>
      <p className="mt-2 text-muted">Welcome to Draft &amp; Pray.</p>
      <p className="mt-4 text-sm" data-testid="api-health">
        API: {health.status === "loading" && <span className="text-muted">checking…</span>}
        {health.status === "ok" && <span className="text-ok">ok ({health.env})</span>}
        {health.status === "error" && <span className="text-error">error</span>}
      </p>
    </section>
  );
}
