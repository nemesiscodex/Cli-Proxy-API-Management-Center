import { useMemo, useSyncExternalStore } from 'react';
import {
  getQuotaHistoryVersion,
  readPoolHistory,
  subscribeQuotaHistory,
  type QuotaHistory,
} from '../quotaHistory';

/** This connection's pool history, re-read whenever local or server samples change. */
export function useQuotaHistory(connection: string): QuotaHistory {
  const version = useSyncExternalStore(
    subscribeQuotaHistory,
    getQuotaHistoryVersion,
    getQuotaHistoryVersion
  );
  // `version` is the invalidation signal; the read itself goes to storage.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => readPoolHistory(connection), [connection, version]);
}
