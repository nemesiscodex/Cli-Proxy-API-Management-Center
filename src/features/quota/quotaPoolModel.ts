/**
 * Quota pool: one provider's accounts summed into a single remaining-capacity
 * curve, recorded from local history up to now and projected after it.
 *
 * Pure: no React, no storage, no clock (`nowMs` is always passed in).
 *
 * Units. An account's pool value is its remaining percent (0..100) of the
 * window `buildTimelineLane` picks at a one-week bound. A pool value is
 * `sum(weight * remaining)`, so a pool of six plain accounts runs 0..600.
 */

import { normalizePlanType } from '@/utils/quota/parsers';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';
import type { QuotaProviderType } from './providers/types';
import { buildTimelineLane, startOfDay, windowsIn } from './quotaTimelineModel';

export const FUTURE_USAGES = ['same', 'half', 'double', 'none'] as const;
export type FutureUsage = (typeof FUTURE_USAGES)[number];

const FUTURE_USAGE_MULTIPLIER: Record<FutureUsage, number> = {
  same: 1,
  half: 0.5,
  double: 2,
  none: 0,
};

export const BURN_WINDOW_HOURS = [1, 3, 6] as const;
export type BurnWindowHours = (typeof BURN_WINDOW_HOURS)[number];

/** Longest window that counts as an account's pool window. */
export const POOL_WINDOW_MAX_HOURS = 168;
export const POOL_RANGE_DAYS = 14;
/** The default range opens this many days before today, so recent history shows. */
const POOL_RANGE_LEAD_DAYS = 3;
/** Pool empty / first empty / next reset look this far past now. */
export const POOL_HORIZON_MS = 14 * DAY_MS;
/** A recorded rise smaller than this is noise, not a reset worth labelling. */
export const RECORDED_RESET_MIN = 5;
/** A projected jump below this rounds to "+0%". */
const PROJECTED_RESET_MIN = 0.5;
const ACCOUNT_FULL = 100;
const EPSILON = 1e-6;

export interface PoolSample {
  atMs: number;
  /** Account pool value, 0..100. */
  remaining: number;
}

export interface PoolAccount {
  /** `${provider}:${cacheKey}`, see `poolAccountId`. */
  id: string;
  /** Already masked or an email; the caller decides. */
  label: string;
  weight: number;
  remaining: number | null;
  resetAtMs: number | null;
  periodHours: number | null;
  /** Ascending by `atMs`. */
  history: readonly PoolSample[];
}

/** A pool-unit value at an instant. Two points with the same `atMs` draw a vertical step. */
export interface PoolPoint {
  atMs: number;
  value: number;
}

/** Pool units added at one instant; accounts resetting together are one reset. */
export interface PoolReset {
  atMs: number;
  added: number;
}

export interface PoolAccountSeries {
  id: string;
  label: string;
  recorded: PoolPoint[];
  projected: PoolPoint[];
}

export interface PoolView {
  capacity: number;
  remaining: number;
  /** Pool units per hour; null when no account has two samples in the burn window. */
  burnPerHour: number | null;
  recorded: PoolPoint[];
  projected: PoolPoint[];
  recordedResets: PoolReset[];
  projectedResets: PoolReset[];
  perAccount: PoolAccountSeries[];
  /** First instant the projected pool reaches 0, at or before the horizon. */
  poolEmptyAtMs: number | null;
  /** First account to reach 0, at or before the horizon. `atMs <= now` means already empty. */
  firstEmpty: { label: string; atMs: number } | null;
  nextReset: PoolReset | null;
  /** Pool burn in pool units per hour, for the Drain rate view. */
  drain: { recorded: PoolPoint[]; projected: PoolPoint[] };
}

export interface PoolViewOptions {
  nowMs: number;
  rangeStartMs: number;
  /** The projection runs to whichever is later: this or `horizonEndMs`. */
  rangeEndMs: number;
  horizonEndMs: number;
  burnWindowHours: BurnWindowHours;
  usage: FutureUsage;
}

