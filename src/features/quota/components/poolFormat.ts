import { DAY_MS, HOUR_MS, MINUTE_MS } from '@/utils/time/durations';

const formatter = (locale: string | undefined, options: Intl.DateTimeFormatOptions) => {
  try {
    return new Intl.DateTimeFormat(locale, options);
  } catch {
    return new Intl.DateTimeFormat(undefined, options);
  }
};

/** `555%`: pool values are whole percents. */
export const formatPoolPercent = (value: number): string => `${Math.round(value)}%`;

/** `3.7%/h`. */
export const formatPoolRate = (perHour: number): string => `${perHour.toFixed(1)}%/h`;

/** `Oct 23`. */
export const formatMonthDay = (ms: number, locale?: string): string =>
  formatter(locale, { month: 'short', day: 'numeric' }).format(ms);

/** `Tue 10:00 AM`, in the locale's own clock. */
export const formatWeekdayTime = (ms: number, locale?: string): string =>
  formatter(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(ms);

/** `Fri 23`. */
export const formatDayTick = (ms: number, locale?: string): string => {
  const parts = formatter(locale, { weekday: 'short', day: 'numeric' }).formatToParts(ms);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('weekday')} ${part('day')}`.trim();
};

/** `2d 18h`, `15h 49m`, `12m`: the two largest units, truncated. */
export function formatPoolDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE_MS));
  const days = Math.floor((minutes * MINUTE_MS) / DAY_MS);
  const hours = Math.floor(((minutes * MINUTE_MS) % DAY_MS) / HOUR_MS);
  const rest = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${rest}m`;
  return `${Math.max(1, rest)}m`;
}
