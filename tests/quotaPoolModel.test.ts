import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { QuotaPoolCard, type QuotaPoolCardProps } from '@/features/quota/components/QuotaPoolCard';
import {
  POOL_PLAN_WEIGHTS,
  buildPoolView,
  poolPlanWeight,
  poolRange,
  type PoolAccount,
  type PoolPoint,
  type PoolViewOptions,
} from '@/features/quota/quotaPoolModel';
import {
  appendQuotaSamples,
  pruneQuotaHistory,
  quotaHistoryKey,
  readQuotaHistory,
  type QuotaHistoryStorage,
} from '@/features/quota/quotaHistory';
import { PREMIUM_CODEX_PLAN_TYPES } from '@/utils/quota/planTier';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 26, 12);

const account = (overrides: Partial<PoolAccount> & { id: string }): PoolAccount => ({
  label: overrides.id,
  weight: 1,
  remaining: 100,
  resetAtMs: null,
  periodHours: null,
  history: [],
  ...overrides,
});

/** Drains `perHour` over the last hour and sits at `remaining` now. */
const draining = (remaining: number, perHour: number) => [
  { atMs: NOW - HOUR, remaining: remaining + perHour },
  { atMs: NOW, remaining },
];

const options = (overrides: Partial<PoolViewOptions> = {}): PoolViewOptions => ({
  nowMs: NOW,
  rangeStartMs: NOW - 3 * DAY,
  rangeEndMs: NOW + 11 * DAY,
  horizonEndMs: NOW + 14 * DAY,
  burnWindowHours: 3,
  usage: 'same',
  ...overrides,
});

const valuesAt = (series: PoolPoint[], atMs: number) =>
  series.filter((point) => point.atMs === atMs).map((point) => point.value);

describe('buildPoolView burn rate', () => {
  test('sums drops between samples and ignores rises', () => {
    const view = buildPoolView(
      [
        account({
          id: 'a',
          remaining: 90,
          history: [
            { atMs: NOW - 2 * HOUR, remaining: 80 },
            { atMs: NOW - HOUR, remaining: 70 },
            { atMs: NOW - 0.5 * HOUR, remaining: 100 },
            { atMs: NOW, remaining: 90 },
          ],
        }),
      ],
      options()
    );

    // 10 + 10 dropped over the two hours the samples span; the +30 rise is a reset.
    expect(view.burnPerHour).toBeCloseTo(10);
  });

  test('only counts samples inside the burn window and is null with fewer than two', () => {
    const history = [
      { atMs: NOW - 5 * HOUR, remaining: 100 },
      { atMs: NOW - 2 * HOUR, remaining: 60 },
      { atMs: NOW, remaining: 50 },
    ];
    expect(
      buildPoolView([account({ id: 'a', remaining: 50, history })], options()).burnPerHour
    ).toBeCloseTo(5);
    expect(
      buildPoolView([account({ id: 'a', remaining: 50, history })], options({ burnWindowHours: 1 }))
        .burnPerHour
    ).toBeNull();
  });
});