/* ------------------------------------------------------------ identity */

export const poolAccountId = (provider: QuotaProviderType, cacheKey: string): string =>
  `${provider}:${cacheKey}`;

export const cacheKeyOfPoolAccountId = (id: string): string => id.slice(id.indexOf(':') + 1);

/* --------------------------------------------------------- plan weight */

export interface PoolPlanWeight {
  provider: QuotaProviderType;
  /** Normalized plan type, see `normalizePlanType`. */
  planType: string;
  weight: number;
  /** i18n key of the plan's display label. */
  labelKey: string;
}

/**
 * Plans whose quota is worth more than one plain account's. Pro 100 and Pro 200
 * are the `PREMIUM_CODEX_PLAN_TYPES` family; tests keep the two in step.
 * Anything not listed weighs 1.
 */
export const POOL_PLAN_WEIGHTS: readonly PoolPlanWeight[] = [
  { provider: 'codex', planType: 'pro', weight: 2.5, labelKey: 'codex_quota.plan_pro' },
  { provider: 'codex', planType: 'prolite', weight: 2.5, labelKey: 'codex_quota.plan_prolite' },
  { provider: 'codex', planType: 'pro-lite', weight: 2.5, labelKey: 'codex_quota.plan_prolite' },
  { provider: 'codex', planType: 'pro_lite', weight: 2.5, labelKey: 'codex_quota.plan_prolite' },
  {
    provider: 'codex',
    planType: 'self_serve_business_prolite',
    weight: 2.5,
    labelKey: 'codex_quota.plan_business_premium',
  },
];

/** The weight row for a loaded quota state, or null when it weighs 1. */
export function poolPlanWeight(provider: QuotaProviderType, quota: unknown): PoolPlanWeight | null {
  if (!quota || typeof quota !== 'object') return null;
  const planType = normalizePlanType((quota as { planType?: unknown }).planType);
  if (!planType) return null;
  return (
    POOL_PLAN_WEIGHTS.find((row) => row.provider === provider && row.planType === planType) ?? null
  );
}

/* --------------------------------------------------------- pool window */

export interface PoolWindow {
  remaining: number | null;
  resetAtMs: number | null;
  periodHours: number | null;
}

/** An account's pool window from its loaded quota state. */
export function poolWindowOf(
  provider: QuotaProviderType,
  quota: { status?: string } | undefined
): PoolWindow {
  const lane = buildTimelineLane({
    name: '',
    displayName: '',
    provider,
    quota,
    maxPeriodHours: POOL_WINDOW_MAX_HOURS,
  });
  return { remaining: lane.remaining, resetAtMs: lane.anchorMs, periodHours: lane.periodHours };
}

/* --------------------------------------------------------------- range */

