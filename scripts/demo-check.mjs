// End-to-end check of the static browser demo (site/demo): serves it as
// GitHub Pages would (under /demo/), drives it with Playwright and takes
// screenshots. When the folder holds the whole site, its front page is
// checked too (languages, plugins, links, the editor driving itself). Run it
// through scripts/demo-check-docker.sh, which builds the site and runs this
// inside the Playwright container: nothing is installed on your machine.
//
//   node scripts/demo-check.mjs <site dir> <out dir> [--browsers chromium,firefox,webkit] [--measure]
//
// Chromium runs every check; other browsers get a smoke test (loads, paints,
// no errors). --measure compares main-thread long tasks with the runtime in
// a Web Worker (default) and in the page (?render=page).
// `playwright` is resolved from the current directory, not from this repo.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { BUNDLED_PLUGIN_IDS } from '../packages/server/src/official.ts';

const require = createRequire(join(process.cwd(), 'x.js'));
const playwright = require('playwright');
const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--browsers');
const [siteDir = 'site', out = 'tmp/demo-check'] = positional;
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const browsers = (opt('--browsers') ?? 'chromium').split(',');
const measure = args.includes('--measure');
mkdirSync(out, { recursive: true });
const showcase = JSON.parse(readFileSync(new URL('../examples/showcase.json', import.meta.url), 'utf8'));

// ---------- A static server, like GitHub Pages ----------

const MIME = { '.jpg': 'image/jpeg', '.webp': 'image/webp', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ttf': 'font/ttf', '.gz': 'application/gzip', '.txt': 'text/plain' };
const root = resolve(siteDir);
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  let file = normalize(join(root, decodeURIComponent(url.pathname)));
  if (!file.startsWith(root)) return void res.writeHead(400).end();
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) return void res.writeHead(404).end('not found');
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}/demo/`;

// ---------- Helpers ----------

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Watches a page for errors: console errors, uncaught exceptions, failed requests. */
function watchErrors(page) {
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  // A load cancelled (the page moved on, a picture replaced before it arrived) is not a failure:
  // WebKit reports it as one, and only now and then, as it depends on timing.
  const cancelled = /^(Load request cancelled|cancelled|net::ERR_ABORTED|NS_BINDING_ABORTED)$/i;
  page.on('requestfailed', (r) => cancelled.test(r.failure()?.errorText ?? '') || errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => r.status() >= 400 && errors.push(`http ${r.status()}: ${r.url()}`));
  return errors;
}

/** Stats of an <img> (or a region of it, in its own pixels): distinct colours and a hash. */
async function imgStats(page, selector, region) {
  return page.evaluate(
    ([sel, rg]) => {
      const img = document.querySelector(sel);
      if (!(img instanceof HTMLImageElement) || !img.complete || !img.naturalWidth) return null;
      const r = rg ?? { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(r.w));
      c.height = Math.max(1, Math.round(r.h));
      const g = c.getContext('2d');
      g.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const colours = new Set();
      let hash = 0;
      let differs = 0;
      for (let i = 0; i < d.length; i += 4) {
        const v = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
        if (colours.size < 5000) colours.add(v);
        hash = (Math.imul(hash, 31) + v) | 0;
        if (v !== ((d[0] << 16) | (d[1] << 8) | d[2])) differs++;
      }
      return { w: img.naturalWidth, h: img.naturalHeight, colours: colours.size, hash, inked: differs / (d.length / 4), src: img.src };
    },
    [selector, region],
  );
}

const painted = (s) => !!s && s.colours > 20 && s.inked > 0.02;

async function waitPreview(page, previousSrc) {
  await page.waitForFunction(
    (prev) => {
      const img = document.querySelector('.panel-img');
      return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0 && img.src !== prev;
    },
    previousSrc ?? null,
    { timeout: 30_000 },
  );
}

/** Waits for every page card's picture (of a screen `width` px wide, if given). */
async function waitThumbs(page, width) {
  await page.waitForFunction(
    (w) => {
      const cards = [...document.querySelectorAll('.page-card')];
      return cards.length > 0 && cards.every((c) => {
        const i = c.querySelector('img');
        return i instanceof HTMLImageElement && i.complete && i.naturalWidth > 0 && (!w || i.naturalWidth === w);
      });
    },
    width ?? 0,
    { timeout: 30_000 },
  );
}

async function openDemo(browser, { theme = 'dark', query = '', width = 1600, height = 900, fresh = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  await ctx.addInitScript(
    ([t, f]) => {
      if (f && !sessionStorage.getItem('kept')) {
        localStorage.clear();
        sessionStorage.setItem('kept', '1');
      }
      if (!localStorage.getItem('kiosko.ui')) localStorage.setItem('kiosko.ui', t);
    },
    [theme, fresh],
  );
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(`${base}${query}#/editor`);
  await page.waitForSelector('.screen-tab', { timeout: 30_000 });
  await waitPreview(page);
  return { ctx, page, errors };
}

async function selectScreen(page, name, width) {
  await page.locator('.screen-tab', { hasText: name }).first().click();
  // Wait for this screen's picture (a repaint of the previous one may land first).
  await page.waitForFunction((w) => {
    const img = document.querySelector('.panel-img');
    return img instanceof HTMLImageElement && img.complete && img.naturalWidth === w;
  }, width, { timeout: 30_000 });
}

/** Polls a region of the preview until its pixels differ from `hash`. */
async function waitRegionChange(page, region, hash) {
  for (let i = 0; i < 40; i++) {
    const s = await imgStats(page, '.panel-img', region);
    if (s && s.hash !== hash) return s;
    await page.waitForTimeout(250);
  }
  return imgStats(page, '.panel-img', region);
}

