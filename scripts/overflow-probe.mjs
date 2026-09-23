import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:4174', { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'Puck', exact: true }).first().click();
await page.waitForTimeout(500);

const wide = await page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const out = [];
  for (const el of document.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 || r.left < -1) {
      out.push(`${el.tagName}.${(el.className + '').toString().slice(0, 80)} right=${Math.round(r.right)} w=${Math.round(r.width)}`);
    }
  }
  return out.slice(0, 15);
});
console.log(wide.join('\n') || 'none');
await browser.close();
