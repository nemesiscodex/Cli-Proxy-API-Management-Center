/**
 * Quota window selection: which of a credential's windows (5-hour, weekly,
 * per-model) represents it, read structurally from each provider's state.
 *
 * Pure functions, no React and no clock of their own, so every case is
 * directly testable. The quota pool chart (quotaPoolModel.ts) builds on this.
 */

import type { QuotaProviderType } from './providers/types';

/** The short rolling window Codex reports beside its weekly one, in hours. */
const SESSION_PERIOD_HOURS = 5;

/** One credential's chosen window. */
export interface TimelineLane {
  name: string;
  displayName: string;
  provider: QuotaProviderType;
  /** Instant a window boundary falls on; all other boundaries derive from it. */
  anchorMs: number | null;
  /** Window length in hours. */
  periodHours: number | null;
  /** Remaining percent reported for the window ending at `anchorMs`. */
  remaining: number | null;
}

/**
 * Every window boundary of `periodMs` aligned to `anchorMs`, covering
 * [fromMs, toMs].
 *
 * The anchor is a known *reset* instant, so windows are projected backwards and
 * forwards from it by whole periods. Both directions matter: the visible span
 * usually starts before the current window opened, and the point of the chart
 * is what's coming.
 */
export function windowsIn(
  anchorMs: number,
  periodMs: number,
  fromMs: number,
  toMs: number
): { startMs: number; endMs: number }[] {
  if (!Number.isFinite(anchorMs) || !(periodMs > 0)) return [];
  if (!(toMs > fromMs)) return [];

  // Guard against a pathological period (a bad payload) turning this into a
  // multi-million-iteration loop.
  const maxWindows = Math.ceil((toMs - fromMs) / periodMs) + 2;
  if (maxWindows > 1000) return [];

  let end = anchorMs + Math.ceil((fromMs - anchorMs) / periodMs) * periodMs;
  const out: { startMs: number; endMs: number }[] = [];
  while (end - periodMs < toMs) {
    out.push({ startMs: end - periodMs, endMs: end });
    end += periodMs;
  }
  return out;
}

/** Start of the local day containing `ms`. */
export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Pick the window a lane is drawn from: the one whose period best fits the
 * visible span, tie-broken by the soonest reset.
 *
 * A credential usually has several (5-hour, 7-day, per-model). Picking the
 * soonest reset outright looks right and renders uselessly: across a fortnight
 * the 5-hour window always resets first, so every lane becomes ~67 slivers
 * instead of two readable weekly bars. The long window is what a two-week view
 * is *for*; the session view exists precisely to see the short one.
 *
 * `maxPeriodHours` bounds what counts as fitting — the caller passes the span.
 * With nothing under the bound, the shortest available window is used rather
 * than drawing nothing.
 */
export function pickLaneWindow<
  T extends { resetAtMs?: number | null; periodHours?: number | null },
>(windows: readonly T[], maxPeriodHours?: number): T | null {
  const usable = windows.filter(
    (window) => typeof window.resetAtMs === 'number' && Number.isFinite(window.resetAtMs)
  );
  if (usable.length === 0) return null;

  const periodOf = (window: T) =>
    typeof window.periodHours === 'number' && window.periodHours > 0 ? window.periodHours : 0;

  const fitting =
    maxPeriodHours === undefined
      ? usable
      : usable.filter((window) => periodOf(window) <= maxPeriodHours);

  // Longest period that still fits; soonest reset breaks a tie.
  const pool = fitting.length > 0 ? fitting : usable;
  return pool.reduce((best, window) => {
    const byPeriod = periodOf(window) - periodOf(best);
    if (byPeriod !== 0) return byPeriod > 0 ? window : best;
    return (window.resetAtMs as number) < (best.resetAtMs as number) ? window : best;
  });
}

/* ------------------------------------------------------------------ lanes */