async function selectPage(page, name) {
  const before = await page.$eval('.panel-img', (i) => i.src).catch(() => null);
  await page.locator('.page-card', { hasText: name }).first().click();
  await waitPreview(page, before);
}

/** A tile's rectangle in the preview image's pixels. */
async function tileRegion(page, index) {
  return page.evaluate((i) => {
    const surface = document.querySelector('.panel-surface').getBoundingClientRect();
    const img = document.querySelector('.panel-img');
    const t = document.querySelectorAll('.panel-surface .tile')[i].getBoundingClientRect();
    const k = img.naturalWidth / surface.width;
    return { x: (t.left - surface.left) * k, y: (t.top - surface.top) * k, w: t.width * k, h: t.height * k };
  }, index);
}

/** The config the demo saved in localStorage (null: nothing saved, the showcase). */
const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('kiosko.demo.config') ?? 'null')?.config ?? null);
const tileOf = (cfg, id) => cfg?.screens.flatMap((s) => s.pages.flatMap((p) => p.tiles)).find((t) => t.id === id);

async function shot(page, file) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, file), type: 'jpeg', quality: 85 });
  console.log(`     screenshot ${join(out, file)}`);
}

/** Drags from the centre of `selector` by (dx, dy) CSS pixels, in steps. */
async function drag(page, selector, dx, dy) {
  const b = await page.locator(selector).first().boundingBox();
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dx * i) / 8, y + (dy * i) / 8);
  await page.mouse.up();
}

// ---------- The full check (Chromium) ----------

/** The editor's language picker: buttons for a few languages, a list past five options. */
async function chooseLanguage(page, name) {
  const list = page.locator('select[aria-label]').filter({ has: page.locator('option', { hasText: name }) });
  if (await list.count()) await list.first().selectOption({ label: name });
  else await page.locator('.segmented button', { hasText: name }).click();
}

/** Opened from the Chinese front page (`?lang=`), the sample is in Chinese, whatever the browser speaks. */
async function pageLanguage(browser) {
  const { ctx, page, errors } = await openDemo(browser, { query: '?lang=zh-TW' });
  const names = await page.$$eval('.page-card', (l) => l.map((e) => e.textContent?.trim() ?? ''));
  const lang = await page.evaluate(() => document.documentElement.lang);
  check('opened from a page in Chinese, the sample and the editor speak it (browser in English)', names.some((n) => n.includes('總覽')) && lang.startsWith('zh'), `pages ${names.map((n) => n.slice(0, 8)).join(', ')}; html lang ${lang}`);
  check('no errors with ?lang=', errors.length === 0, errors.join(' | '));
  await ctx.close();
  // Mainland China (languages.ts): nothing of what is left out there in the library, and local models in it.
  // Since agents 0.3 reads the agents used there (Qwen Code, Kimi CLI…), nothing is left out today.
  const { LANGUAGES: langs } = await import(new URL('../packages/sdk/src/languages.ts', import.meta.url).href);
  const without = langs.find((l) => l.id === 'zh-Hans')?.plugins?.without ?? [];
  const cn = await openDemo(browser, { query: '?lang=zh-CN' });
  await cn.page.waitForSelector('.lib-item');
  const types = await cn.page.$$eval('.lib-item', (l) => l.map((e) => e.getAttribute('data-type') ?? ''));
  check(`opened from the Simplified Chinese page: local models${without.length ? `, and no ${without.join(', ')}` : ''}`, !types.some((t) => without.includes(t.split('/')[0])) && types.some((t) => t.startsWith('llm/')), `${types.length} widgets: ${types.filter((t) => /^(agents|cats|usage|llm)\//.test(t)).join(', ')}`);
  await cn.ctx.close();
}

