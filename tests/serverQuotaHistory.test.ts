import { describe, expect, spyOn, test } from 'bun:test';
import { apiClient } from '../src/services/api/client';
import {
  appendQuotaSamples,
  mergeQuotaHistory,
  quotaHistoryKey,
  readPoolHistory,
  setServerQuotaHistory,
  type QuotaHistory,
  type QuotaHistoryStorage,
} from '@/features/quota/quotaHistory';
import {
  buildPoolView,
  poolAccountId,
  poolHistoryId,
  type PoolAccount,
} from '@/features/quota/quotaPoolModel';
import {
  fetchServerQuotaHistory,
  parseServerQuotaHistory,
} from '@/features/quota/serverQuotaHistory';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 29, 12);
const CLAUDE_WEEK = poolHistoryId(poolAccountId('claude', 'a.json'), 'seven-day');

const memoryStorage = (): QuotaHistoryStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
};

describe('parseServerQuotaHistory', () => {
  test('maps each account window to the history id the local recorder uses', () => {
    const parsed = parseServerQuotaHistory({
      interval_seconds: 900,
      accounts: [
        {
          name: 'a.json',
          provider: 'claude',
          windows: {
            'seven-day': [
              [NOW, 60.5],
              [NOW - 15 * MINUTE, 61],
            ],
            'five-hour': [[NOW, 88]],
          },
        },
        { name: 'b.json', provider: 'codex', windows: { weekly: [[NOW, 40]] } },
      ],
    });

    expect(parsed).toEqual({
      intervalMs: 900_000,
      history: {
        [CLAUDE_WEEK]: [
          { atMs: NOW - 15 * MINUTE, remaining: 61 },
          { atMs: NOW, remaining: 60.5 },
        ],
        [poolHistoryId(poolAccountId('claude', 'a.json'), 'five-hour')]: [
          { atMs: NOW, remaining: 88 },
        ],
        [poolHistoryId(poolAccountId('codex', 'b.json'), 'weekly')]: [{ atMs: NOW, remaining: 40 }],
      },
    });
  });

  test('drops malformed tuples and remaining outside 0..100 instead of clamping', () => {
    const parsed = parseServerQuotaHistory({
      interval_seconds: 900,
      accounts: [
        {
          name: 'a.json',
          provider: 'claude',
          windows: {
            'seven-day': [
              [NOW, 50],
              [NOW + 1, 101],
              [NOW + 2, -1],
              [NOW + 3],
              ['soon', 40],
              [NOW + 4, '40'],
              [NOW + 5, 40, 1],
              null,
            ],
            'five-hour': 'not a list',
          },
        },
      ],
    });

    expect(parsed?.history).toEqual({ [CLAUDE_WEEK]: [{ atMs: NOW, remaining: 50 }] });
  });

  test('skips providers the dashboard cannot map and accounts without a name', () => {
    const parsed = parseServerQuotaHistory({
      interval_seconds: 900,
      accounts: [
        { name: 'g.json', provider: 'gemini-cli', windows: { daily: [[NOW, 50]] } },
        { name: '', provider: 'claude', windows: { 'seven-day': [[NOW, 50]] } },
        { provider: 'claude', windows: { 'seven-day': [[NOW, 50]] } },
        'junk',
      ],
    });

    expect(parsed).toEqual({ intervalMs: 900_000, history: {} });
  });

  test('rejects a body without an accounts list and defaults a bad interval to 15 minutes', () => {
    expect(parseServerQuotaHistory(null)).toBeNull();
    expect(parseServerQuotaHistory('<html>')).toBeNull();
    expect(parseServerQuotaHistory({ interval_seconds: 900 })).toBeNull();
    expect(parseServerQuotaHistory({ interval_seconds: 0, accounts: [] })?.intervalMs).toBe(
      15 * MINUTE
    );
  });
});

describe('fetchServerQuotaHistory', () => {
  const rejectWith = (status: number | undefined) =>
    spyOn(apiClient, 'get').mockRejectedValue(
      Object.assign(new Error('request failed'), { status })
    );

  test('a 404 means the server has no history endpoint', async () => {
    const get = rejectWith(404);
    try {
      expect(await fetchServerQuotaHistory()).toEqual({ status: 'unsupported' });
    } finally {
      get.mockRestore();
    }
  });

  test('other errors and unreadable bodies are failures, never thrown', async () => {
    const get = rejectWith(undefined);
    try {
      expect(await fetchServerQuotaHistory()).toEqual({ status: 'failed' });
      get.mockResolvedValue('<html>');
      expect(await fetchServerQuotaHistory()).toEqual({ status: 'failed' });
    } finally {
      get.mockRestore();
    }
  });

  test('a 200 with no accounts is an empty history', async () => {
    const get = spyOn(apiClient, 'get').mockResolvedValue({ interval_seconds: 900, accounts: [] });
    try {
      expect(await fetchServerQuotaHistory()).toEqual({
        status: 'loaded',
        intervalMs: 900_000,
        history: {},
      });
    } finally {
      get.mockRestore();
    }
  });
});

