/** Measure whether any visible text is clipped (scrollWidth > clientWidth). */
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://127.0.0.1:4173/index.html', { waitUntil: 'networkidle' });

const report = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('*')) {
    const html = el;
    if (html.children.length === 0 && html.textContent && html.textContent.trim()) {
      const cs = getComputedStyle(html);
      if (html.scrollWidth > html.clientWidth + 1 && cs.overflow !== 'visible') {
        out.push({
          tag: html.tagName,
          cls: html.className.toString().slice(0, 80),
          text: (html.textContent || '').trim().slice(0, 60),
          scroll: html.scrollWidth,
          client: html.clientWidth,
        });
      }
    }
  }
  return {
    clipped: out,
    docScroll: document.documentElement.scrollWidth,
    docClient: document.documentElement.clientWidth,
  };
});
console.log(JSON.stringify(report, null, 2));
await browser.close();