/** Fourteen local days from three days before today, stepped a week per offset. */
export function poolRange(nowMs: number, offsetWeeks: number): { startMs: number; endMs: number } {
  const start = new Date(startOfDay(nowMs));
  start.setDate(start.getDate() - POOL_RANGE_LEAD_DAYS + offsetWeeks * 7);
  const end = new Date(start);
  end.setDate(end.getDate() + POOL_RANGE_DAYS);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

/** Local midnights in [startMs, endMs). Date arithmetic keeps DST days aligned. */
export function poolDayStarts(startMs: number, endMs: number): number[] {
  const days: number[] = [];
  const cursor = new Date(startOfDay(startMs));
  while (cursor.getTime() < endMs && days.length <= POOL_RANGE_DAYS * 4) {
    if (cursor.getTime() >= startMs) days.push(cursor.getTime());
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

/* ---------------------------------------------------------- burn rate */

/** First index whose `atMs` is >= `atMs`. */
function lowerBound(samples: readonly PoolSample[], atMs: number): number {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].atMs < atMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose `atMs` is > `atMs`. */
function upperBound(samples: readonly PoolSample[], atMs: number): number {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].atMs <= atMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Account percent per hour over [endMs - window, endMs]: the sum of drops
 * between consecutive samples divided by the hours the samples span. Rises are
 * resets, not negative usage. Null with fewer than two samples.
 */
export function accountBurnRate(
  history: readonly PoolSample[],
  endMs: number,
  windowHours: number
): number | null {
  const from = lowerBound(history, endMs - windowHours * HOUR_MS);
  const to = upperBound(history, endMs);
  if (to - from < 2) return null;
  const coveredHours = (history[to - 1].atMs - history[from].atMs) / HOUR_MS;
  if (!(coveredHours > 0)) return null;
  let dropped = 0;
  for (let index = from + 1; index < to; index += 1) {
    dropped += Math.max(0, history[index - 1].remaining - history[index].remaining);
  }
  return dropped / coveredHours;
}

/* -------------------------------------------------------- projection */

interface AccountProjection {
  /** Unweighted 0..100. */
  points: PoolPoint[];
  emptyAtMs: number | null;
}

function resetInstants(account: PoolAccount, fromMs: number, toMs: number): number[] {
  if (account.resetAtMs === null || !account.periodHours) return [];
  return windowsIn(account.resetAtMs, account.periodHours * HOUR_MS, fromMs, toMs)
    .map((window) => window.endMs)
    .filter((atMs) => atMs > fromMs && atMs <= toMs);
}

/**
 * Drain linearly at `ratePerHour`, floor at 0, jump to 100 at every reset.
 * A reported reset that already passed means the account is full again.
 */
function projectAccount(
  account: PoolAccount,
  startValue: number,
  ratePerHour: number,
  nowMs: number,
  endMs: number
): AccountProjection {
  let atMs = nowMs;
  let value = startValue;
  const points: PoolPoint[] = [{ atMs, value }];
  let emptyAtMs: number | null = value <= 0 ? nowMs : null;

  const resets = resetInstants(account, nowMs, endMs);
  const stops = resets.map((stopMs) => ({ stopMs, reset: true }));
  if (resets[resets.length - 1] !== endMs) stops.push({ stopMs: endMs, reset: false });

  for (const { stopMs, reset } of stops) {
    if (value > 0 && ratePerHour > 0) {
      const hitsZeroMs = atMs + (value / ratePerHour) * HOUR_MS;
      if (hitsZeroMs <= stopMs) {
        points.push({ atMs: hitsZeroMs, value: 0 });
        emptyAtMs ??= hitsZeroMs;
        value = 0;
        atMs = hitsZeroMs;
      }
    }
    value = value > 0 ? Math.max(0, value - (ratePerHour * (stopMs - atMs)) / HOUR_MS) : 0;
    atMs = stopMs;
    points.push({ atMs, value });
    if (reset) {
      value = ACCOUNT_FULL;
      points.push({ atMs, value });
    }
  }
  return { points, emptyAtMs };
}

/* ------------------------------------------------------ series algebra */

/**
 * Value of a piecewise-linear series at `atMs`. At a step (two points at one
 * instant) `before` is the left limit and `after` the right one. Past the last
 * point the last value holds.
 */
function valueAt(series: readonly PoolPoint[], atMs: number, side: 'before' | 'after'): number {
  if (series.length === 0 || atMs < series[0].atMs) return 0;
  let lo = 0;
  let hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].atMs < atMs) lo = mid + 1;
    else hi = mid;
  }
  if (lo < series.length && series[lo].atMs === atMs) {
    if (side === 'before') return series[lo].value;
    let last = lo;
    while (last + 1 < series.length && series[last + 1].atMs === atMs) last += 1;
    return series[last].value;
  }
  if (lo >= series.length) return series[series.length - 1].value;
  const left = series[lo - 1];
  const right = series[lo];
  return left.value + ((right.value - left.value) * (atMs - left.atMs)) / (right.atMs - left.atMs);
}

