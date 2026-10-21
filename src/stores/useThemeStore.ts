/**
 * 主题状态管理
 * 从原项目 src/modules/theme.js 迁移
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Theme } from '@/types';
import { STORAGE_KEY_THEME } from '@/utils/constants';

type ResolvedTheme = 'light' | 'dark';
type AppliedTheme = ResolvedTheme | 'white';

interface ThemeState {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  initializeTheme: () => () => void;
  /** The quota embed takes light/dark from T3 without touching the saved `theme`. */
  followEmbedMode: (mode: ResolvedTheme) => void;
}

const getSystemTheme = (): ResolvedTheme => {
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
};

const resolveAutoTheme = (): AppliedTheme => {
  return getSystemTheme() === 'dark' ? 'dark' : 'white';
};

const normalizeResolvedTheme = (theme: AppliedTheme): ResolvedTheme => {
  return theme === 'dark' ? 'dark' : 'light';
};

const resolveTheme = (theme: Theme): AppliedTheme => {
  if (theme === 'auto') {
    return resolveAutoTheme();
  }
  if (theme === 'white') {
    return 'white';
  }
  return theme;
};

const applyTheme = (resolved: AppliedTheme) => {
  if (resolved === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    return;
  }

  if (resolved === 'white') {
    document.documentElement.setAttribute('data-theme', 'white');
    return;
  }

  document.documentElement.removeAttribute('data-theme');
};

let embedMode: ResolvedTheme | null = null;

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: 'auto',
      resolvedTheme: 'light',

      setTheme: (theme) => {
        const resolved = resolveTheme(theme);
        applyTheme(resolved);
        set({
          theme,
          resolvedTheme: normalizeResolvedTheme(resolved),
        });
      },

      initializeTheme: () => {
        const { theme, setTheme } = get();

        // 应用已保存的主题
        setTheme(theme);

        // 监听系统主题变化（仅在 auto 模式下生效）
        if (!window.matchMedia) {
          return () => {};
        }

        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        const listener = () => {
          const { theme: currentTheme } = get();
          if (currentTheme === 'auto' && embedMode === null) {
            const resolved = resolveAutoTheme();
            applyTheme(resolved);
            set({ resolvedTheme: normalizeResolvedTheme(resolved) });
          }
        };

        mediaQuery.addEventListener('change', listener);

        return () => mediaQuery.removeEventListener('change', listener);
      },

      followEmbedMode: (mode) => {
        embedMode = mode;
        applyTheme(mode);
        set({ resolvedTheme: mode });
      },
    }),
    {
      name: STORAGE_KEY_THEME,
    }
  )
);