describe('merged pool history', () => {
  test('interleaves server and local samples and keeps one per instant', () => {
    const local = {
      [CLAUDE_WEEK]: [
        { atMs: NOW - 20 * MINUTE, remaining: 62 },
        { atMs: NOW - 5 * MINUTE, remaining: 60 },
      ],
      other: [{ atMs: NOW, remaining: 10 }],
    };
    const server = {
      [CLAUDE_WEEK]: [
        { atMs: NOW - 30 * MINUTE, remaining: 63 },
        { atMs: NOW - 15 * MINUTE, remaining: 61 },
        { atMs: NOW - 5 * MINUTE, remaining: 60.5 },
        { atMs: NOW - 5 * MINUTE, remaining: 60.5 },
      ],
    };

    expect(mergeQuotaHistory(local, server)).toEqual({
      [CLAUDE_WEEK]: [
        { atMs: NOW - 30 * MINUTE, remaining: 63 },
        { atMs: NOW - 20 * MINUTE, remaining: 62 },
        { atMs: NOW - 15 * MINUTE, remaining: 61 },
        { atMs: NOW - 5 * MINUTE, remaining: 60.5 },
      ],
      other: [{ atMs: NOW, remaining: 10 }],
    });
  });

  test('server history joins only its own connection and never reaches localStorage', () => {
    const storage = memoryStorage();
    const connection = 'http://server-a:8317';
    appendQuotaSamples(connection, [{ id: CLAUDE_WEEK, remaining: 60 }], NOW, storage);
    const stored = storage.data.get(quotaHistoryKey(connection));

    setServerQuotaHistory(connection, {
      [CLAUDE_WEEK]: [{ atMs: NOW - 15 * MINUTE, remaining: 61 }],
    });

    expect(readPoolHistory(connection, storage)[CLAUDE_WEEK]).toEqual([
      { atMs: NOW - 15 * MINUTE, remaining: 61 },
      { atMs: NOW, remaining: 60 },
    ]);
    expect(readPoolHistory('http://server-b:8317', storage)).toEqual({});
    expect(storage.data.get(quotaHistoryKey(connection))).toBe(stored);
  });

  test('a dense server series gives the pool a burn rate and a projection that drains', () => {
    // What the page alone records: one sample per visit, so no burn window holds two.
    const local = { [CLAUDE_WEEK]: [{ atMs: NOW - 10 * MINUTE, remaining: 60 }] };
    const parsed = parseServerQuotaHistory({
      interval_seconds: 900,
      accounts: [
        {
          name: 'a.json',
          provider: 'claude',
          windows: {
            'seven-day': Array.from({ length: 13 }, (_, index) => [
              NOW - (12 - index) * 15 * MINUTE,
              72 - index,
            ]),
          },
        },
      ],
    });
    const viewOf = (history: QuotaHistory) => {
      const account: PoolAccount = {
        id: poolAccountId('claude', 'a.json'),
        label: 'a.json',
        weight: 1,
        remaining: 60,
        resetAtMs: null,
        periodHours: null,
        history: history[CLAUDE_WEEK] ?? [],
      };
      return buildPoolView([account], {
        nowMs: NOW,
        rangeStartMs: NOW - 3 * DAY,
        rangeEndMs: NOW + 11 * DAY,
        horizonEndMs: NOW + 14 * DAY,
        burnWindowHours: 3,
        usage: 'same',
      });
    };

    const localOnly = viewOf(local);
    expect(localOnly.burnPerHour).toBeNull();
    expect(localOnly.poolEmptyAtMs).toBeNull();

    const merged = viewOf(mergeQuotaHistory(local, parsed?.history ?? {}));
    expect(merged.burnPerHour).toBeCloseTo(4);
    expect(merged.poolEmptyAtMs).toBeCloseTo(NOW + 15 * HOUR);
  });
});
