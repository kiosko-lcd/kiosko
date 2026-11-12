#!/usr/bin/env node
// Photographs or films the 3D page (packages/web/panel3d): a panel showing a
// page, or one widget at work, for a README, the site or a post.
//
//   node scripts/panel3d-film.mjs [options] <name>=<query> …
//
//   cats="widget=cats/room&az=-20"       a picture, out/cats.png
//   --seconds 12 stack="panels=3"        a film, out/stack.webm
//
//   --seconds <n>   film for n seconds (WebM) instead of taking a picture
//   --wait <n>      seconds to let it run first (default 6: powered on, something moving)
//   --size <WxH>    of the picture or film (default 1280x720)
//   --out <dir>     where to write (default ./out)
//   --site <dir>    a built demo (node packages/web/build.mjs --demo --out <dir>); built to a
//                   temporary folder when not given
//   --hud           keep the captions and buttons (hidden by default)
//   --card          instead: the picture that goes with the site's link when it is shared,
//                   packages/web/landing/card.jpg (the front page with ?card, 1200x630)
//
// The query is the page's own (see panel3d/main.ts): widget=, page=, panels=3,
// lang=, az=, el=, zoom=, orbit=0, sway=, turn=, animate=, interlude=, q=…
//
// A film whose camera sways there and back in its own length loops without a
// jump (--seconds 8 … "sway=28,8"), which is how the README's moving picture
// is made; ffmpeg turns the WebM into an animated WebP:
//   ffmpeg -i out/clip.webm -t 8 -vf fps=15,scale=800:-2 -c:v libwebp -q:v 55 -loop 0 -an docs/img/panel-3d.webp
//
// It drives a Chrome or Chromium already on this machine, headless and on the
// real GPU (a software renderer takes minutes per frame), over the DevTools
// protocol: nothing to install. CHROME=/path/to/chrome picks one.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const [, v] = args.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};
const seconds = Number(opt('--seconds', 0));
const wait = Number(opt('--wait', 6));
const card = flag('--card');
const [width, height] = opt('--size', card ? '1200x630' : '1280x720').split('x').map(Number);
const out = resolve(opt('--out', card ? join(root, 'packages/web/landing') : 'out'));
const hud = flag('--hud');
let site = opt('--site');
const shots = card
  ? [{ name: 'card', query: 'card=1' }]
  : args.map((a) => {
      const i = a.indexOf('=');
      return i < 0 ? { name: a, query: '' } : { name: a.slice(0, i), query: a.slice(i + 1) };
    });
if (!shots.length || !(width > 0 && height > 0)) {
  console.error('usage: node scripts/panel3d-film.mjs [--seconds n] [--wait n] [--size WxH] [--out dir] [--site dir] [--hud] <name>=<query> …\n       node scripts/panel3d-film.mjs --card [--wait n] [--out dir] [--site dir]');
  process.exit(2);
}

const chromePath =
  process.env.CHROME ??
  ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((c) =>
    c.startsWith('/') ? existsSync(c) : spawnSync('which', [c]).status === 0,
  );
if (!chromePath) {
  console.error('No Chrome or Chromium found on this machine: set CHROME=/path/to/chrome.');
  process.exit(1);
}

