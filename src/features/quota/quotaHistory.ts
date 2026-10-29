/**
 * Local quota history: one `{atMs, remaining}` sample per account per
 * successful quota load, stored in localStorage under one key per connection
 * (management API base), so switching connections never mixes two servers'
 * accounts.
 *
 * A server that polls quota itself also serves its own history. That is held
 * in memory only and merged over the local history when read for the pool.
 */

import { DAY_MS, MINUTE_MS } from '@/utils/time/durations';
import type { PoolSample } from './quotaPoolModel';

export type QuotaHistory = Readonly<Record<string, readonly PoolSample[]>>;

export type QuotaHistoryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const STORAGE_PREFIX = 'quotaPage.history:';
/** v1 samples did not record which window they measured, so they are dropped. */
const STORAGE_VERSION = 2;
const MAX_AGE_MS = 21 * DAY_MS;
const MAX_SAMPLES_PER_ACCOUNT = 3000;
/** An unchanged value is re-sampled at most this often. */
const DEDUPE_MS = 5 * MINUTE_MS;

/** Stored shape: samples as `[atMs, remaining]` tuples to keep the blob small. */
interface StoredHistory {
  v: typeof STORAGE_VERSION;
  accounts: Record<string, [number, number][]>;
}

const EMPTY_HISTORY: QuotaHistory = Object.freeze({});

export const quotaHistoryKey = (connection: string): string => `${STORAGE_PREFIX}${connection}`;

const browserStorage = (): QuotaHistoryStorage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

export const isSampleTuple = (value: unknown): value is [number, number] =>
  Array.isArray(value) &&
  value.length === 2 &&
  typeof value[0] === 'number' &&
  Number.isFinite(value[0]) &&
  typeof value[1] === 'number' &&
  value[1] >= 0 &&
  value[1] <= 100;

function parseHistory(raw: string | null): Record<string, PoolSample[]> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const { v, accounts } = parsed as { v?: unknown; accounts?: unknown };
  if (v !== STORAGE_VERSION || !accounts || typeof accounts !== 'object') return {};

  const history: Record<string, PoolSample[]> = {};
  for (const [id, tuples] of Object.entries(accounts as Record<string, unknown>)) {
    if (!Array.isArray(tuples)) continue;
    const samples = tuples
      .filter(isSampleTuple)
      .map(([atMs, remaining]) => ({ atMs, remaining }))
      .sort((a, b) => a.atMs - b.atMs);
    if (samples.length > 0) history[id] = samples;
  }
  return history;
}

function serialize(history: Record<string, PoolSample[]>): string {
  const stored: StoredHistory = { v: STORAGE_VERSION, accounts: {} };
  for (const [id, samples] of Object.entries(history)) {
    stored.accounts[id] = samples.map((sample) => [sample.atMs, sample.remaining]);
  }
  return JSON.stringify(stored);
}

/* ------------------------------------------------------- change signal */

let version = 0;
const listeners = new Set<() => void>();

export const subscribeQuotaHistory = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getQuotaHistoryVersion = (): number => version;

const notify = () => {
  version += 1;
  listeners.forEach((listener) => listener());
};

function write(
  storage: QuotaHistoryStorage,
  connection: string,
  history: Record<string, PoolSample[]>
) {
  try {
    if (Object.keys(history).length === 0) storage.removeItem(quotaHistoryKey(connection));
    else storage.setItem(quotaHistoryKey(connection), serialize(history));
  } catch {
    // Storage full or blocked: history is a nicety, never a reason to fail a load.
    return;
  }
  notify();
}

/* ----------------------------------------------------------------- API */

export function readQuotaHistory(
  connection: string,
  storage: QuotaHistoryStorage | null = browserStorage()
): QuotaHistory {
  if (!connection || !storage) return EMPTY_HISTORY;
  try {
    return parseHistory(storage.getItem(quotaHistoryKey(connection)));
  } catch {
    return EMPTY_HISTORY;
  }
}

/**
 * Append one sample per account at `atMs`, the fetch time. An account whose
 * last sample has the same value and is under five minutes old is skipped.
 * Samples older than 21 days are dropped from every account, and each account
 * keeps at most its newest 3000.
 */
export function appendQuotaSamples(
  connection: string,
  samples: readonly { id: string; remaining: number }[],
  atMs: number,
  storage: QuotaHistoryStorage | null = browserStorage()
): void {
  if (!connection || !storage || samples.length === 0) return;
  const history = { ...readQuotaHistory(connection, storage) } as Record<string, PoolSample[]>;
  let changed = false;

  for (const { id, remaining } of samples) {
    if (!Number.isFinite(remaining)) continue;
    const list = history[id] ?? [];
    const last = list[list.length - 1];
    if (last && last.remaining === remaining && atMs - last.atMs < DEDUPE_MS) continue;
    const next = [...list, { atMs, remaining }];
    if (last && last.atMs > atMs) next.sort((a, b) => a.atMs - b.atMs);
    history[id] = next.slice(-MAX_SAMPLES_PER_ACCOUNT);
    changed = true;
  }

  const cutoff = atMs - MAX_AGE_MS;
  for (const [id, list] of Object.entries(history)) {
    if (list[0].atMs >= cutoff) continue;
    const kept = list.filter((sample) => sample.atMs >= cutoff);
    if (kept.length > 0) history[id] = kept;
    else delete history[id];
    changed = true;
  }

  if (changed) write(storage, connection, history);
}

/** Drop accounts `keep` rejects, such as credentials that no longer exist. */
export function pruneQuotaHistory(
  connection: string,
  keep: (id: string) => boolean,
  storage: QuotaHistoryStorage | null = browserStorage()
): void {
  if (!connection || !storage) return;
  const history = readQuotaHistory(connection, storage);
  const ids = Object.keys(history);
  const kept = ids.filter(keep);
  if (kept.length === ids.length) return;
  write(storage, connection, Object.fromEntries(kept.map((id) => [id, [...history[id]]])));
}

/* ------------------------------------------------------ server history */

let serverHistory: { connection: string; history: QuotaHistory } | null = null;

export function setServerQuotaHistory(connection: string, history: QuotaHistory): void {
  serverHistory = { connection, history };
  notify();
}

/**
 * Union per history id, ascending, one sample per instant (the server's when
 * both have one).
 */
export function mergeQuotaHistory(local: QuotaHistory, server: QuotaHistory): QuotaHistory {
  const merged: Record<string, readonly PoolSample[]> = { ...local };
  for (const [id, samples] of Object.entries(server)) {
    const byTime = new Map<number, PoolSample>();
    for (const sample of [...(local[id] ?? []), ...samples]) byTime.set(sample.atMs, sample);
    merged[id] = Array.from(byTime.values()).sort((a, b) => a.atMs - b.atMs);
  }
  return merged;
}

/** What the pool reads: local history with this connection's server history merged in. */
export function readPoolHistory(
  connection: string,
  storage: QuotaHistoryStorage | null = browserStorage()
): QuotaHistory {
  const local = readQuotaHistory(connection, storage);
  return serverHistory?.connection === connection
    ? mergeQuotaHistory(local, serverHistory.history)
    : local;
}
