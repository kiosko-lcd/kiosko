// End-to-end check of the static browser demo (site/demo): serves it as
// GitHub Pages would (under /demo/), drives it with Playwright and takes
// screenshots. Run it through scripts/demo-check-docker.sh, which builds the
// demo and runs this inside the Playwright container: nothing is installed
// on your machine.
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

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ttf': 'font/ttf', '.gz': 'application/gzip', '.txt': 'text/plain' };
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
  page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
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

  // Spanish: editor, banner and plugin texts.
  await page.locator('.rail-btn').nth(3).click();
  await page.locator('.segmented button', { hasText: 'Español' }).click();
  await page.waitForFunction(() => document.querySelector('.demo-banner')?.textContent?.includes('El editor de Kiosko'), null, { timeout: 15_000 });
  check('banner follows the language', true);
  await page.locator('.rail-btn').nth(0).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.lib-name')].some((e) => e.textContent?.includes('Reloj')), null, { timeout: 15_000 }).catch(() => undefined);
  const names = await page.$$eval('.lib-name', (l) => l.map((e) => e.textContent?.trim()));
  check('plugin texts in Spanish', names.includes('Reloj') && names.includes('Día del calendario'), names.slice(0, 6).join(', '));
  await page.waitForTimeout(1500);
  await shot(page, 'demo-editor-es.jpg');

  // Plugins page: every plugin listed.
  await page.locator('.rail-btn').nth(2).click();
  await page.waitForSelector('.plugin-card');
  const ids = await page.$$eval('.plugin-title small', (l) => l.map((e) => e.textContent?.split('·')[0]?.trim()));
  const official = ['agents', 'cats', 'system', 'vitals', 'usage', 'weather', 'calendar', 'news', 'mirror', 'gitlab', 'github', 'calls', 'timesheet', 'llm', 'gpu'];
  const missing = ['core', 'legacy', ...official].filter((id) => !ids.includes(id));
  check('Plugins page lists every plugin', !missing.length && ids.length === 17, `${ids.length} plugins${missing.length ? `, missing ${missing}` : ''}`);
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
  const restored = cfg === null || (same(layout(cfg), layout(showcase)) && cfg.locale === 'en' && cfg.theme === 'midnight');
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

try {
  for (const name of browsers) {
    const browser = await playwright[name].launch();
    console.log(`\n== ${name} ${browser.version()}`);
    try {
      if (name === 'chromium') {
        await fullCheck(browser);
        if (measure) {
          for (const [label, q] of [['worker', ''], ['page', '?render=page']]) {
            const m = await longTasks(browser, q);
            console.log(`     main-thread long tasks, runtime in the ${label}: ready in ${m.ready} ms; ${m.count} tasks, ${m.total} ms total, longest ${m.max} ms; while typing ${m.typingTotal} ms (longest ${m.typingMax} ms)`);
          }
        }
      } else await smoke(browser, name);
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
