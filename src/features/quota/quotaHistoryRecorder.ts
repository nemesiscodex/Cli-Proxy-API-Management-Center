import { useAuthStore, useQuotaStore } from '@/stores';
import { QUOTA_TAB_ORDER } from './constants';
import { QUOTA_ADAPTERS } from './providers';
import type { QuotaStore } from './providers/types';
import { appendQuotaSamples } from './quotaHistory';
import { poolAccountId, poolHistoryId, poolWindowOf } from './quotaPoolModel';

/**
 * Record a history sample whenever any writer (batch load, single refresh,
 * reset, enrichment, the auth files page) stores a new success state.
 * Returns the unsubscribe function.
 */
export function installQuotaHistoryRecorder(): () => void {
  return useQuotaStore.subscribe((next, prev) => {
    const connection = useAuthStore.getState().apiBase;
    if (!connection) return;

    const samples: { id: string; remaining: number }[] = [];
    for (const type of QUOTA_TAB_ORDER) {
      const select = QUOTA_ADAPTERS[type].storeSelector;
      const nextMap = select(next as unknown as QuotaStore);
      const prevMap = select(prev as unknown as QuotaStore);
      if (nextMap === prevMap) continue;
      for (const [cacheKey, state] of Object.entries(nextMap)) {
        if (state === prevMap[cacheKey] || state.status !== 'success') continue;
        const { remaining, windowKey } = poolWindowOf(type, state);
        if (remaining === null) continue;
        samples.push({ id: poolHistoryId(poolAccountId(type, cacheKey), windowKey), remaining });
      }
    }
    appendQuotaSamples(connection, samples, Date.now());
  });
}