/** Pointwise sum of series that are linear between their own points. */
function sumSeries(seriesList: readonly PoolPoint[][]): PoolPoint[] {
  const instants = Array.from(
    new Set(seriesList.flatMap((series) => series.map((point) => point.atMs)))
  ).sort((a, b) => a - b);
  const out: PoolPoint[] = [];
  for (const atMs of instants) {
    let before = 0;
    let after = 0;
    for (const series of seriesList) {
      before += valueAt(series, atMs, 'before');
      after += valueAt(series, atMs, 'after');
    }
    out.push({ atMs, value: before });
    if (Math.abs(after - before) > EPSILON) out.push({ atMs, value: after });
  }
  return out;
}

const scale = (points: readonly PoolPoint[], weight: number): PoolPoint[] =>
  points.map((point) => ({ atMs: point.atMs, value: point.value * weight }));

/** Upward steps of a series, merged per instant. */
function jumpsOf(series: readonly PoolPoint[], minAdded: number): PoolReset[] {
  const resets: PoolReset[] = [];
  for (let index = 1; index < series.length; index += 1) {
    const prev = series[index - 1];
    const point = series[index];
    if (point.atMs !== prev.atMs) continue;
    const added = point.value - prev.value;
    if (added >= minAdded) resets.push({ atMs: point.atMs, added });
  }
  return resets;
}

/** Drain per hour as a step series: each falling segment's slope, held over the segment. */
function drainSteps(points: readonly PoolPoint[]): PoolPoint[] {
  const out: PoolPoint[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const left = points[index - 1];
    const right = points[index];
    if (right.atMs === left.atMs) continue;
    const perHour = Math.max(0, ((left.value - right.value) * HOUR_MS) / (right.atMs - left.atMs));
    out.push({ atMs: left.atMs, value: perHour }, { atMs: right.atMs, value: perHour });
  }
  return out;
}

/* ----------------------------------------------------------- recorded */

interface Recorded {
  points: PoolPoint[];
  resets: PoolReset[];
  perAccount: Map<string, PoolPoint[]>;
}

/**
 * At every sample instant, each account's last known value, summed. An account
 * adds nothing before its first sample. The series is extended to now so it
 * meets the projection.
 */
function buildRecorded(accounts: readonly PoolAccount[], nowMs: number): Recorded {
  const tracked = accounts.filter((account) => account.history.length > 0);
  const perAccount = new Map<string, PoolPoint[]>();
  if (tracked.length === 0) return { points: [], resets: [], perAccount };

  const instants = Array.from(
    new Set(
      tracked.flatMap((account) =>
        account.history.filter((sample) => sample.atMs <= nowMs).map((sample) => sample.atMs)
      )
    )
  ).sort((a, b) => a - b);
  if (instants.length === 0) return { points: [], resets: [], perAccount };
  if (instants[instants.length - 1] < nowMs) instants.push(nowMs);

  const cursors = tracked.map(() => -1);
  const points: PoolPoint[] = [];
  const risesByInstant = new Map<number, number>();
  tracked.forEach((account) => perAccount.set(account.id, []));

  for (const atMs of instants) {
    let value = 0;
    tracked.forEach((account, index) => {
      let cursor = cursors[index];
      while (cursor + 1 < account.history.length && account.history[cursor + 1].atMs <= atMs) {
        cursor += 1;
        const prev = account.history[cursor - 1];
        const sample = account.history[cursor];
        if (prev && sample.remaining > prev.remaining) {
          const rise = (sample.remaining - prev.remaining) * account.weight;
          risesByInstant.set(sample.atMs, (risesByInstant.get(sample.atMs) ?? 0) + rise);
        }
      }
      cursors[index] = cursor;
      if (cursor < 0) return;
      const weighted = account.history[cursor].remaining * account.weight;
      value += weighted;
      perAccount.get(account.id)?.push({ atMs, value: weighted });
    });
    points.push({ atMs, value });
  }

  const resets = Array.from(risesByInstant, ([atMs, added]) => ({ atMs, added }))
    .filter((reset) => reset.added >= RECORDED_RESET_MIN)
    .sort((a, b) => a.atMs - b.atMs);
  return { points, resets, perAccount };
}