describe('buildPoolView projection', () => {
  test('drains to a floor of 0, then jumps to full at each reset', () => {
    const view = buildPoolView(
      [
        account({
          id: 'a',
          remaining: 30,
          resetAtMs: NOW + 5 * HOUR,
          periodHours: 24,
          history: draining(30, 10),
        }),
      ],
      options()
    );

    expect(valuesAt(view.projected, NOW)).toEqual([30]);
    expect(valuesAt(view.projected, NOW + 3 * HOUR)).toEqual([0]);
    expect(valuesAt(view.projected, NOW + 5 * HOUR)).toEqual([0, 100]);
    expect(valuesAt(view.projected, NOW + 15 * HOUR)).toEqual([0]);
    expect(valuesAt(view.projected, NOW + 29 * HOUR)).toEqual([0, 100]);
    expect(view.projected.every((point) => point.value >= 0)).toBe(true);
    expect(view.poolEmptyAtMs).toBe(NOW + 3 * HOUR);
    expect(view.firstEmpty).toEqual({ label: 'a', atMs: NOW + 3 * HOUR });
    expect(view.nextReset).toEqual({ atMs: NOW + 5 * HOUR, added: 100 });
  });

  test('accounts resetting at the same instant are one reset', () => {
    const resetAtMs = NOW + 2 * HOUR;
    const view = buildPoolView(
      [
        account({ id: 'a', remaining: 50, resetAtMs, periodHours: 168 }),
        account({ id: 'b', remaining: 70, resetAtMs, periodHours: 168 }),
      ],
      options()
    );

    expect(view.projectedResets[0]).toEqual({ atMs: resetAtMs, added: 80 });
    expect(view.nextReset).toEqual({ atMs: resetAtMs, added: 80 });
    expect(view.remaining).toBe(120);
  });

  test('the pool is not empty while an account with no burn data holds quota', () => {
    const view = buildPoolView(
      [
        account({ id: 'drains', remaining: 20, history: draining(20, 10) }),
        account({ id: 'idle', remaining: 40 }),
      ],
      options()
    );

    expect(view.firstEmpty).toEqual({ label: 'drains', atMs: NOW + 2 * HOUR });
    expect(view.poolEmptyAtMs).toBeNull();
  });

  test('an account that never resets still counts, an unloaded one does not', () => {
    const view = buildPoolView(
      [account({ id: 'no-window', remaining: 40 }), account({ id: 'unloaded', remaining: null })],
      options()
    );

    expect(view.capacity).toBe(100);
    expect(view.remaining).toBe(40);
    expect(view.projectedResets).toEqual([]);
    expect(view.perAccount.map((series) => series.id)).toEqual(['no-window']);
  });

  test('a reset reported in the past means the account is full again', () => {
    const view = buildPoolView(
      [account({ id: 'a', remaining: 10, resetAtMs: NOW - HOUR, periodHours: 168 })],
      options()
    );

    expect(view.remaining).toBe(100);
  });

  test('future usage scales the projected burn', () => {
    const emptyAt = (usage: PoolViewOptions['usage']) =>
      buildPoolView(
        [account({ id: 'a', remaining: 40, history: draining(40, 10) })],
        options({ usage })
      ).poolEmptyAtMs;

    expect(emptyAt('same')).toBe(NOW + 4 * HOUR);
    expect(emptyAt('half')).toBe(NOW + 8 * HOUR);
    expect(emptyAt('double')).toBe(NOW + 2 * HOUR);
    expect(emptyAt('none')).toBeNull();
  });

  test('nothing empties past the horizon', () => {
    const view = buildPoolView(
      [account({ id: 'a', remaining: 40, history: draining(40, 10) })],
      options({ horizonEndMs: NOW + 3 * HOUR })
    );

    expect(view.poolEmptyAtMs).toBeNull();
    expect(view.firstEmpty).toBeNull();
  });

  test('drain rate steps down when an account empties and back up after its reset', () => {
    const view = buildPoolView(
      [
        account({
          id: 'a',
          remaining: 20,
          resetAtMs: NOW + 4 * HOUR,
          periodHours: 168,
          history: draining(20, 10),
        }),
        account({ id: 'b', remaining: 90, history: draining(90, 5) }),
      ],
      options()
    );

    expect(valuesAt(view.drain.projected, NOW)).toEqual([15]);
    expect(valuesAt(view.drain.projected, NOW + 2 * HOUR)).toEqual([15, 5]);
    expect(valuesAt(view.drain.projected, NOW + 4 * HOUR)).toEqual([5, 15]);
  });
});

describe('buildPoolView weights', () => {
  test('a Pro account weighs 2.5 plain accounts', () => {
    const pro = poolPlanWeight('codex', { status: 'success', planType: 'Pro' });
    const plus = poolPlanWeight('codex', { status: 'success', planType: 'plus' });
    expect(pro?.weight).toBe(2.5);
    expect(plus).toBeNull();

    const view = buildPoolView(
      [
        account({ id: 'pro', weight: pro?.weight ?? 1, remaining: 40 }),
        account({ id: 'plus', remaining: 60 }),
      ],
      options()
    );
    expect(view.capacity).toBe(350);
    expect(view.remaining).toBe(160);
  });

  test('every premium Codex plan has a weight row', () => {
    const weighted = new Set(POOL_PLAN_WEIGHTS.map((row) => row.planType));
    expect([...PREMIUM_CODEX_PLAN_TYPES].filter((plan) => !weighted.has(plan))).toEqual([]);
  });
});

