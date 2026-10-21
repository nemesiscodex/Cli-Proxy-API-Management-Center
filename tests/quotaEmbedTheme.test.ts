import { describe, expect, test } from 'bun:test';
import { embedThemeVariables, parseT3ThemeMessage } from '@/features/quota/embedTheme';

const colors = {
  background: 'rgb(30, 30, 46)',
  foreground: 'rgb(205, 214, 244)',
  card: 'rgb(36, 36, 54)',
  popover: 'rgb(40, 40, 60)',
  muted: 'rgb(49, 50, 68)',
  mutedForeground: 'rgb(166, 173, 200)',
  accent: 'rgb(69, 71, 90)',
  border: 'rgb(255 255 255 / 0.08)',
  input: 'rgb(255 255 255 / 0.12)',
  primary: 'rgb(137, 180, 250)',
  primaryForeground: 'rgb(17, 17, 27)',
  success: 'oklab(0.8 -0.1 0.08)',
  warning: 'rgb(249, 226, 175)',
  destructive: 'rgb(243, 139, 168)',
  info: 'color(srgb 0.5 0.7 1)',
};

const message = {
  source: 't3',
  type: 'theme',
  mode: 'dark',
  colors,
  fontFamily: '"Inter", sans-serif',
};

describe('quota embed theme message', () => {
  test('a complete T3 theme message parses', () => {
    expect(parseT3ThemeMessage(message)).toEqual({
      mode: 'dark',
      colors,
      fontFamily: '"Inter", sans-serif',
    });
  });

  test('extra color fields are dropped', () => {
    const parsed = parseT3ThemeMessage({ ...message, colors: { ...colors, sidebar: 'red' } });
    expect(parsed?.colors).toEqual(colors);
  });

  const withoutInfo = Object.fromEntries(Object.entries(colors).filter(([key]) => key !== 'info'));
  const rejected: Record<string, unknown> = {
    'non-object data': 'theme',
    null: null,
    'the embed’s own ready message': { source: 'cpamc-embed', type: 'ready' },
    'a foreign source': { ...message, source: 'devtools' },
    'another message type': { ...message, type: 'navigate' },
    'an unknown mode': { ...message, mode: 'sepia' },
    'a missing font': { ...message, fontFamily: undefined },
    'a missing color': { ...message, colors: withoutInfo },
    'a non-string color': { ...message, colors: { ...colors, primary: 42 } },
    'an empty color': { ...message, colors: { ...colors, card: ' ' } },
  };
  for (const [label, data] of Object.entries(rejected)) {
    test(`ignores ${label}`, () => {
      expect(parseT3ThemeMessage(data)).toBeNull();
    });
  }
});

describe('quota embed theme variables', () => {
  const variables = embedThemeVariables(colors);

  test('surfaces, text, borders and actions take the matching T3 token', () => {
    expect(variables).toMatchObject({
      '--bg-secondary': colors.background,
      '--bg-primary': colors.card,
      '--bg-tertiary': colors.muted,
      '--bg-hover': colors.accent,
      '--floating-surface': colors.popover,
      '--text-primary': colors.foreground,
      '--text-secondary': colors.mutedForeground,
      '--border-color': colors.border,
      '--border-primary': colors.input,
      '--primary-color': colors.primary,
      '--primary-contrast': colors.primaryForeground,
      '--info-color': colors.info,
    });
  });

  test('status colors drive meters, timeline bars and error banners', () => {
    expect(variables['--success-color']).toBe(colors.success);
    expect(variables['--viz-success']).toBe(colors.success);
    expect(variables['--quota-medium-color']).toBe(colors.warning);
    expect(variables['--amber-color']).toBe(colors.warning);
    expect(variables['--error-color']).toBe(colors.destructive);
    expect(variables['--warning-color']).toBe(colors.destructive);
    expect(variables['--viz-failure']).toBe(colors.destructive);
  });

  test('dimmer text tiers fade the muted foreground into the background', () => {
    expect(variables['--text-tertiary']).toBe(
      `color-mix(in srgb, ${colors.mutedForeground} 72%, ${colors.background})`
    );
    expect(variables['--text-quaternary']).toBe(
      `color-mix(in srgb, ${colors.mutedForeground} 48%, ${colors.background})`
    );
  });

  test('every value is built only from the received colors', () => {
    const tokens = Object.values(colors);
    for (const value of Object.values(variables)) {
      const stripped = tokens.reduce((rest, token) => rest.split(token).join(''), value);
      expect(stripped).toMatch(/^(color-mix\(in srgb, +\d+%, (transparent|)\))?$/);
    }
  });
});