const scratch = mkdtempSync(join(tmpdir(), 'kiosko-3d-'));
// Undone in reverse order at the end; each may take its time (Chrome has to be gone before its profile can be).
const cleanup = [() => rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
try {
  // The 3D page is part of the demo; the card is the front page, which takes the whole site.
  if (!site) {
    site = join(scratch, 'site');
    const built = spawnSync(process.execPath, [join(root, 'packages/web/build.mjs'), card ? '--site' : '--demo', '--out', site], { encoding: 'utf8' });
    if (built.status !== 0) throw new Error(`could not build the ${card ? 'site' : 'demo'}:\n${built.stderr}`);
  }
  site = resolve(site);
  if (card && !existsSync(join(site, 'demo/assets/landing.js'))) throw new Error(`${site} is not a built site (node packages/web/build.mjs --site --out <dir>)`);
  if (!card && !existsSync(join(site, '3d/index.html'))) throw new Error(`${site} is not a built demo (no 3d/index.html)`);
  mkdirSync(out, { recursive: true });

  // The built demo, served from this machine only.
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.gz': 'application/gzip', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };
  const server = createServer(async (req, res) => {
    let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (p.endsWith('/')) p += 'index.html';
    try {
      const body = await readFile(join(site, p));
      res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => server.close());
  const { port } = server.address();

  // Chrome, headless, with its own throwaway profile.
  const chrome = spawn(
    chromePath,
    ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(scratch, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', '--ignore-gpu-blocklist', '--enable-gpu', ...(process.platform === 'linux' ? ['--use-angle=gl-egl'] : []), 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  cleanup.push(() => new Promise((gone) => (chrome.exitCode !== null ? gone() : (chrome.once('exit', gone), chrome.kill()))));
  const endpoint = await new Promise((ok, fail) => {
    let log = '';
    chrome.stderr.on('data', (d) => {
      log += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(log);
      if (m) ok(m[1]);
    });
    chrome.on('exit', (code) => fail(new Error(`Chrome exited (${code}): ${log.slice(-300)}`)));
    setTimeout(() => fail(new Error('Chrome did not start')), 20_000);
  });

  // The DevTools protocol, by hand: commands with an id, answers with the same id.
  const ws = new WebSocket(endpoint);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = () => fail(new Error('could not reach Chrome'));
  });
  cleanup.push(() => ws.close());
  let seq = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const p = m.id && pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      if (m.error) p.fail(new Error(m.error.message));
      else p.ok(m.result);
    } else for (const l of listeners) l(m);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((ok, fail) => {
      const id = ++seq;
      pending.set(id, { ok, fail });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  for (const { name, query } of shots) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const tab = (method, params) => send(method, params, sessionId);
    const problems = [];
    const watch = (m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.exceptionThrown') problems.push((m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).split('\n')[0]);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    };
    listeners.add(watch);
    await tab('Page.enable');
    await tab('Runtime.enable');
    await tab('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const evaluate = async (expression) => {
      const r = await tab('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const q = new URLSearchParams(query);
    if (!card && !hud && !q.has('clean')) q.set('clean', '1');
    await tab('Page.navigate', { url: `http://127.0.0.1:${port}/${card ? '' : '3d/'}?${q}` });
    // The 3D page says when it is ready; the front page, when its panel has been drawn.
    const isReady = card ? 'document.documentElement.classList.contains("live3d")' : 'document.body?.classList.contains("ready") ?? false';
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      await sleep(500);
      ready = await evaluate(isReady).catch(() => false);
    }
    if (!ready) {
      failed = true;
      console.error(`${name}: the page did not start: ${await evaluate('document.querySelector(".status")?.textContent ?? ""').catch(() => '?')} ${problems.join(' | ')}`);
    } else {
      await sleep(wait * 1000);
      if (seconds > 0) {
        const video = await evaluate(`window.kiosko3d.film(${seconds * 1000})`);
        const file = join(out, `${name}.${video.startsWith('data:video/mp4') ? 'mp4' : 'webm'}`);
        writeFileSync(file, Buffer.from(video.slice(video.indexOf(',') + 1), 'base64'));
        console.log(file);
      } else {
        // The card is fetched by every chat it is pasted in: a JPEG weighs a tenth of the PNG.
        const { data } = await tab('Page.captureScreenshot', card ? { format: 'jpeg', quality: 88 } : { format: 'png' });
        const file = join(out, `${name}.${card ? 'jpg' : 'png'}`);
        writeFileSync(file, Buffer.from(data, 'base64'));
        console.log(file);
      }
      if (problems.length) console.error(`${name}: the page reported: ${[...new Set(problems)].slice(0, 5).join(' | ')}`);
    }
    listeners.delete(watch);
    await send('Target.closeTarget', { targetId });
  }
} catch (err) {
  failed = true;
  console.error(err instanceof Error ? err.message : err);
} finally {
  for (const f of cleanup.reverse()) {
    try {
      await f();
    } catch {
      /* already gone */
    }
  }
}
process.exit(failed ? 1 : 0);
