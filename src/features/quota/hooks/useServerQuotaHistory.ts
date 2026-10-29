import { useCallback, useEffect, useRef, useState } from 'react';
import { setServerQuotaHistory } from '../quotaHistory';
import { DEFAULT_INTERVAL_MS, fetchServerQuotaHistory } from '../serverQuotaHistory';

/**
 * Load the server's quota history on mount, then every interval the server
 * reports while the page is visible. Returns the loader for "Refresh all".
 * A 404 (server without the endpoint) stops the polling; failures keep it.
 */
export function useServerQuotaHistory(connection: string, enabled: boolean): () => Promise<void> {
  const [schedule, setSchedule] = useState<{
    connection: string;
    intervalMs: number | null;
  } | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    if (!enabled || !connection) return;
    const requestId = ++requestRef.current;
    const result = await fetchServerQuotaHistory();
    if (requestId !== requestRef.current || result.status === 'failed') return;
    if (result.status === 'loaded') setServerQuotaHistory(connection, result.history);
    setSchedule({ connection, intervalMs: result.status === 'loaded' ? result.intervalMs : null });
  }, [connection, enabled]);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  const intervalMs =
    schedule?.connection === connection ? schedule.intervalMs : DEFAULT_INTERVAL_MS;
  useEffect(() => {
    if (!enabled || intervalMs === null) return;
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void load();
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [enabled, intervalMs, load]);

  return load;
}