/** Shape the lane builder reads. Deliberately structural — see the note below. */
interface WindowLike {
  id?: string;
  usedPercent?: number | null;
  resetAtMs?: number | null;
  periodHours?: number | null;
}

interface KimiRowLike {
  used: number;
  limit: number;
  resetAtMs?: number | null;
  periodHours?: number | null;
}

interface XaiBillingLike {
  periodType?: string;
  usagePercent?: number | null;
  resetAtMs?: number | null;
  periodHours?: number | null;
}

interface AntigravityBucketLike {
  /** Fraction 0..1 of quota REMAINING — the inverse of the percent-used providers. */
  remainingFraction?: number | null;
  resetAtMs?: number | null;
  periodHours?: number | null;
}

interface MetaWindowLike {
  id: 'window' | 'weekly';
  usedPercent: number | null;
  /** Unix seconds from the upstream Meta contract. */
  resetAt?: number;
  durationMinutes?: number;
}

export interface TimelineLaneInput {
  name: string;
  displayName: string;
  provider: QuotaProviderType;
  quota: { status?: string } | undefined;
  /**
   * Longest window period that may represent the credential, in hours. A much
   * shorter window would reset dozens of times across the pool chart.
   */
  maxPeriodHours?: number;
}

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

/**
 * Build a lane for one credential.
 *
 * Read structurally per provider rather than through a normalized model: the
 * state shapes disagree about where a window lives and what its percentage
 * means, and flattening them would lose exactly the detail the chart needs.
 *
 * Providers that expose no usable reset instant produce a lane with a null
 * anchor: the pool still counts their remaining quota, it just never resets.
 */
