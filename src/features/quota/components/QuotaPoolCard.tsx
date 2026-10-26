/**
 * One provider's quota pool: summed remaining capacity, recorded up to now
 * (solid) and projected after it (dashed), with the stats a planner reads
 * first. All maths is in quotaPoolModel.ts; this file is layout.
 */

import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { ResolvedTheme } from '@/types';
import { TYPE_COLORS } from '@/utils/quota';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import type { QuotaProviderType } from '../providers/types';
import {
  poolDayStarts,
  type BurnWindowHours,
  type PoolChartMode,
  type PoolPoint,
  type PoolReset,
  type PoolView,
} from '../quotaPoolModel';
import {
  formatDayTick,
  formatMonthDay,
  formatPoolDuration,
  formatPoolPercent,
  formatPoolRate,
  formatWeekdayTime,
} from './poolFormat';
import styles from './QuotaPoolCard.module.scss';

export interface QuotaPoolCardProps {
  provider: QuotaProviderType;
  accountCount: number;
  view: PoolView;
  mode: PoolChartMode;
  showAccounts: boolean;
  rangeStartMs: number;
  rangeEndMs: number;
  nowMs: number;
  horizonEndMs: number;
  burnWindowHours: BurnWindowHours;
  /** Already translated, e.g. `Pro 200 = 2.5x`. */
  weightNotes: string[];
  resolvedTheme: ResolvedTheme;
}

const HEIGHT = 300;
/** Server render and first paint, before the frame is measured. */
const DEFAULT_WIDTH = 960;
const PAD = { left: 52, right: 14, top: 34, bottom: 30 };
const EMPTY = '—';
/** Narrower than this per label and text starts to collide. */
const DAY_LABEL_PX = 52;
const RESET_LABEL_PX = 40;

/** Smallest of 1, 2, 2.5, 5 x 10^n that is at least `value`. */
function niceCeil(value: number): number {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * magnitude >= value) ?? 10;
  return step * magnitude;
}

/** The value a step lands on: the last point at that instant. */
const topAt = (series: readonly PoolPoint[], atMs: number): number | null => {
  for (let index = series.length - 1; index >= 0; index -= 1) {
    if (series[index].atMs === atMs) return series[index].value;
  }
  return null;
};

function useFrameWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useEffect(() => {
    const frame = ref.current;
    if (!frame || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(280, Math.round(entry.contentRect.width)));
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

export function QuotaPoolCard(props: QuotaPoolCardProps) {
  const {
    provider,
    accountCount,
    view,
    mode,
    showAccounts,
    rangeStartMs,
    rangeEndMs,
    nowMs,
    horizonEndMs,
    burnWindowHours,
    weightNotes,
    resolvedTheme,
  } = props;
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const { ref: frameRef, width } = useFrameWidth();
  const gradientId = `pool-fill-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const clipId = `${gradientId}-clip`;

  const colorSet = TYPE_COLORS[provider] ?? TYPE_COLORS.unknown;
  const color = (resolvedTheme === 'dark' && colorSet.dark ? colorSet.dark : colorSet.light).text;
  const providerLabel = getTypeLabel(t, provider);
  const iconSrc = getAuthFileIcon(provider, resolvedTheme);

  /* ---------- stats ---------- */

  const burnText = view.burnPerHour === null ? EMPTY : formatPoolRate(view.burnPerHour);
  const poolEmptyText =
    view.poolEmptyAtMs === null
      ? t('quota_management.pool_not_by', { date: formatMonthDay(horizonEndMs, locale) })
      : formatWeekdayTime(view.poolEmptyAtMs, locale);
  const firstEmptyText = !view.firstEmpty
    ? EMPTY
    : view.firstEmpty.atMs <= nowMs
      ? t('quota_management.pool_first_empty_now', { label: view.firstEmpty.label })
      : t('quota_management.pool_first_empty_in', {
          label: view.firstEmpty.label,
          duration: formatPoolDuration(view.firstEmpty.atMs - nowMs),
        });

  /* ---------- geometry ---------- */

  const drainMode = mode === 'drain';
  const recorded = drainMode ? view.drain.recorded : view.recorded;
  const projected = drainMode ? view.drain.projected : view.projected;
  const yMax = drainMode
    ? niceCeil(Math.max(...recorded.map((p) => p.value), ...projected.map((p) => p.value), 0))
    : Math.max(view.capacity, 1);
  const formatTick = drainMode ? formatPoolRate : formatPoolPercent;

  const plotLeft = PAD.left;
  const plotRight = width - PAD.right;
  const plotTop = PAD.top;
  const plotBottom = HEIGHT - PAD.bottom;
  const span = rangeEndMs - rangeStartMs;
  const x = (atMs: number) => plotLeft + ((atMs - rangeStartMs) / span) * (plotRight - plotLeft);
  const y = (value: number) => plotBottom - (value / yMax) * (plotBottom - plotTop);
  const inRange = (atMs: number) => atMs >= rangeStartMs && atMs <= rangeEndMs;
  const path = (points: readonly PoolPoint[]) =>
    points
      .map(
        (p, index) => `${index === 0 ? 'M' : 'L'}${x(p.atMs).toFixed(1)} ${y(p.value).toFixed(1)}`
      )
      .join('');

  const line = [...recorded, ...projected];
  const areaPath =
    line.length > 1
      ? `${path(line)}L${x(line[line.length - 1].atMs).toFixed(1)} ${plotBottom}` +
        `L${x(line[0].atMs).toFixed(1)} ${plotBottom}Z`
      : '';

  const dayStarts = poolDayStarts(rangeStartMs, rangeEndMs);
  const dayLabelEvery = Math.max(
    1,
    Math.ceil(DAY_LABEL_PX / ((plotRight - plotLeft) / Math.max(1, dayStarts.length)))
  );
  const dayTicks = dayStarts.map((startMs, index) => ({
    startMs,
    midMs: (startMs + (dayStarts[index + 1] ?? rangeEndMs)) / 2,
    labelled: index % dayLabelEvery === 0,
  }));
  const nowValue = projected[0]?.value ?? null;

  const resetLabels = drainMode
    ? []
    : [
        ...view.recordedResets.map((reset) => ({ reset, top: topAt(view.recorded, reset.atMs) })),
        ...view.projectedResets.map((reset) => ({ reset, top: topAt(view.projected, reset.atMs) })),
      ]
        .filter(
          (label): label is { reset: PoolReset; top: number } =>
            label.top !== null && inRange(label.reset.atMs)
        )
        // On a narrow chart, drop a label that would overprint the previous one.
        .filter((label, index, labels) => {
          const prev = labels[index - 1];
          return (
            !prev ||
            x(label.reset.atMs) - x(prev.reset.atMs) >= RESET_LABEL_PX ||
            Math.abs(y(label.top) - y(prev.top)) >= 14
          );
        });

  const emptyAtMs = drainMode ? null : view.poolEmptyAtMs;
  // Keep the callout text inside the frame near either edge.
  const emptyCallout =
    emptyAtMs !== null && inRange(emptyAtMs)
      ? {
          atMs: emptyAtMs,
          cx: x(emptyAtMs),
          anchor: (x(emptyAtMs) > plotRight - 90
            ? 'end'
            : x(emptyAtMs) < plotLeft + 90
              ? 'start'
              : 'middle') as 'start' | 'middle' | 'end',
        }
      : null;

  const chartLabel = drainMode
    ? t('quota_management.pool_drain_chart_label', {
        provider: providerLabel,
        burn: burnText,
        hours: burnWindowHours,
      })
    : t('quota_management.pool_chart_label', {
        provider: providerLabel,
        remaining: formatPoolPercent(view.remaining),
        capacity: formatPoolPercent(view.capacity),
        empty: poolEmptyText,
        burn: burnText,
      });

  return (
    <article className={styles.card} style={{ '--pool-color': color } as CSSProperties}>
      <header className={styles.head}>
        <div className={styles.identity}>
          <span
            className={styles.iconWrap}
            style={
              isThemeSurfaceIconProvider(provider)
                ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
                : undefined
            }
          >
            {iconSrc ? (
              <img src={iconSrc} alt="" className={styles.icon} />
            ) : (
              <span className={styles.iconFallback}>{providerLabel.slice(0, 1).toUpperCase()}</span>
            )}
          </span>
          <h3 className={styles.name}>{providerLabel}</h3>
          <span className={styles.count}>
            {t('quota_management.pool_account_count', { count: accountCount })}
          </span>
        </div>

        <div className={styles.summary}>
          <p className={styles.total}>
            <span className={styles.totalValue}>{formatPoolPercent(view.remaining)}</span>
            <span className={styles.totalOf}>
              {t('quota_management.pool_of_capacity', {
                capacity: formatPoolPercent(view.capacity),
              })}
            </span>
            {weightNotes.map((note) => (
              <span key={note} className={styles.weightNote}>
                {note}
              </span>
            ))}
          </p>

          <dl className={styles.stats}>
            <div className={styles.stat}>
              <dt>{t('quota_management.pool_stat_empty')}</dt>
              <dd>{poolEmptyText}</dd>
            </div>
            <div className={styles.stat}>
              <dt>{t('quota_management.pool_stat_first_empty')}</dt>
              <dd>{firstEmptyText}</dd>
            </div>
            <div className={styles.stat}>
              <dt>{t('quota_management.pool_stat_next_reset')}</dt>
              <dd>
                {view.nextReset ? (
                  <>
                    <strong>+{formatPoolPercent(view.nextReset.added)}</strong>{' '}
                    {formatWeekdayTime(view.nextReset.atMs, locale)}
                  </>
                ) : (
                  EMPTY
                )}
              </dd>
            </div>
            <div className={styles.stat}>
              <dt>{t('quota_management.pool_stat_burn', { hours: burnWindowHours })}</dt>
              <dd>{burnText}</dd>
            </div>
          </dl>
        </div>
      </header>

      <div className={styles.frame} ref={frameRef}>
        <svg
          className={styles.chart}
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          role="img"
          aria-label={chartLabel}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.3} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
            <clipPath id={clipId}>
              <rect x={plotLeft} y={0} width={plotRight - plotLeft} height={plotBottom + 1} />
            </clipPath>
          </defs>

          {dayTicks.map(({ startMs, midMs, labelled }) => (
            <g key={startMs}>
              <line
                className={styles.dayLine}
                x1={x(startMs)}
                x2={x(startMs)}
                y1={plotTop}
                y2={plotBottom}
              />
              {labelled && (
                <text className={styles.axisText} x={x(midMs)} y={HEIGHT - 8} textAnchor="middle">
                  {formatDayTick(midMs, locale)}
                </text>
              )}
            </g>
          ))}

          {[0, yMax / 2, yMax].map((tick) => (
            <g key={tick}>
              <line
                className={styles.gridLine}
                x1={plotLeft}
                x2={plotRight}
                y1={y(tick)}
                y2={y(tick)}
              />
              <text className={styles.axisText} x={plotLeft - 8} y={y(tick) + 4} textAnchor="end">
                {formatTick(tick)}
              </text>
            </g>
          ))}

          <g clipPath={`url(#${clipId})`}>
            {areaPath && <path className={styles.area} d={areaPath} fill={`url(#${gradientId})`} />}
            {showAccounts &&
              !drainMode &&
              view.perAccount.map((account) => (
                <path
                  key={account.id}
                  data-series="account"
                  className={styles.accountLine}
                  d={path([...account.recorded, ...account.projected])}
                >
                  <title>{account.label}</title>
                </path>
              ))}
            {recorded.length > 1 && (
              <path data-series="recorded" className={styles.recordedLine} d={path(recorded)} />
            )}
            {projected.length > 1 && (
              <path
                data-series="projected"
                className={styles.projectedLine}
                strokeDasharray="6 5"
                d={path(projected)}
              />
            )}
          </g>

          {resetLabels.map(({ reset, top }) => (
            <text
              key={`${reset.atMs}`}
              className={styles.resetText}
              x={x(reset.atMs)}
              y={Math.max(plotTop - 4, y(top) - 8)}
              textAnchor="middle"
            >
              +{formatPoolPercent(reset.added)}
            </text>
          ))}

          {inRange(nowMs) && (
            <g>
              <line
                className={styles.nowLine}
                x1={x(nowMs)}
                x2={x(nowMs)}
                y1={plotTop - 12}
                y2={plotBottom}
              />
              <text className={styles.nowText} x={x(nowMs)} y={plotTop - 18} textAnchor="middle">
                {t('quota_management.pool_now')}
              </text>
              {nowValue !== null && (
                <circle className={styles.nowDot} cx={x(nowMs)} cy={y(nowValue)} r={4} />
              )}
            </g>
          )}

          {emptyCallout && (
            <g>
              <text
                className={styles.emptyText}
                x={emptyCallout.cx}
                y={plotBottom - 14}
                textAnchor={emptyCallout.anchor}
              >
                {t('quota_management.pool_empty_callout', {
                  time: formatWeekdayTime(emptyCallout.atMs, locale),
                })}
              </text>
              <circle className={styles.emptyDot} cx={emptyCallout.cx} cy={plotBottom} r={5} />
            </g>
          )}
        </svg>
      </div>

      <footer className={styles.legend}>
        <span className={styles.legendTitle}>
          {drainMode
            ? t('quota_management.pool_legend_drain')
            : t('quota_management.pool_legend_pool')}
        </span>
        <span className={styles.legendItem}>
          <span className={styles.swatchRecorded} aria-hidden="true" />
          {t('quota_management.pool_legend_recorded')}
        </span>
        <span className={styles.legendItem}>
          <span className={styles.swatchProjected} aria-hidden="true" />
          {t('quota_management.pool_legend_projected')}
        </span>
        {view.recorded.length === 0 && (
          <span className={styles.legendHint}>{t('quota_management.pool_history_hint')}</span>
        )}
      </footer>
    </article>
  );
}