async function fullCheck(browser) {
  const { ctx, page, errors } = await openDemo(browser);

  // Banner, links and the strip's preview.
  const banner = await page.locator('.demo-banner').innerText();
  check('banner says demo, in English', /running in your browser with sample data/.test(banner), banner.replace(/\s+/g, ' ').slice(0, 120));
  check('banner links to the README and GitHub', (await page.locator('.demo-banner a[href*="github.com/kiosko-lcd/kiosko#readme"]').count()) === 1 && (await page.locator('.demo-banner a[href="https://github.com/kiosko-lcd/kiosko"]').count()) === 1);
  const strip = await imgStats(page, '.panel-img');
  check('strip preview paints', painted(strip), JSON.stringify({ size: `${strip?.w}x${strip?.h}`, colours: strip?.colours, inked: strip?.inked.toFixed(2) }));
  await waitThumbs(page);
  for (let i = 0; i < (await page.locator('.page-card').count()); i++) {
    const s = await imgStats(page, `.page-card:nth-child(${i + 1}) img`);
    check(`strip page thumbnail ${i + 1} paints`, painted(s), `colours ${s?.colours}`);
  }
  // Library thumbnails paint as they scroll into view.
  await page.locator('.lib-list').evaluate((e) => e.scrollBy(0, 1500));
  await page.waitForFunction(() => [...document.querySelectorAll('.lib-thumb img')].filter((i) => i.complete && i.naturalWidth > 0).length >= 6, null, { timeout: 30_000 }).catch(() => undefined);
  const libThumbs = await page.$$eval('.lib-thumb img', (l) => l.filter((i) => i.complete && i.naturalWidth > 0).length);
  check('library thumbnails paint as they scroll into view', libThumbs >= 6, `${libThumbs} of ${await page.locator('.lib-thumb img').count()} loaded`);
  // Then every one of them, scrolling down the whole library.
  const total = await page.locator('.lib-thumb img').count();
  for (let i = 0; i < 30; i++) {
    const n = await page.$$eval('.lib-thumb img', (l) => l.filter((im) => im.complete && im.naturalWidth > 0).length);
    if (n === total) break;
    await page.locator('.lib-list').evaluate((e) => e.scrollBy(0, 900));
    await page.waitForTimeout(400);
  }
  const blank = await page.$$eval('.lib-item', (l) => l.filter((it) => !(it.querySelector('img')?.naturalWidth > 0)).map((it) => it.querySelector('.lib-name')?.textContent?.trim()));
  check('every library thumbnail paints', !blank.length, blank.length ? `not painted: ${blank.join(', ')}` : `${total} widgets`);
  await page.locator('.lib-list').evaluate((e) => e.scrollTo(0, 0));
  await shot(page, 'demo-editor-dashboard.jpg');

  check('no tile errors on Dashboard', (await page.locator('.tile-error').count()) === 0);
  for (const name of ['Cats', 'News']) {
    await selectPage(page, name);
    const s = await imgStats(page, '.panel-img');
    check(`strip page ${name} paints`, painted(s), `colours ${s?.colours}`);
    check(`no tile errors on ${name}`, (await page.locator('.tile-error').count()) === 0);
    await shot(page, `demo-editor-${name.toLowerCase()}.jpg`);
  }

  // The square screen.
  await selectScreen(page, 'AIO 480', 480);
  await waitThumbs(page, 480);
  const sq = await imgStats(page, '.panel-img');
  check('square preview paints', painted(sq) && sq.w === 480 && sq.h === 480, `${sq?.w}x${sq?.h}, colours ${sq?.colours}`);
  check('square page thumbnail paints', painted(await imgStats(page, '.page-card img')));

  // A widget option changes the preview: "Show week number" of the calendar day.
  await page.locator('.panel-surface .tile').nth(1).click();
  const region = await tileRegion(page, 1);
  const before = await imgStats(page, '.panel-img', region);
  const thumbBefore = await page.$eval('.page-card img', (i) => i.src);
  await page.locator('.inspector [role=switch][id$="showWeekNumber"]').click();
  const after = await waitRegionChange(page, region, before?.hash);
  check('changing a widget option changes the preview pixels', before && after && before.hash !== after.hash, `tile hash ${before?.hash} → ${after?.hash}`);
  const thumbAfter = await page
    .waitForFunction((prev) => {
      const i = document.querySelector('.page-card img');
      return i instanceof HTMLImageElement && i.src !== prev && i.complete && i.naturalWidth === 480 ? i.src : false;
    }, thumbBefore, { timeout: 10_000 })
    .then(() => true, () => false);
  check('the page thumbnail repaints after the change', thumbAfter);
  await shot(page, 'demo-editor-square.jpg');

  // Drag and resize on the strip's Dashboard: shrink the usage rail from
  // its left edge, then move the vitals tile one column right.
  await selectScreen(page, 'Trofeo', 1920);
  await selectPage(page, 'Dashboard');
  const colW = await page.$eval('.panel-surface', (s) => s.getBoundingClientRect().width / 24);
  await page.locator('.panel-surface .tile').nth(3).click();
  await drag(page, '.tile.selected .handle.h-w', colW, 0);
  await page.waitForTimeout(800);
  let cfg = await stored(page);
  const rail = tileOf(cfg, 'tile-08');
  check('resize from the west edge', rail?.x === 20 && rail?.w === 4, `usage/rail ${JSON.stringify(rail && { x: rail.x, w: rail.w })} (was x 19, w 5)`);
  await page.locator('.panel-surface .tile').nth(2).click();
  await drag(page, '.tile.selected', colW, 0);
  await page.waitForTimeout(800);
  cfg = await stored(page);
  const vit = tileOf(cfg, 'tile-06');
  check('move by dragging', vit?.x === 14 && vit?.w === 6, `vitals ${JSON.stringify(vit && { x: vit.x, y: vit.y, w: vit.w })} (was x 13)`);

  // A new blank page; add a widget from the library (click: first free
  // spot), then stack another on its tile by dragging it from the library.
  await page.locator('.pages-bar .add-page > .icon-btn').click();
  await page.locator('.popover .menu-item').first().click();
  await page.waitForTimeout(500);
  check('add a page', (await page.locator('.page-card').count()) === 4);
  await page.locator('.library input').fill('note');
  await page.locator('.lib-item').first().click();
  await page.waitForTimeout(300);
  check('add a widget from the library', (await page.locator('.panel-surface .tile').count()) === 1);
  await page.locator('.library input').fill('clock');
  await page.locator('.lib-item').first().dragTo(page.locator('.panel-surface .tile').first());
  await page.waitForTimeout(500);
  cfg = await stored(page);
  const added = cfg?.screens[0].pages[3]?.tiles[0];
  check('stack a widget on a tile by dragging', added?.widgets.map((w) => w.type).join(',') === 'core/text,core/clock', added?.widgets.map((w) => w.type).join(','));
  await page.locator('.library input').fill('');
  const srcNew = await page.$eval('.panel-img', (i) => i.src);
  await waitPreview(page, srcNew).catch(() => undefined);
  await shot(page, 'demo-editor-new-page.jpg');

  // Reload keeps the changes.
  await page.waitForTimeout(800);
  await page.reload();
  await page.waitForSelector('.screen-tab');
  await waitPreview(page);
  cfg = await stored(page);
  check('reload keeps the pages', cfg?.screens[0].pages.length === 4);
  await selectPage(page, 'Dashboard');
  check('reload keeps the changes', tileOf(cfg, 'tile-08')?.w === 4 && tileOf(cfg, 'tile-06')?.x === 14, `rail w ${tileOf(cfg, 'tile-08')?.w}, vitals x ${tileOf(cfg, 'tile-06')?.x}`);
  const railEl = await page.evaluate(() => {
    const t = document.querySelectorAll('.panel-surface .tile')[3];
    return t?.style.width;
  });
  check('the editor shows the kept layout', railEl && Math.abs(parseFloat(railEl) - ((4 * 80 - 10) / 1920) * 100) < 1, `rail width ${railEl}`);

  // Panel theme, editor light mode.
  await page.locator('.rail-btn').nth(3).click();
  await page.waitForSelector('.theme-swatch');
  await page.locator('.theme-swatch').nth(1).click();
  await page.locator('.segmented button', { hasText: 'Light' }).click();
  check('editor light mode', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light');
  await shot(page, 'demo-settings-light.jpg');
  await page.locator('.rail-btn').nth(0).click();
  await waitPreview(page);
  await page.waitForTimeout(1500);
  const themed = await imgStats(page, '.panel-img');
  check('panel theme repaints the preview', painted(themed) && themed.hash !== strip.hash, `theme ${(await stored(page))?.theme}`);
  await shot(page, 'demo-editor-light.jpg');

  // Spanish, from the top bar (in sight from the first moment, on the editor itself): editor,
  // banner and plugin texts.
  const menu = page.locator('.topbar .lang-menu select');
  check('the language is in the top bar, in sight on the editor', await menu.isVisible(), `${await menu.count()} language menus in the top bar`);
  await menu.selectOption({ label: 'Español' });
  await page.waitForFunction(() => document.querySelector('.demo-banner')?.textContent?.includes('El editor de Kiosko'), null, { timeout: 15_000 });
  check('banner follows the language', true);
  await page.waitForFunction(() => [...document.querySelectorAll('.lib-name')].some((e) => e.textContent?.includes('Reloj')), null, { timeout: 15_000 }).catch(() => undefined);
  const names = await page.$$eval('.lib-name', (l) => l.map((e) => e.textContent?.trim()));
  check('plugin texts in Spanish', names.includes('Reloj') && names.includes('Día del calendario'), names.slice(0, 6).join(', '));
  await page.waitForTimeout(1500);
  await shot(page, 'demo-editor-es.jpg');

  // Traditional Chinese: the editor's own words, the plugins' and the page's language (glyphs, CSS).
  await page.locator('.rail-btn').nth(3).click();
  await chooseLanguage(page, '繁體中文');
  await page.waitForFunction(() => document.querySelector('.demo-banner')?.textContent?.includes('Kiosko 編輯器'), null, { timeout: 15_000 }).catch(() => undefined);
  await page.locator('.rail-btn').nth(0).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.lib-name')].some((e) => e.textContent?.includes('時鐘')), null, { timeout: 15_000 }).catch(() => undefined);
  const zh = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    rail: [...document.querySelectorAll('.rail-btn')].map((e) => e.textContent?.trim()),
    names: [...document.querySelectorAll('.lib-name')].map((e) => e.textContent?.trim()),
  }));
  check('editor in Traditional Chinese', zh.lang === 'zh-Hant' && zh.rail.includes('編輯器') && zh.names.includes('時鐘'), `lang ${zh.lang}, ${zh.rail.join(' ')}, ${zh.names.slice(0, 4).join(', ')}`);
  await page.waitForTimeout(1500);
  await shot(page, 'demo-editor-zh-Hant.jpg');
  await page.locator('.rail-btn').nth(3).click();
  await chooseLanguage(page, 'Español');
  await page.locator('.rail-btn').nth(0).click();

  // Plugins page: every plugin listed.
  await page.locator('.rail-btn').nth(2).click();
  await page.waitForSelector('.plugin-card');
  const ids = await page.$$eval('.plugin-title small', (l) => l.map((e) => e.textContent?.split('·')[0]?.trim()));
  const official = [...BUNDLED_PLUGIN_IDS];
  const missing = ['core', 'legacy', ...official].filter((id) => !ids.includes(id));
  check('Plugins page lists every plugin', !missing.length && ids.length === 2 + official.length, `${ids.length} plugins${missing.length ? `, missing ${missing}` : ''}`);
  // Switching a plugin off takes its widgets out of the library; back on, back in.
  const count = async () => Number(await page.locator('.library .count').innerText().catch(() => 'NaN'));
  const cats = page.locator('.plugin-card', { hasText: 'cats · ' }).locator('[role=switch]');
  await cats.click();
  await page.waitForFunction(() => document.querySelector('.plugin-card.disabled'), null, { timeout: 10_000 });
  await page.locator('.rail-btn').nth(0).click();
  const without = await count();
  await page.locator('.rail-btn').nth(2).click();
  await page.locator('.plugin-card', { hasText: 'cats · ' }).locator('[role=switch]').click();
  await page.waitForFunction(() => !document.querySelector('.plugin-card.disabled'), null, { timeout: 10_000 });
  await page.locator('.rail-btn').nth(0).click();
  const back = await count();
  check('a plugin switched off leaves the library, and comes back', without < back, `${back} → ${without} → ${back} widgets`);
  await page.locator('.rail-btn').nth(2).click();
  await page.waitForSelector('.plugin-card');
  check('installing is disabled with a reason', (await page.locator('.plugin-grid ~ .grid-2 input[disabled]').count()) === 1 && (await page.locator('.demo-note').count()) >= 1);
  await shot(page, 'demo-plugins-es.jpg');

  // Screens and Activity.
  await page.locator('.rail-btn').nth(1).click();
  await page.waitForSelector('.screen-card');
  await page.waitForFunction(() => [...document.querySelectorAll('.live-thumb img')].length >= 2 && [...document.querySelectorAll('.live-thumb img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 20_000 });
  check('Screens view shows what each panel would show', true);
  await page.locator('.add-screen .btn').click();
  check('device discovery is disabled with a reason', await page.locator('.add-screen .menu-item[disabled]').count() === 1);
  await page.keyboard.press('Escape');
  await shot(page, 'demo-screens-es.jpg');
  await page.locator('.rail-btn').nth(4).click();
  await page.waitForSelector('.log-line');
  check('Activity shows the runtime log', (await page.locator('.log-line', { hasText: 'browser demo' }).count()) > 0);
  const failures = await page.$$eval('.log-line', (l) => l.map((e) => e.textContent ?? '').filter((t) => /failed|not available|problem/i.test(t)));
  check('no widget failed to paint (Activity)', !failures.length, failures.slice(0, 5).join(' | '));
  await shot(page, 'demo-activity-es.jpg');

  // Reset demo restores the showcase.
  page.once('dialog', (d) => d.accept());
  await page.locator('.demo-reset').click();
  await page.waitForLoadState('load');
  await page.waitForSelector('.demo-banner');
  await page.locator('.rail-btn').nth(0).click();
  await page.waitForSelector('.screen-tab');
  await waitPreview(page);
  await page.waitForTimeout(800);
  cfg = await stored(page);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const layout = (c) => c?.screens.map((s) => s.pages.map((p) => p.tiles.map((t) => [t.id, t.x, t.y, t.w, t.h])));
  const restored = cfg === null || (same(layout(cfg), layout(showcase)) && cfg.locale === 'auto' && cfg.theme === 'midnight');
  const bannerEn = await page.locator('.demo-banner').innerText();
  check('Reset demo restores the showcase', restored && /sample data/.test(bannerEn), cfg === null ? 'nothing stored' : 'stored config equals the showcase');

  check('no console errors in the session', errors.length === 0, errors.slice(0, 5).join(' | '));
  await ctx.close();

  // Phone width: the banner wraps, the editor stays usable.
  const phone = await openDemo(browser, { width: 420, height: 860 });
  await phone.page.waitForTimeout(1000);
  await shot(phone.page, 'demo-phone.jpg');
  check('phone width: no errors', phone.errors.length === 0, phone.errors.slice(0, 3).join(' | '));
  await phone.ctx.close();
}

// ---------- Smoke test (other browsers) ----------

async function smoke(browser, name) {
  const { ctx, page, errors } = await openDemo(browser);
  await waitThumbs(page).catch(() => undefined);
  const s = await imgStats(page, '.panel-img');
  const thumbs = await page.$$eval('.page-card img', (l) => l.filter((i) => i.complete && i.naturalWidth > 0).length);
  await shot(page, `demo-${name}.jpg`);
  await page.locator('.rail-btn').nth(3).click();
  const platform = await page.locator('.card .muted.small', { hasText: 'Kiosko' }).last().innerText().catch(() => '');
  check(`${name}: preview and page thumbnails paint`, painted(s) && thumbs === 3, `colours ${s?.colours}, ${thumbs} thumbnails; ${platform}`);
  check(`${name}: no console errors`, errors.length === 0, errors.slice(0, 5).join(' | '));
  await ctx.close();
}

// ---------- The front page (when the whole site was built: packages/web/build.mjs --site) ----------

const home = base.replace(/demo\/$/, '');
const hasFrontPage = existsSync(join(root, 'index.html')) && readFileSync(join(root, 'index.html'), 'utf8').includes('id="story"');

async function openFront(browser, { locale = 'en-US', width = 1440, height = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale });
  // No WebGL here: these containers draw it in software, minutes per frame. The page has to work
  // without it anyway (the panel is then a picture), and that is what gets checked. The scene
  // itself is looked at on a machine with a GPU: scripts/panel3d-film.mjs.
  await ctx.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      return /webgl/i.test(type) ? null : get.call(this, type, ...rest);
    };
  });
  const page = await ctx.newPage();
  // three.js reports the missing WebGL on the console before the page falls back: expected here.
  const all = watchErrors(page);
  const errors = () => all.filter((e) => !/THREE\.WebGLRenderer/.test(e));
  await page.goto(home);
  await page.waitForFunction(() => document.documentElement.classList.contains('no3d'), null, { timeout: 30_000 }).catch(() => undefined);
  return { ctx, page, errors };
}

