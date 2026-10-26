/**
 * Pool charts for the active tab: the chart toolbar plus one QuotaPoolCard per
 * provider with at least one loaded account. Uses every loaded entry it is
 * given, not just the current page of cards.
 */

import { useCallback, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronLeft } from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import { useNow } from '@/hooks/useNow';
import { useAuthStore } from '@/stores';
import type { ResolvedTheme } from '@/types';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { QUOTA_TAB_ORDER } from '../constants';
import type { QuotaFileEntry } from '../logic';
import type { QuotaCardState } from '../providers';
import { useQuotaHistory } from '../hooks/useQuotaHistory';
import type { QuotaHistory } from '../quotaHistory';
import {
  BURN_WINDOW_HOURS,
  FUTURE_USAGES,
  POOL_CHART_MODES,
  POOL_HORIZON_MS,
  buildPoolView,
  poolAccountId,
  poolHistoryId,
  poolPlanWeight,
  poolRange,
  poolWindowOf,
  type BurnWindowHours,
  type FutureUsage,
  type PoolAccount,
  type PoolChartMode,
} from '../quotaPoolModel';
import { readQuotaUiState, writeQuotaUiState, type QuotaUiState } from '../uiState';
import { formatMonthDay } from './poolFormat';
import { QuotaPoolCard } from './QuotaPoolCard';
import styles from './QuotaPoolSection.module.scss';

export interface QuotaPoolSectionProps {
  entries: QuotaFileEntry[];
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  labelFor: (entry: QuotaFileEntry) => string;
  resolvedTheme: ResolvedTheme;
  /** The embed shows the charts with default settings and no toolbar. */
  showControls: boolean;
}

interface PoolSettings {
  mode: PoolChartMode;
  burnWindowHours: BurnWindowHours;
  usage: FutureUsage;
  showAccounts: boolean;
}

const DEFAULT_SETTINGS: PoolSettings = {
  mode: 'remaining',
  burnWindowHours: 3,
  usage: 'same',
  showAccounts: false,
};

const readSettings = (): PoolSettings => {
  const saved = readQuotaUiState();
  return {
    mode: saved?.poolMode ?? DEFAULT_SETTINGS.mode,
    burnWindowHours: saved?.burnWindowHours ?? DEFAULT_SETTINGS.burnWindowHours,
    usage: saved?.futureUsage ?? DEFAULT_SETTINGS.usage,
    showAccounts: saved?.showPoolAccounts ?? DEFAULT_SETTINGS.showAccounts,
  };
};

const toUiState = (settings: PoolSettings): QuotaUiState => ({
  poolMode: settings.mode,
  burnWindowHours: settings.burnWindowHours,
  futureUsage: settings.usage,
  showPoolAccounts: settings.showAccounts,
});

/**
 * A sample is stamped with `Date.now()` while the shared clock ticks once a
 * minute, so the newest sample can be ahead of it. Never draw "now" before it.
 */
const newestSampleMs = (history: QuotaHistory): number => {
  let newest = 0;
  for (const samples of Object.values(history)) {
    const last = samples[samples.length - 1];
    if (last && last.atMs > newest) newest = last.atMs;
  }
  return newest;
};

interface ProviderPool {
  provider: QuotaFileEntry['type'];
  accounts: PoolAccount[];
  weightNotes: string[];
}

