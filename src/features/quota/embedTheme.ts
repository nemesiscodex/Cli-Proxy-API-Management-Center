/**
 * Theme handshake for the `#/embed/quota` route, where T3 Code iframes the quota cards.
 * T3 posts its resolved colors and font; this module parses that message and maps
 * T3's tokens onto CPAMC's theme variables.
 */

import type { ResolvedTheme } from '@/types';

export const EMBED_READY_MESSAGE = { source: 'cpamc-embed', type: 'ready' } as const;

const T3_COLOR_TOKENS = [
  'background',
  'foreground',
  'card',
  'popover',
  'muted',
  'mutedForeground',
  'accent',
  'border',
  'input',
  'primary',
  'primaryForeground',
  'success',
  'warning',
  'destructive',
  'info',
] as const;

export type T3ColorToken = (typeof T3_COLOR_TOKENS)[number];
export type T3ThemeColors = Record<T3ColorToken, string>;

export interface T3Theme {
  mode: ResolvedTheme;
  colors: T3ThemeColors;
  fontFamily: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Returns null for anything that is not a complete T3 theme message. */
export function parseT3ThemeMessage(data: unknown): T3Theme | null {
  if (!isRecord(data) || data.source !== 't3' || data.type !== 'theme') return null;
  if (data.mode !== 'dark' && data.mode !== 'light') return null;
  if (typeof data.fontFamily !== 'string' || !isRecord(data.colors)) return null;

  const raw = data.colors;
  const colors = {} as T3ThemeColors;
  for (const token of T3_COLOR_TOKENS) {
    const value = raw[token];
    if (typeof value !== 'string' || value.trim() === '') return null;
    colors[token] = value;
  }
  return { mode: data.mode, colors, fontFamily: data.fontFamily };
}

const mix = (color: string, percent: number, other = 'transparent') =>
  `color-mix(in srgb, ${color} ${percent}%, ${other})`;

/**
 * Every CPAMC variable the quota cards, timeline, buttons and popovers read.
 * Variables that `themes.scss` derives from these (--text-muted, --danger-color,
 * --primary-10, --glass-bg, ...) follow on their own.
 */
const EMBED_THEME_VARIABLES = {
  '--bg-secondary': (c) => c.background,
  '--bg-primary': (c) => c.card,
  '--bg-tertiary': (c) => c.muted,
  '--bg-hover': (c) => c.accent,
  '--bg-quinary': (c) => mix(c.card, 50, c.background),
  '--muted-bg': (c) => c.muted,
  '--accent-bg': (c) => c.accent,
  '--floating-surface': (c) => c.popover,

  '--text-primary': (c) => c.foreground,
  '--text-secondary': (c) => c.mutedForeground,
  '--muted-foreground': (c) => c.mutedForeground,
  '--text-tertiary': (c) => mix(c.mutedForeground, 72, c.background),
  '--text-quaternary': (c) => mix(c.mutedForeground, 48, c.background),

  '--border-color': (c) => c.border,
  '--border-primary': (c) => c.input,
  '--border-hover': (c) => mix(c.foreground, 22, c.input),

  '--primary-color': (c) => c.primary,
  '--primary-hover': (c) => mix(c.primary, 88, c.foreground),
  '--primary-active': (c) => mix(c.primary, 78, c.foreground),
  '--primary-contrast': (c) => c.primaryForeground,
  '--info-color': (c) => c.info,

  '--success-color': (c) => c.success,
  '--viz-success': (c) => c.success,
  '--success-badge-bg': (c) => mix(c.success, 16),
  '--success-badge-text': (c) => mix(c.success, 70, c.foreground),
  '--success-badge-border': (c) => mix(c.success, 45),

  '--quota-medium-color': (c) => c.warning,
  '--amber-color': (c) => c.warning,
  '--amber-text': (c) => mix(c.warning, 70, c.foreground),

  '--error-color': (c) => c.destructive,
  '--warning-color': (c) => c.destructive,
  '--viz-failure': (c) => c.destructive,
  '--bg-error-light': (c) => mix(c.destructive, 14),
  '--warning-bg': (c) => mix(c.destructive, 14),
  '--warning-border': (c) => mix(c.destructive, 40),
  '--warning-text': (c) => mix(c.destructive, 70, c.foreground),
  '--failure-badge-bg': (c) => mix(c.destructive, 16),
  '--failure-badge-text': (c) => mix(c.destructive, 70, c.foreground),
  '--failure-badge-border': (c) => mix(c.destructive, 45),

  '--count-badge-bg': (c) => mix(c.mutedForeground, 18),
  '--count-badge-text': (c) => c.mutedForeground,
} as const satisfies Record<string, (colors: T3ThemeColors) => string>;

export function embedThemeVariables(colors: T3ThemeColors): Record<string, string> {
  return Object.fromEntries(
    Object.entries(EMBED_THEME_VARIABLES).map(([name, resolve]) => [name, resolve(colors)])
  );
}
