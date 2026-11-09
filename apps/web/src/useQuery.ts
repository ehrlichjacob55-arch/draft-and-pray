import { useCallback, useEffect, useRef, useState } from "react";

export type QueryState<T> =
  | { status: "loading"; data?: undefined; error?: undefined }
  | { status: "error"; data?: undefined; error: unknown }
  | { status: "ready"; data: T; error?: undefined };

interface Result<T> {
  key: string;
  data?: T;
  error?: unknown;
  failed: boolean;
}

/**
 * Tiny data-fetching hook. `key === null` disables the query (stays "loading").
 * A reload keeps showing the previous data until the new result arrives.
 */
export function useQuery<T>(
  key: string | null,
  fetcher: () => Promise<T>,
): QueryState<T> & { reload: () => void } {
  const [result, setResult] = useState<Result<T> | null>(null);
  const [nonce, setNonce] = useState(0);
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    fetcherRef.current().then(
      (data) => {
        if (!cancelled) setResult({ key, data, failed: false });
      },
      (error: unknown) => {
        if (!cancelled) setResult({ key, error, failed: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  if (key === null || result === null || result.key !== key) return { status: "loading", reload };
  if (result.failed) return { status: "error", error: result.error, reload };
  return { status: "ready", data: result.data as T, reload };
}