/** Pool burn at each recorded instant, over the burn window ending there. */
function buildRecordedDrain(
  accounts: readonly PoolAccount[],
  instants: readonly number[],
  windowHours: number
): PoolPoint[] {
  const out: PoolPoint[] = [];
  for (const atMs of instants) {
    let total = 0;
    let known = false;
    for (const account of accounts) {
      const rate = accountBurnRate(account.history, atMs, windowHours);
      if (rate === null) continue;
      known = true;
      total += rate * account.weight;
    }
    if (known) out.push({ atMs, value: total });
  }
  return out;
}

/** Keep points at or after `startMs`, plus the one just before it so the line enters the range. */
function fromRangeStart(points: PoolPoint[], startMs: number): PoolPoint[] {
  const first = points.findIndex((point) => point.atMs >= startMs);
  if (first === -1) return points.slice(-1);
  return points.slice(Math.max(0, first - 1));
}

/* ---------------------------------------------------------------- view */

export function buildPoolView(accounts: readonly PoolAccount[], opts: PoolViewOptions): PoolView {
  const { nowMs, rangeStartMs, horizonEndMs, burnWindowHours, usage } = opts;
  const endMs = Math.max(opts.rangeEndMs, horizonEndMs);
  const multiplier = FUTURE_USAGE_MULTIPLIER[usage];
  const pooled = accounts.filter((account) => account.remaining !== null);

  let burnPerHour: number | null = null;
  const projections = pooled.map((account) => {
    const rate = accountBurnRate(account.history, nowMs, burnWindowHours);
    if (rate !== null) burnPerHour = (burnPerHour ?? 0) + rate * account.weight;
    const resetPassed = account.resetAtMs !== null && account.resetAtMs <= nowMs;
    const startValue = resetPassed ? ACCOUNT_FULL : (account.remaining as number);
    return {
      account,
      ...projectAccount(account, startValue, (rate ?? 0) * multiplier, nowMs, endMs),
    };
  });

  const weightedProjections = projections.map(({ account, points }) =>
    scale(points, account.weight)
  );
  const projected = sumSeries(weightedProjections);
  const recorded = buildRecorded(pooled, nowMs);

  const projectedResets = jumpsOf(projected, PROJECTED_RESET_MIN);
  const poolEmptyAtMs =
    projected.find((point) => point.value <= EPSILON && point.atMs <= horizonEndMs)?.atMs ?? null;

  const firstEmpty = projections.reduce<{ label: string; atMs: number } | null>(
    (first, { account, emptyAtMs }) =>
      emptyAtMs !== null && emptyAtMs <= horizonEndMs && (first === null || emptyAtMs < first.atMs)
        ? { label: account.label, atMs: emptyAtMs }
        : first,
    null
  );

  const nextReset = projectedResets.find((reset) => reset.atMs <= horizonEndMs) ?? null;

  return {
    capacity: pooled.reduce((sum, account) => sum + account.weight * ACCOUNT_FULL, 0),
    remaining: projected.length > 0 ? valueAt(projected, nowMs, 'after') : 0,
    burnPerHour,
    recorded: fromRangeStart(recorded.points, rangeStartMs),
    projected,
    recordedResets: recorded.resets.filter((reset) => reset.atMs >= rangeStartMs),
    projectedResets,
    perAccount: projections.map(({ account }, index) => ({
      id: account.id,
      label: account.label,
      recorded: fromRangeStart(recorded.perAccount.get(account.id) ?? [], rangeStartMs),
      projected: weightedProjections[index],
    })),
    poolEmptyAtMs,
    firstEmpty,
    nextReset,
    drain: {
      recorded: fromRangeStart(
        buildRecordedDrain(
          pooled,
          recorded.points.map((point) => point.atMs),
          burnWindowHours
        ),
        rangeStartMs
      ),
      projected: sumSeries(weightedProjections.map(drainSteps)),
    },
  };
}
