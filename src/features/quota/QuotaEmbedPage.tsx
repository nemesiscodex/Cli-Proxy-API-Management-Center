import { useEffect } from 'react';
import { useThemeStore } from '@/stores';
import { QuotaPage } from './QuotaPage';
import { EMBED_READY_MESSAGE, embedThemeVariables, parseT3ThemeMessage } from './embedTheme';
import styles from './QuotaEmbedPage.module.scss';

/** Quota cards and timeline without app chrome, themed by the T3 window that iframes it. */
export function QuotaEmbedPage() {
  const followEmbedMode = useThemeStore((state) => state.followEmbedMode);

  useEffect(() => {
    // Opened directly in a browser: nobody will send a theme, keep CPAMC's own.
    if (window.parent === window) return;

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const theme = parseT3ThemeMessage(event.data);
      if (!theme) return;

      followEmbedMode(theme.mode);
      const root = document.documentElement;
      Object.entries(embedThemeVariables(theme.colors)).forEach(([name, value]) =>
        root.style.setProperty(name, value)
      );
      document.body.style.fontFamily = theme.fontFamily;
    };

    window.addEventListener('message', onMessage);
    window.parent.postMessage(EMBED_READY_MESSAGE, '*');
    return () => window.removeEventListener('message', onMessage);
  }, [followEmbedMode]);

  return (
    <main className={styles.embed}>
      <QuotaPage embedded />
    </main>
  );
}
