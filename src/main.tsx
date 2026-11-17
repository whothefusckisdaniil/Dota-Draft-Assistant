import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Analytics } from '@vercel/analytics/react';
import { beforeSend } from './analytics';
import App from './App';
import { I18nProvider } from './i18n';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <App />
      {/* Vercel Web Analytics: cookieless visitor / page-view counts (Vercel dashboard → Analytics). */}
      <Analytics beforeSend={beforeSend} />
    </I18nProvider>
  </StrictMode>,
);

// PWA: offline + home-screen install (production only; dev keeps HMR clean).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* offline support is optional */ });
  });
}