/** The front page's languages (packages/sdk/src/languages.ts): where each lives, a browser locale that asks for it, and its headline (landing/i18n). */
const { LANGUAGES } = await import(new URL('../packages/sdk/src/languages.ts', import.meta.url).href);
const FRONT_LANGS = LANGUAGES.map((l) => {
  const words = JSON.parse(readFileSync(new URL(`../packages/web/landing/i18n/${l.id}.json`, import.meta.url), 'utf8'));
  const headline = words['the-little-screen-on-your'].replace(/<[^>]+>/g, '').trim();
  return { id: l.id, plugins: l.plugins, dir: l.id === 'en' ? '' : `${l.id}/`, locale: l.panel === 'en' ? 'en-US' : l.panel, headline: new RegExp(headline.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*')) };
});

/** What the page says: its address, its language and its headline. */
const frontState = (page) =>
  page.evaluate(() => ({
    path: location.pathname,
    lang: document.documentElement.lang,
    headline: document.querySelector('h1')?.textContent.trim() ?? '',
    // Each page is in one language: no second one hidden in it.
    leaked: document.querySelectorAll('main span[lang], main img[lang]').length,
  }));

async function frontPage(browser, name) {
  const { ctx, page, errors } = await openFront(browser);
  const en = await frontState(page);
  check(`${name} front page: in English by default`, en.lang === 'en' && /finally useful/i.test(en.headline) && en.leaked === 0, `lang ${en.lang}, "${en.headline}", ${en.leaked} texts of another language`);
  const pages = await page.evaluate(async (langs) => {
    const out = [];
    for (const l of langs) {
      const r = await fetch(l.dir || './');
      const html = r.ok ? await r.text() : '';
      out.push({ id: l.id, ok: r.ok && html.includes(`<html lang="${l.id}" `) && langs.every((o) => html.includes(`hreflang="${o.id}"`)) });
    }
    return out;
  }, FRONT_LANGS.map(({ id, dir }) => ({ id, dir })));
  check(`${name} front page: a page for each language, each pointing at the others`, pages.every((p) => p.ok), pages.filter((p) => !p.ok).map((p) => p.id).join(', '));

  // The picture fades in: wait for it to be there.
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.still')).opacity === '1', null, { timeout: 10_000 }).catch(() => undefined);
  const still = await page.evaluate(async () => {
    // The page's own language's picture.
    const img = document.querySelector('.still img');
    await img?.decode?.().catch(() => undefined);
    return { no3d: document.documentElement.classList.contains('no3d'), width: img?.naturalWidth ?? 0, opacity: getComputedStyle(document.querySelector('.still')).opacity };
  });
  check(`${name} front page: without WebGL the panel is a picture`, still.no3d && still.width > 0 && still.opacity === '1', JSON.stringify(still));
  await shot(page, `front-${name}.jpg`);

  // The plugins and the links: everything the page points at inside the site is there.
  const listed = await page.evaluate(async () => {
    const ok = async (url) => (await fetch(url)).ok;
    const cards = [...document.querySelectorAll('.plugin')];
    const pictures = [...document.querySelectorAll('.plugin img')].map((i) => i.src);
    const links = [...new Set([...document.querySelectorAll('a[href]')].map((a) => a.href).filter((h) => h.startsWith(location.origin) && !h.includes('#')))];
    // The picture for when the link is shared is named by its public address: here it is the same file.
    const card = document.querySelector('meta[property="og:image"]')?.content;
    if (card) links.push(new URL(new URL(card).pathname, location.origin).href);
    const missing = [];
    for (const url of [...pictures, ...links]) if (!(await ok(url))) missing.push(url);
    const store = document.querySelector('#plugins .cta a[href$="store/"]');
    return { cards: cards.length, pictures: pictures.length, links, missing, catalogue: (await (await fetch('gallery/gallery.json')).json()).plugins.length, store: store?.textContent ?? '' };
  });
  // A taste of the plugins (build.mjs: TEASER), each with its pictures, and the way to the store for the rest.
  check(`${name} front page: a few plugins with their pictures, and the way to the store`, listed.cards > 0 && listed.cards <= 8 && listed.cards <= listed.catalogue && listed.pictures >= listed.cards && /\d/.test(listed.store), `${listed.cards} cards of ${listed.catalogue} plugins, ${listed.pictures} pictures; store button "${listed.store}"`);
  check(`${name} front page: its links and its share picture lead somewhere`, listed.links.length >= 4 && listed.links.some((l) => l.endsWith('/card.jpg')) && listed.missing.length === 0, listed.missing.length ? `missing: ${listed.missing.slice(0, 4).join(', ')}` : `${listed.links.length} links`);

  // The editor's section: the real editor in a frame, composing a page by itself and keeping nothing.
  await page.locator('section[data-step="editor"]').evaluate((el) => window.scrollTo({ top: el.getBoundingClientRect().top + scrollY + innerHeight * 0.6, behavior: 'instant' }));
  let tiles = 0;
  let cursor = false;
  try {
    await page.waitForFunction(() => document.querySelector('.view iframe')?.src.includes('tour=1'), null, { timeout: 15_000 });
    const editor = page.frameLocator('.view iframe');
    // Its own page ("My desk", made blank by the tour) with two widgets already dropped on it.
    await editor.locator('.page-card.on', { hasText: 'My desk' }).waitFor({ state: 'attached', timeout: 60_000 });
    await editor.locator('.tile[data-tile]').nth(1).waitFor({ state: 'attached', timeout: 60_000 });
    await page.waitForTimeout(1500);
    tiles = await editor.locator('.tile[data-tile]').count();
    cursor = (await editor.locator('.tour-cursor').count()) === 1;
  } catch {
    /* reported below */
  }
  const kept = await page.evaluate(() => localStorage.getItem('kiosko.demo.config'));
  await shot(page, `front-editor-${name}.jpg`);
  check(`${name} front page: the editor composes a page by itself`, tiles >= 2 && cursor, `${tiles} tiles on its page, ${cursor ? 'a' : 'no'} ghost cursor`);
  check(`${name} front page: the editor on tour saves nothing`, kept === null);

  // The visitor's own config: read in the page, shown on the panel (a picture of its page, here), and
  // handed to the editor when asked.
  const bar = showcase.screens.find((x) => x.width / x.height > 2.5);
  const mine = { screens: [{ ...bar, id: 'mine', pages: bar.pages.slice(0, 1) }] };
  const file = (name, text) => ({ name, mimeType: 'application/json', buffer: Buffer.from(text) });
  const saidNow = () => page.locator('[data-yours="said"]').innerText().catch(() => '');
  const before = await imgStats(page, '.still img');
  await page.setInputFiles('[data-yours="file"]', file('mine.json', JSON.stringify(mine)));
  await page.waitForFunction(() => document.querySelector('.still img')?.src.startsWith('blob:'), null, { timeout: 60_000 }).catch(() => undefined);
  await page.waitForTimeout(800);
  const said = await saidNow();
  const shown = await imgStats(page, '.still img');
  const at = await page.evaluate(() => ({ step: document.documentElement.dataset.step, offered: !document.querySelector('[data-yours="loaded"]').hidden }));
  await shot(page, `front-yours-${name}.jpg`);
  check(`${name} front page: a config of your own is read and shown`, /mine\.json: 1 screen, 1 page/.test(said) && at.step === 'yours' && at.offered && painted(shown) && shown.hash !== before?.hash, `"${said}", section ${at.step}, picture ${shown?.src.slice(0, 5)} ${shown?.colours} colours`);
  await page.setInputFiles('[data-yours="file"]', file('package.json', '{"name":"something-else","version":"1.0.0"}'));
  await page.waitForFunction(() => document.querySelector('[data-yours="said"]')?.classList.contains('bad'), null, { timeout: 10_000 }).catch(() => undefined);
  const refused = await saidNow();
  check(`${name} front page: a file that is not a config is refused, and says why`, /isn't a Kiosko config/.test(refused) && !(await page.locator('[data-yours="loaded"]').isHidden()), `"${refused}"`);
  await page.locator('[data-yours="edit"]').click();
  await page.waitForURL(/\/demo\/(\?lang=[^#]*)?$/, { timeout: 15_000 }).catch(() => undefined);
  const handed = await stored(page);
  check(`${name} front page: "open it in the editor" hands the config to the demo`, /\/demo\/(\?lang=[^#]*)?$/.test(page.url()) && handed?.screens?.[0]?.id === 'mine', `${page.url()} with screens ${handed?.screens?.map((x) => x.id)}`);
  await page.evaluate(() => localStorage.removeItem('kiosko.demo.config'));
  await page.goto(home);

  // The Doom section: the recording of kiosko-plugin-doom loads when its section comes, and plays.
  await page.locator('section[data-step="doom"]').evaluate((el) => window.scrollTo({ top: el.getBoundingClientRect().top + scrollY + el.offsetHeight / 2 - innerHeight / 2, behavior: 'instant' }));
  await page.waitForFunction(() => (document.querySelector('video.doom')?.currentTime ?? 0) > 0.5, null, { timeout: 20_000 }).catch(() => undefined);
  const doom = await page.evaluate(() => {
    const v = document.querySelector('video.doom');
    return { step: document.documentElement.dataset.step, src: v?.currentSrc.split('/').pop() ?? '', t: v?.currentTime ?? 0, paused: v?.paused ?? true };
  });
  await shot(page, `front-doom-${name}.jpg`);
  check(`${name} front page: the Doom section plays its recording`, doom.step === 'doom' && /^doom\.(webm|mp4)/.test(doom.src) && doom.t > 0.5 && !doom.paused, `section ${doom.step}, ${doom.src || 'no video'} at ${doom.t.toFixed(1)} s${doom.paused ? ', paused' : ''}`);
  await page.evaluate(() => scrollTo(0, 0));

  // The menu: Spanish now, and still Spanish on the next visit to the English address.
  await page.locator('.lang summary').click();
  await page.locator('.lang a[data-lang="es"]').click();
  await page.waitForURL(/\/es\/$/, { timeout: 10_000 }).catch(() => undefined);
  const switched = await frontState(page);
  await page.goto(home);
  await page.waitForURL(/\/es\/$/, { timeout: 10_000 }).catch(() => undefined);
  const again = await frontState(page);
  check(`${name} front page: the menu changes the language, and it is remembered`, switched.lang === 'es' && /por fin útil/i.test(switched.headline) && again.lang === 'es', `"${switched.headline}", then ${again.lang} on the next visit`);
  check(`${name} front page: no errors`, errors().length === 0, errors().slice(0, 5).join(' | '));
  await ctx.close();

  // A browser that asks for another language gets that page without touching anything.
  for (const l of FRONT_LANGS.slice(1)) {
    const other = await openFront(browser, { locale: l.locale });
    await other.page.waitForURL((u) => u.pathname.endsWith(`/${l.dir}`), { timeout: 10_000 }).catch(() => undefined);
    const got = await frontState(other.page);
    check(`${name} front page: in ${l.id} for a browser in ${l.locale}`, got.lang === l.id && l.headline.test(got.headline) && other.errors().length === 0, `lang ${got.lang} at ${got.path}, "${got.headline}" ${other.errors().slice(0, 2).join(' | ')}`);
    if (l.plugins) {
      // Where a plugin's service is not offered (languages.ts), no card for it; local models first.
      const ids = await other.page.$$eval('.plugin h3 code', (c) => c.map((e) => e.textContent));
      check(`${name} front page: in ${l.id}, no ${l.plugins.without.join(', ')}; ${l.plugins.first.join(', ')} first`, ids.length > 0 && !ids.some((i) => l.plugins.without.includes(i)) && l.plugins.first.every((f, i) => ids[i] === f), ids.join(', '));
    }
    if (l.id.startsWith('zh')) await shot(other.page, `front-${l.id}-${name}.jpg`);
    await other.ctx.close();
  }

  // A phone: nothing wider than the window.
  const phone = await openFront(browser, { width: 390, height: 800 });
  const wide = await phone.page.evaluate(() => ({ page: document.documentElement.scrollWidth, window: innerWidth }));
  await shot(phone.page, `front-phone-${name}.jpg`);
  check(`${name} front page: fits a phone's width`, wide.page <= wide.window + 1 && phone.errors().length === 0, `${wide.page}px in a ${wide.window}px window ${phone.errors().slice(0, 3).join(' | ')}`);
  await phone.ctx.close();
}

// ---------- Main-thread cost: worker vs page ----------

async function longTasks(browser, query) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await ctx.addInitScript(() => {
    window.__long = [];
    new PerformanceObserver((l) => window.__long.push(...l.getEntries().map((e) => e.duration))).observe({ type: 'longtask', buffered: true });
  });
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto(`${base}${query}#/editor`);
  await page.waitForSelector('.screen-tab');
  await waitPreview(page);
  await waitThumbs(page);
  const ready = Date.now() - t0;
  // Scroll the library (thumbnails), switch pages, type in an option.
  await page.locator('.lib-list').evaluate((e) => e.scrollBy(0, 4000));
  await page.waitForTimeout(1500);
  for (const name of ['Cats', 'News', 'Dashboard']) await selectPage(page, name);
  await page.locator('.panel-surface .tile').nth(0).click();
  const typing = await page.evaluate(() => window.__long.length);
  await page.locator('#w-title').pressSequentially('Hello panel', { delay: 60 });
  await page.waitForTimeout(1500);
  const r = await page.evaluate((n) => ({ all: window.__long, typing: window.__long.slice(n) }), typing);
  await ctx.close();
  const sum = (l) => Math.round(l.reduce((a, b) => a + b, 0));
  return { ready, count: r.all.length, total: sum(r.all), max: Math.round(Math.max(0, ...r.all)), typingTotal: sum(r.typing), typingMax: Math.round(Math.max(0, ...r.typing)) };
}

const hasStore = existsSync(join(root, 'store/v1/index.json'));

/** The plugin store (landing/store.mjs): every plugin it offers has its card, the filters work, a plugin's page opens in Kiosko and its links lead somewhere. */
async function storePages(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(`${home}es/store/`);
  const list = await page.evaluate(async () => {
    const index = await (await fetch('../../store/v1/index.json')).json();
    const cards = [...document.querySelectorAll('article.card')];
    const pictures = [...document.querySelectorAll('article.card img')];
    // They load lazily: brought into view one by one, as a visitor scrolling would (a lazy picture far away never decodes).
    for (const i of pictures) {
      i.scrollIntoView({ block: 'center' });
      await i.decode?.().catch(() => undefined);
    }
    scrollTo(0, 0);
    return { cards: cards.length, offered: index.plugins.filter((p) => !p.hidden).length, broken: pictures.filter((i) => !i.naturalWidth).map((i) => i.getAttribute('src')), count: document.querySelector('.count')?.textContent };
  });
  check(`${name} store: a card for every plugin, with its picture`, list.cards > 0 && list.cards === list.offered && list.broken.length === 0, `${list.cards} cards of ${list.offered}${list.broken.length ? `, broken: ${list.broken.slice(0, 3).join(', ')}` : ''}`);
  await page.fill('input.search', 'tiempo');
  await page.waitForTimeout(200);
  const searched = await page.evaluate(() => ({ shown: [...document.querySelectorAll('article.card')].filter((c) => !c.hidden).map((c) => c.dataset.id), url: location.search }));
  check(`${name} store: search filters the cards and keeps it in the address`, searched.shown.includes('weather') && searched.shown.length < list.cards && searched.url.includes('q=tiempo'), JSON.stringify(searched));
  await page.fill('input.search', '');
  await page.selectOption('select[name="panel"]', 'class:portrait');
  const portrait = await page.evaluate(() => [...document.querySelectorAll('article.card')].filter((c) => !c.hidden).length);
  check(`${name} store: the panel filter`, portrait > 0 && portrait <= list.cards, `${portrait} for portrait panels`);
  await shot(page, `store-${name}.jpg`);
  await page.goto(`${home}es/store/weather/`);
  const sheet = await page.evaluate(async () => {
    const ok = async (url) => (await fetch(url)).ok;
    const links = [...new Set([...document.querySelectorAll('a[href]')].map((a) => a.href).filter((h) => h.startsWith(location.origin)))];
    const missing = [];
    for (const url of links) if (!(await ok(url))) missing.push(url);
    const imgs = [...document.querySelectorAll('img')].filter((i) => i.getClientRects().length);
    for (const i of imgs) {
      i.scrollIntoView({ block: 'center' });
      await i.decode?.().catch(() => undefined);
    }
    return { open: document.querySelector('.install a.button')?.getAttribute('href'), missing, broken: imgs.filter((i) => !i.naturalWidth).length, h1: document.querySelector('h1')?.textContent };
  });
  check(`${name} store: a plugin's page, "Open in Kiosko" and its links`, sheet.open === 'http://127.0.0.1:7420/#/plugins/store/weather' && sheet.missing.length === 0 && sheet.broken === 0, JSON.stringify(sheet));
  await shot(page, `store-weather-${name}.jpg`);
  check(`${name} store: no errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

try {
  for (const name of browsers) {
    const browser = await playwright[name].launch();
    console.log(`\n== ${name} ${browser.version()}`);
    try {
      if (name === 'chromium') {
        await fullCheck(browser);
        await pageLanguage(browser);
        if (measure) {
          for (const [label, q] of [['worker', ''], ['page', '?render=page']]) {
            const m = await longTasks(browser, q);
            console.log(`     main-thread long tasks, runtime in the ${label}: ready in ${m.ready} ms; ${m.count} tasks, ${m.total} ms total, longest ${m.max} ms; while typing ${m.typingTotal} ms (longest ${m.typingMax} ms)`);
          }
        }
      } else await smoke(browser, name);
      if (hasFrontPage) await frontPage(browser, name);
      if (hasStore) await storePages(browser, name);
    } finally {
      await browser.close();
    }
  }
} finally {
  server.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
