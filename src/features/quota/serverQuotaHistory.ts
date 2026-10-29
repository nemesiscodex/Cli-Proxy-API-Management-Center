/**
 * Quota history the server records by polling quota itself, so burn rates do
 * not depend on this page having been open. Parsed here at the boundary into
 * the same history ids the local recorder writes.
 */

import { quotaHistoryApi } from '@/services/api';
import { MINUTE_MS } from '@/utils/time/durations';
import type { QuotaProviderType } from './providers/types';
import { isSampleTuple, type QuotaHistory } from './quotaHistory';
import { poolAccountId, poolHistoryId, type PoolSample } from './quotaPoolModel';

/** Providers whose quota cache key is the auth file name the server reports. */
const SERVER_HISTORY_PROVIDERS: readonly QuotaProviderType[] = ['claude', 'codex'];
export const DEFAULT_INTERVAL_MS = 15 * MINUTE_MS;

export interface ServerQuotaHistory {
  intervalMs: number;
  history: QuotaHistory;
}

export type ServerQuotaHistoryLoad =
  ({ status: 'loaded' } & ServerQuotaHistory) | { status: 'unsupported' } | { status: 'failed' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isServerProvider = (value: unknown): value is QuotaProviderType =>
  SERVER_HISTORY_PROVIDERS.includes(value as QuotaProviderType);

export function parseServerQuotaHistory(raw: unknown): ServerQuotaHistory | null {
  if (!isRecord(raw) || !Array.isArray(raw.accounts)) return null;
  const seconds = raw.interval_seconds;
  const intervalMs =
    typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
      ? seconds * 1000
      : DEFAULT_INTERVAL_MS;

  const history: Record<string, PoolSample[]> = {};
  for (const account of raw.accounts) {
    if (!isRecord(account) || !isRecord(account.windows)) continue;
    const { name, provider } = account;
    if (typeof name !== 'string' || !name || !isServerProvider(provider)) continue;
    const accountId = poolAccountId(provider, name);
    for (const [windowId, tuples] of Object.entries(account.windows)) {
      if (!Array.isArray(tuples)) continue;
      const samples = tuples
        .filter(isSampleTuple)
        .map(([atMs, remaining]) => ({ atMs, remaining }))
        .sort((a, b) => a.atMs - b.atMs);
      if (samples.length > 0) history[poolHistoryId(accountId, windowId)] = samples;
    }
  }
  return { intervalMs, history };
}

const hasStatus = (error: unknown, status: number) => isRecord(error) && error.status === status;

/** Never throws: a server without the endpoint or a failed request leaves the chart local-only. */
export async function fetchServerQuotaHistory(): Promise<ServerQuotaHistoryLoad> {
  try {
    const parsed = parseServerQuotaHistory(await quotaHistoryApi.get());
    return parsed ? { status: 'loaded', ...parsed } : { status: 'failed' };
  } catch (error) {
    return hasStatus(error, 404) ? { status: 'unsupported' } : { status: 'failed' };
  }
}
