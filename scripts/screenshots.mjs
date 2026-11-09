// Takes the README screenshots (docs/img/*.jpg) from a running editor in
// demo mode. Run it through scripts/screenshots-docker.sh, which starts
// Kiosko with examples/showcase.json --demo and a browser in a container,
// so nothing gets installed on your machine.
//
//   node scripts/screenshots.mjs <base url> <out dir>
//
// `playwright` is resolved from the current directory, not from this repo.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(join(process.cwd(), 'x.js'));
const { chromium } = require('playwright');
const [base = 'http://127.0.0.1:7420', out = 'docs/img'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();

async function open({ width = 1600, height = 900, theme = 'dark' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  await ctx.addInitScript((t) => localStorage.setItem('kiosko.ui', t), theme);
  const page = await ctx.newPage();
  await page.goto(`${base}/#/editor`);
  await page.waitForSelector('.screen-tab, .page-card');
  return page;
}

/** Waits until the panel preview has painted. */
async function painted(page) {
  await page.waitForFunction(() => {
    const img = document.querySelector('.panel-img');
    return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
  });
  // The page thumbnails load on their own; wait for them too (best effort).
  await page
    .waitForFunction(() => {
      const cards = [...document.querySelectorAll('.page-card')];
      return cards.every((c) => {
        const i = c.querySelector('img');
        return i instanceof HTMLImageElement && i.complete && i.naturalWidth > 0;
      });
    }, null, { timeout: 30_000 })
    .catch(() => undefined);
  await page.waitForTimeout(1200);
}

async function screen(page, name) {
  const tab = page.locator('.screen-tab', { hasText: name });
  if (await tab.count()) await tab.first().click();
}
async function pageCard(page, name) {
  await page.locator('.page-card', { hasText: name }).first().click();
}
async function shot(page, file) {
  await page.screenshot({ path: join(out, file), type: 'jpeg', quality: 85 });
  console.log(join(out, file));
}

{
  const p = await open();
  await screen(p, 'Trofeo Vision');
  await pageCard(p, 'Dashboard');
  await painted(p);
  await shot(p, 'editor-dashboard.jpg');

  await pageCard(p, 'Cats');
  await painted(p);
  await p.locator('.panel-surface .tile').nth(1).click();
  await p.waitForTimeout(600);
  await shot(p, 'editor-cats.jpg');

  await screen(p, 'AIO 480');
  await painted(p);
  await shot(p, 'editor-square.jpg');

  await p.goto(`${base}/#/plugins`);
  await p.waitForTimeout(1500);
  await shot(p, 'plugins.jpg');
  await p.context().close();
}
{
  const p = await open({ theme: 'light' });
  await screen(p, 'Trofeo Vision');
  await pageCard(p, 'News');
  await painted(p);
  await shot(p, 'editor-news-light.jpg');
  await p.context().close();
}
{
  const p = await open({ width: 390, height: 844 });
  await screen(p, 'Trofeo Vision');
  await pageCard(p, 'Cats');
  await painted(p);
  await shot(p, 'mobile.jpg');
  await p.context().close();
}

await browser.close();