describe('buildPoolView recorded series', () => {
  test('sums last-known values and labels only rises of at least 5 points', () => {
    const view = buildPoolView(
      [
        account({
          id: 'a',
          remaining: 90,
          history: [
            { atMs: NOW - 4 * HOUR, remaining: 20 },
            { atMs: NOW - 3 * HOUR, remaining: 90 },
          ],
        }),
        account({
          id: 'b',
          remaining: 53,
          history: [
            { atMs: NOW - 2 * HOUR, remaining: 50 },
            { atMs: NOW - HOUR, remaining: 53 },
          ],
        }),
      ],
      options()
    );

    expect(view.recorded).toEqual([
      { atMs: NOW - 4 * HOUR, value: 20 },
      { atMs: NOW - 3 * HOUR, value: 90 },
      // b's first sample adds to the pool but is not a reset.
      { atMs: NOW - 2 * HOUR, value: 140 },
      { atMs: NOW - HOUR, value: 143 },
      { atMs: NOW, value: 143 },
    ]);
    expect(view.recordedResets).toEqual([{ atMs: NOW - 3 * HOUR, added: 70 }]);
  });

  test('weights recorded rises like the pool', () => {
    const view = buildPoolView(
      [
        account({
          id: 'pro',
          weight: 2.5,
          remaining: 30,
          history: [
            { atMs: NOW - 2 * HOUR, remaining: 26 },
            { atMs: NOW - HOUR, remaining: 30 },
          ],
        }),
      ],
      options()
    );

    expect(view.recordedResets).toEqual([{ atMs: NOW - HOUR, added: 10 }]);
  });
});

describe('poolRange', () => {
  test('opens at local midnight three days before today and spans 14 days', () => {
    const now = new Date(2026, 9, 26, 15, 30).getTime();
    const { startMs, endMs } = poolRange(now, 0);
    expect(new Date(startMs)).toEqual(new Date(2026, 9, 23));
    expect(new Date(endMs)).toEqual(new Date(2026, 10, 6));

    expect(new Date(poolRange(now, 1).startMs)).toEqual(new Date(2026, 9, 30));
    expect(new Date(poolRange(now, -1).startMs)).toEqual(new Date(2026, 9, 16));
  });
});

const memoryStorage = (): QuotaHistoryStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
};

describe('quota history store', () => {
  const MINUTE = 60_000;
  const LOCAL = 'http://localhost:8317';

  test('skips an unchanged value within five minutes, keeps changes and later repeats', () => {
    const storage = memoryStorage();
    appendQuotaSamples(LOCAL, [{ id: 'claude:a.json', remaining: 80 }], NOW, storage);
    appendQuotaSamples(LOCAL, [{ id: 'claude:a.json', remaining: 80 }], NOW + 4 * MINUTE, storage);
    appendQuotaSamples(LOCAL, [{ id: 'claude:a.json', remaining: 79 }], NOW + 5 * MINUTE, storage);
    appendQuotaSamples(LOCAL, [{ id: 'claude:a.json', remaining: 79 }], NOW + 11 * MINUTE, storage);

    expect(readQuotaHistory(LOCAL, storage)['claude:a.json']).toEqual([
      { atMs: NOW, remaining: 80 },
      { atMs: NOW + 5 * MINUTE, remaining: 79 },
      { atMs: NOW + 11 * MINUTE, remaining: 79 },
    ]);
  });

  test('drops samples older than 21 days and keeps at most 3000 per account', () => {
    const storage = memoryStorage();
    appendQuotaSamples(LOCAL, [{ id: 'old', remaining: 10 }], NOW - 22 * DAY, storage);
    appendQuotaSamples(LOCAL, [{ id: 'kept', remaining: 10 }], NOW - 20 * DAY, storage);
    appendQuotaSamples(LOCAL, [{ id: 'kept', remaining: 20 }], NOW, storage);

    const history = readQuotaHistory(LOCAL, storage);
    expect(history.old).toBeUndefined();
    expect(history.kept?.map((sample) => sample.remaining)).toEqual([10, 20]);

    for (let index = 0; index < 3005; index += 1) {
      appendQuotaSamples(LOCAL, [{ id: 'busy', remaining: index % 2 }], NOW + index, storage);
    }
    const busy = readQuotaHistory(LOCAL, storage).busy ?? [];
    expect(busy.length).toBe(3000);
    expect(busy[busy.length - 1]?.atMs).toBe(NOW + 3004);
  });

  test('keeps each connection separate', () => {
    const storage = memoryStorage();
    appendQuotaSamples(LOCAL, [{ id: 'claude:a.json', remaining: 80 }], NOW, storage);
    appendQuotaSamples('https://remote', [{ id: 'claude:a.json', remaining: 10 }], NOW, storage);

    expect(readQuotaHistory(LOCAL, storage)['claude:a.json']?.[0]?.remaining).toBe(80);
    expect(readQuotaHistory('https://remote', storage)['claude:a.json']?.[0]?.remaining).toBe(10);
    expect(readQuotaHistory('https://other', storage)).toEqual({});
  });

  test('ignores corrupt or foreign data instead of throwing', () => {
    const storage = memoryStorage();
    storage.setItem(quotaHistoryKey(LOCAL), '{not json');
    expect(readQuotaHistory(LOCAL, storage)).toEqual({});

    storage.setItem(quotaHistoryKey(LOCAL), JSON.stringify({ v: 99, accounts: {} }));
    expect(readQuotaHistory(LOCAL, storage)).toEqual({});

    storage.setItem(
      quotaHistoryKey(LOCAL),
      JSON.stringify({
        v: 1,
        accounts: { a: [[NOW, 50], ['x', 1], [NOW + 1, 400], null], b: 'nope' },
      })
    );
    expect(readQuotaHistory(LOCAL, storage)).toEqual({ a: [{ atMs: NOW, remaining: 50 }] });

    appendQuotaSamples(LOCAL, [{ id: 'a', remaining: 40 }], NOW + HOUR, storage);
    expect(readQuotaHistory(LOCAL, storage).a?.length).toBe(2);
  });

  test('prunes accounts whose credential is gone', () => {
    const storage = memoryStorage();
    appendQuotaSamples(
      LOCAL,
      [
        { id: 'claude:gone.json', remaining: 10 },
        { id: 'claude:here.json', remaining: 20 },
      ],
      NOW,
      storage
    );
    pruneQuotaHistory(LOCAL, (id) => id !== 'claude:gone.json', storage);

    expect(Object.keys(readQuotaHistory(LOCAL, storage))).toEqual(['claude:here.json']);
  });
});

