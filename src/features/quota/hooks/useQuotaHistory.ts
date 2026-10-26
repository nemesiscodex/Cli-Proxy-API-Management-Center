import { useMemo, useSyncExternalStore } from 'react';
import {
  getQuotaHistoryVersion,
  readQuotaHistory,
  subscribeQuotaHistory,
  type QuotaHistory,
} from '../quotaHistory';

/** This connection's quota history, re-read whenever a sample is added or pruned. */
export function useQuotaHistory(connection: string): QuotaHistory {
  const version = useSyncExternalStore(
    subscribeQuotaHistory,
    getQuotaHistoryVersion,
    getQuotaHistoryVersion
  );
  // `version` is the invalidation signal; the read itself goes to storage.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => readQuotaHistory(connection), [connection, version]);
}
