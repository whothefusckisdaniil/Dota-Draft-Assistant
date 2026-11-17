import type { BeforeSend } from '@vercel/analytics/react';

/**
 * Vercel Web Analytics filter. The draft lives in the URL (`?enemy=…&pos=…`)
 * and changes on every pick, which would count as a new page view each time.
 * So: the query string is dropped, a repeat of the same page in one visit is
 * not sent again, and a visit that opened a shared draft link is reported as
 * `/?via=draft-link` (to see how many people come from shared links).
 */
let lastSent: string | null = null;

export function analyticsUrl(raw: string, first: boolean): string {
  const url = new URL(raw);
  const shared = first && ['enemy', 'ally', 'ban'].some((k) => url.searchParams.has(k));
  return `${url.origin}${url.pathname}${shared ? '?via=draft-link' : ''}`;
}

export const beforeSend: BeforeSend = (event) => {
  if (event.type !== 'pageview') return { ...event, url: analyticsUrl(event.url, false) };
  const url = analyticsUrl(event.url, lastSent === null);
  const page = url.split('?')[0];
  if (page === lastSent) return null;
  lastSent = page;
  return { ...event, url };
};

/** Test hook. */
export function resetAnalyticsState() {
  lastSent = null;
}