describe('QuotaPoolCard rendering', () => {
  const original = i18n.language;
  beforeAll(() => i18n.changeLanguage('en'));
  afterAll(() => i18n.changeLanguage(original));

  const render = (overrides: Partial<QuotaPoolCardProps> = {}) => {
    const accounts = [
      account({
        id: 'codex:pro.json',
        label: 'Codex 1',
        weight: 2.5,
        remaining: 40,
        resetAtMs: NOW + 2 * DAY,
        periodHours: 168,
        history: draining(40, 2),
      }),
      account({ id: 'codex:plus.json', label: 'Codex 2', remaining: 50 }),
    ];
    const view = buildPoolView(accounts, options());
    return renderToStaticMarkup(
      createElement(QuotaPoolCard, {
        provider: 'codex',
        accountCount: accounts.length,
        view,
        mode: 'remaining',
        showAccounts: false,
        rangeStartMs: NOW - 3 * DAY,
        rangeEndMs: NOW + 11 * DAY,
        nowMs: NOW,
        horizonEndMs: NOW + 14 * DAY,
        burnWindowHours: 3,
        weightNotes: ['Pro 200 = 2.5x'],
        resolvedTheme: 'dark',
        ...overrides,
      })
    );
  };

  test('shows the pool total, capacity, weight note and stats', () => {
    const markup = render();
    expect(markup).toContain('>150%<');
    expect(markup).toContain('of 350%');
    expect(markup).toContain('Pro 200 = 2.5x');
    expect(markup).toContain('Burn, last 3h');
    expect(markup).toContain('5.0%/h');
    // Codex 1 empties after 20h, then its reset adds 2.5 x 100.
    expect(markup).toContain('<strong>+250%</strong>');
    expect(markup).toContain('Codex 1 in 20h 0m');
  });

  test('names the chart for assistive technology', () => {
    expect(render()).toMatch(
      /role="img" aria-label="Codex pool: 150% of 350% remaining\. Pool empty: Not by [^"]+\. Burn: 5\.0%\/h\."/
    );
  });

  test('draws recorded solid and projected dashed lines, and per-account lines on request', () => {
    const markup = render();
    expect(markup).toMatch(/<path data-series="recorded" d="M[^"]+"/);
    expect(markup).toMatch(/<path data-series="projected" stroke-dasharray="6 5" d="M[^"]+"/);
    expect(markup).not.toContain('data-series="account"');
    expect(render({ showAccounts: true }).match(/data-series="account"/g)?.length).toBe(2);
  });

  test('switches the axis to rates in the drain view', () => {
    const markup = render({ mode: 'drain' });
    expect(markup).toContain('Codex drain rate: 5.0%/h over the last 3h.');
    expect(markup).toContain('%/h</text>');
  });
});