export function buildTimelineLane(input: TimelineLaneInput): TimelineLane {
  const { name, displayName, provider, quota, maxPeriodHours } = input;
  const empty: TimelineLane = {
    name,
    displayName,
    provider,
    anchorMs: null,
    periodHours: null,
    remaining: null,
  };

  if (!quota || quota.status !== 'success') return empty;

  if (provider === 'claude' || provider === 'codex') {
    const windows = ((quota as { windows?: WindowLike[] }).windows ?? []).filter(
      (window) => typeof window.resetAtMs === 'number'
    );
    const preferredCodexId =
      maxPeriodHours !== undefined && maxPeriodHours <= SESSION_PERIOD_HOURS
        ? 'five-hour'
        : 'weekly';
    // Codex can report model-scoped windows with the same period as the account
    // window (for example GPT-5.3-Codex-Spark weekly). A reset-time tie-break
    // would make the lane silently switch to that model's quota. Keep the lane
    // anchored to the standard account window whenever it fits this view.
    const preferredCodexWindow =
      provider === 'codex'
        ? windows.find(
            (window) =>
              window.id === preferredCodexId &&
              typeof window.periodHours === 'number' &&
              window.periodHours > 0 &&
              (maxPeriodHours === undefined || window.periodHours <= maxPeriodHours)
          )
        : undefined;
    const chosen = preferredCodexWindow ?? pickLaneWindow(windows, maxPeriodHours);
    if (!chosen) return empty;

    return {
      ...empty,
      anchorMs: chosen.resetAtMs ?? null,
      periodHours: chosen.periodHours ?? null,
      // Claude and Codex store percent USED.
      remaining:
        typeof chosen.usedPercent === 'number' ? clampPercent(100 - chosen.usedPercent) : null,
    };
  }

  if (provider === 'devin') {
    const windows =
      (
        quota as {
          windows?: {
            remainingPercent: number | null;
            resetAtMs: number | null;
            periodHours: number;
          }[];
        }
      ).windows ?? [];
    const chosen = pickLaneWindow(windows, maxPeriodHours);
    if (!chosen) return empty;
    return {
      ...empty,
      anchorMs: chosen.resetAtMs,
      periodHours: chosen.periodHours,
      remaining: chosen.remainingPercent,
    };
  }

  if (provider === 'xai') {
    const billing = (quota as { billing?: XaiBillingLike | null }).billing;
    // Only the weekly limit is a quota window. The monthly figure on the same
    // summary is a billing cycle — a spend cap rolling over, not rate-limited
    // capacity coming back — so an account without a weekly limit contributes
    // no lane rather than a lane that means something different from the rest.
    if (!billing || billing.periodType !== 'weekly') return empty;
    if (typeof billing.resetAtMs !== 'number' || !Number.isFinite(billing.resetAtMs)) return empty;

    const remaining =
      typeof billing.usagePercent === 'number' ? clampPercent(100 - billing.usagePercent) : null;

    return {
      ...empty,
      anchorMs: billing.resetAtMs,
      // A payload that states an end without a start can't derive its own
      // length; weekly is what `periodType` already told us.
      periodHours: billing.periodHours ?? 24 * 7,
      remaining,
    };
  }

  if (provider === 'antigravity') {
    // Buckets live one level down, inside groups, and the groups are a display
    // concern the chart doesn't care about — flatten them.
    const buckets = ((quota as { groups?: { buckets?: AntigravityBucketLike[] }[] }).groups ?? [])
      .flatMap((group) => group.buckets ?? [])
      .filter((bucket) => typeof bucket.resetAtMs === 'number');
    const chosen = pickLaneWindow(buckets, maxPeriodHours);
    if (!chosen) return empty;

    // Antigravity reports the fraction REMAINING, not percent used.
    const remainingOf = (bucket: AntigravityBucketLike) =>
      typeof bucket.remainingFraction === 'number'
        ? clampPercent(Math.round(bucket.remainingFraction * 100))
        : null;

    return {
      ...empty,
      anchorMs: chosen.resetAtMs ?? null,
      periodHours: chosen.periodHours ?? null,
      remaining: remainingOf(chosen),
    };
  }

  if (provider === 'kimi') {
    const rows = ((quota as { rows?: KimiRowLike[] }).rows ?? []).filter(
      (row) => typeof row.resetAtMs === 'number'
    );
    const chosen = pickLaneWindow(rows, maxPeriodHours);
    if (!chosen) return empty;

    // Kimi reports raw counts; remaining is derived.
    const remainingOf = (row: KimiRowLike) =>
      row.limit > 0 ? clampPercent(Math.round(((row.limit - row.used) / row.limit) * 100)) : null;

    return {
      ...empty,
      anchorMs: chosen.resetAtMs ?? null,
      periodHours: chosen.periodHours ?? null,
      remaining: remainingOf(chosen),
    };
  }

  if (provider === 'meta') {
    const sourceWindows = (quota as { data?: { windows?: MetaWindowLike[] } }).data?.windows ?? [];
    const windows = sourceWindows
      // The upstream weekly bucket has no duration field; its scope defines seven days.
      .map((window) => ({
        ...window,
        durationMinutes: window.id === 'weekly' ? 7 * 24 * 60 : window.durationMinutes,
      }))
      .filter(
        (window) =>
          typeof window.resetAt === 'number' &&
          Number.isFinite(window.resetAt) &&
          typeof window.durationMinutes === 'number' &&
          Number.isFinite(window.durationMinutes) &&
          window.durationMinutes > 0
      )
      .map((window) => ({
        ...window,
        resetAtMs: (window.resetAt as number) * 1000,
        periodHours: (window.durationMinutes as number) / 60,
      }));
    const chosen = pickLaneWindow(windows, maxPeriodHours);
    if (!chosen) return empty;

    const remainingOf = (window: MetaWindowLike) =>
      typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent)
        ? clampPercent(100 - window.usedPercent)
        : null;

    return {
      ...empty,
      anchorMs: chosen.resetAtMs,
      periodHours: chosen.periodHours,
      remaining: remainingOf(chosen),
    };
  }

  return empty;
}