export function QuotaPoolSection({
  entries,
  quotaFor,
  labelFor,
  resolvedTheme,
  showControls,
}: QuotaPoolSectionProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const connection = useAuthStore((state) => state.apiBase);
  const history = useQuotaHistory(connection);
  const tick = useNow();
  const nowMs = Math.max(tick, newestSampleMs(history));

  const [settings, setSettings] = useState<PoolSettings>(() =>
    showControls ? readSettings() : DEFAULT_SETTINGS
  );
  const [offsetWeeks, setOffsetWeeks] = useState(0);
  const burnLabelId = useId();
  const usageLabelId = useId();

  const updateSettings = useCallback((patch: Partial<PoolSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      writeQuotaUiState(toUiState(next));
      return next;
    });
  }, []);

  const pools = useMemo<ProviderPool[]>(
    () =>
      QUOTA_TAB_ORDER.map((provider) => {
        const accounts: PoolAccount[] = [];
        const notes = new Map<string, string>();
        entries.forEach((entry) => {
          if (entry.type !== provider) return;
          const quota = quotaFor(entry);
          if (quota?.status !== 'success') return;
          const { windowKey, ...window } = poolWindowOf(provider, quota);
          if (window.remaining === null) return;
          const plan = poolPlanWeight(provider, quota);
          if (plan) notes.set(plan.labelKey, `${t(plan.labelKey)} = ${plan.weight}x`);
          const id = poolAccountId(provider, getQuotaCacheKey(entry.file));
          accounts.push({
            id,
            label: labelFor(entry),
            weight: plan?.weight ?? 1,
            ...window,
            history: history[poolHistoryId(id, windowKey)] ?? [],
          });
        });
        return { provider, accounts, weightNotes: Array.from(notes.values()) };
      }).filter((pool) => pool.accounts.length > 0),
    [entries, history, labelFor, quotaFor, t]
  );

  const range = useMemo(() => poolRange(nowMs, offsetWeeks), [nowMs, offsetWeeks]);
  const horizonEndMs = nowMs + POOL_HORIZON_MS;
  const views = useMemo(
    () =>
      pools.map((pool) =>
        buildPoolView(pool.accounts, {
          nowMs,
          rangeStartMs: range.startMs,
          rangeEndMs: range.endMs,
          horizonEndMs,
          burnWindowHours: settings.burnWindowHours,
          usage: settings.usage,
        })
      ),
    [pools, nowMs, range, horizonEndMs, settings.burnWindowHours, settings.usage]
  );

  const usageOptions = useMemo(
    () =>
      FUTURE_USAGES.map((value) => ({ value, label: t(`quota_management.pool_usage_${value}`) })),
    [t]
  );

  if (pools.length === 0) return null;

  return (
    <section className={styles.section} aria-label={t('quota_management.pool_section_label')}>
      {showControls && (
        <div className={styles.toolbar}>
          <div
            className={styles.segmented}
            role="group"
            aria-label={t('quota_management.pool_view_label')}
          >
            {POOL_CHART_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={settings.mode === mode}
                onClick={() => updateSettings({ mode })}
              >
                {t(`quota_management.pool_view_${mode}`)}
              </button>
            ))}
          </div>

          <span className={styles.label} id={burnLabelId}>
            {t('quota_management.pool_burn_rate')}
          </span>
          <div className={styles.segmented} role="group" aria-labelledby={burnLabelId}>
            {BURN_WINDOW_HOURS.map((hours) => (
              <button
                key={hours}
                type="button"
                aria-pressed={settings.burnWindowHours === hours}
                onClick={() => updateSettings({ burnWindowHours: hours })}
              >
                {t('quota_management.pool_hours', { count: hours })}
              </button>
            ))}
          </div>

          <span className={styles.label} id={usageLabelId}>
            {t('quota_management.pool_future_usage')}
          </span>
          <div className={styles.usage}>
            <Select
              value={settings.usage}
              options={usageOptions}
              onChange={(value) => updateSettings({ usage: value as FutureUsage })}
              ariaLabelledBy={usageLabelId}
              size="sm"
            />
          </div>

          <button
            type="button"
            className={styles.toggle}
            aria-pressed={settings.showAccounts}
            onClick={() => updateSettings({ showAccounts: !settings.showAccounts })}
          >
            {t('quota_management.pool_accounts')}
          </button>

          <div className={styles.rangeNav}>
            <span className={styles.rangeText}>
              {t('quota_management.pool_range', {
                start: formatMonthDay(range.startMs, locale),
                end: formatMonthDay(range.endMs - 1, locale),
              })}
            </span>
            <button
              type="button"
              className={styles.navButton}
              aria-label={t('quota_management.pool_prev')}
              title={t('quota_management.pool_prev')}
              onClick={() => setOffsetWeeks((value) => value - 1)}
            >
              <IconChevronLeft size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={styles.todayButton}
              aria-pressed={offsetWeeks === 0}
              onClick={() => setOffsetWeeks(0)}
            >
              {t('quota_management.pool_today')}
            </button>
            <button
              type="button"
              className={`${styles.navButton} ${styles.navNext}`}
              aria-label={t('quota_management.pool_next')}
              title={t('quota_management.pool_next')}
              onClick={() => setOffsetWeeks((value) => value + 1)}
            >
              <IconChevronLeft size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {pools.map((pool, index) => (
        <QuotaPoolCard
          key={pool.provider}
          provider={pool.provider}
          accountCount={pool.accounts.length}
          view={views[index]}
          mode={settings.mode}
          showAccounts={settings.showAccounts}
          rangeStartMs={range.startMs}
          rangeEndMs={range.endMs}
          nowMs={nowMs}
          horizonEndMs={horizonEndMs}
          burnWindowHours={settings.burnWindowHours}
          weightNotes={pool.weightNotes}
          resolvedTheme={resolvedTheme}
        />
      ))}
    </section>
  );
}
