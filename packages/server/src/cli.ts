#!/usr/bin/env node
/**
 * `kiosko` command line.
 *
 *   kiosko start [--port 7420] [--host 127.0.0.1] [--config file] [--open] [--demo]
 *   kiosko render [--screen id|name] [--page id|name] [--out frame.png] [--live]
 *   kiosko import-aimonitor [--from ~/.aimonitor/config.json] [--with-secrets] [--write]
 *   kiosko config schema|validate|import …   (see config-cli.ts)
 *   kiosko doctor
 *   kiosko usb [list|test]
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Registry, Runtime, installSdkResolver, listUsb, loadConfig, paths, saveConfig, type Config } from '@kiosko/core';
import { BUILTIN_PLUGINS, OFFICIAL_PLUGINS } from './builtin.ts';
import { configCommand } from './config-cli.ts';
import { pluginsCommand } from './plugins-cli.ts';
import { writePreview } from './preview.ts';
import { buildGallery } from './gallery.ts';
import { importAimonitor } from './import-aimonitor.ts';
import { runService, servicePlan } from './service.ts';
import { startServer } from './server.ts';
import { starterConfig } from './starter.ts';

const VERSION = '0.2.0';
const USAGE = `Kiosko ${VERSION}: a widget mosaic for USB LCD panels

  kiosko start [--port 7420] [--host 127.0.0.1] [--config file] [--open] [--demo]
  kiosko render [--screen id|name] [--page id|name] [--out frame.png] [--live]
  kiosko import-aimonitor [--from ~/.aimonitor/config.json] [--with-secrets] [--write]
  kiosko config schema [--out file]          JSON Schema of config.json, with your plugins
  kiosko config validate <file> [--json]     check a config (e.g. one an AI wrote)
  kiosko config import <file> [--apply]      review it (changes, preview, risky values) and use it
  kiosko doctor
  kiosko usb [list]                          the LY panels libusb sees, with their serial numbers
  kiosko usb test [--serial S] [--seconds 10] [--size 1920x462] [--rotate 180]
                                             drive a panel with the sample screen (experimental)
  kiosko gallery [--out gallery] [--locale en] [--theme midnight]
  kiosko plugins [list|add <id>…|link <folder>…|remove <id>…]
  kiosko service install|uninstall|print   (start with your session)
  kiosko version`;
const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'start';
const flag = (name: string) => argv.includes(name);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

async function registry(): Promise<Registry> {
  // The official plugins, installed with npm next to this CLI, import the SDK and the canvas:
  // point them at ours. (`loadDir` does it too, but only when the user's plugins folder exists,
  // which on a fresh install it doesn't.)
  installSdkResolver();
  const r = new Registry();
  for (const p of BUILTIN_PLUGINS) r.add(p);
  // The plugins folder first: a linked checkout overrides the bundled copy.
  await r.loadDir(paths.plugins);
  for (const o of OFFICIAL_PLUGINS) {
    if (r.plugin(o.id)) continue;
    try {
      const mod = (await import(import.meta.resolve(o.npm))) as { default?: Parameters<Registry['add']>[0] };
      if (mod.default) r.add(mod.default, `npm:${o.npm}`);
    } catch {
      /* not installed: the editor offers it */
    }
  }
  for (const pr of r.problems) console.warn(`plugin ${pr.origin}: ${pr.message}`);
  return r;
}

async function config(reg: Registry, path: string): Promise<Config> {
  const { config: cfg, exists, error } = loadConfig(path);
  if (error) {
    console.error(`config ${path} is not valid JSON (${error}); not touching it. Fix it or move it away.`);
    process.exit(1);
  }
  if (exists) return cfg;
  const starter = starterConfig(reg, { locale: Intl.DateTimeFormat().resolvedOptions().locale });
  saveConfig(starter, path);
  console.log(`created ${path} with a starter screen`);
  return starter;
}

function openBrowser(url: string): void {
  const [bin, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    spawn(bin, args as string[], { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* no browser: the URL is printed anyway */
  }
}

async function main(): Promise<void> {
  const path = opt('--config') ?? paths.config;
  switch (cmd) {
    case 'start': {
      const reg = await registry();
      const cfg = await config(reg, path);
      const host = opt('--host') ?? cfg.server.host;
      const port = Number(opt('--port') ?? cfg.server.port);
      const rt = new Runtime(reg, cfg, { demo: flag('--demo') });
      if (flag('--demo')) console.log('demo mode: every widget shows sample data, nothing is read');
      rt.start();
      const srv = startServer({ runtime: rt, host, port, configPath: path, version: VERSION });
      const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`;
      console.log(`Kiosko ${VERSION} — editor at ${url}`);
      console.log(`config: ${path}`);
      if (flag('--open')) openBrowser(url);
      const stop = () => {
        rt.stop();
        srv.close();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return;
    }
    case 'render': {
      process.env.KIOSKO_QUIET ??= '1';
      const reg = await registry();
      const cfg = loadConfig(path).config;
      const want = opt('--screen');
      const screen = cfg.screens.find((s) => !want || s.id === want || s.name === want) ?? starterConfig(reg).screens[0]!;
      const wantPage = opt('--page');
      const page = screen.pages.find((p) => !wantPage || p.id === wantPage || p.name === wantPage) ?? screen.pages[0]!;
      const rt = new Runtime(reg, cfg);
      if (flag('--live')) {
        // Let the data come in for a few seconds before painting.
        rt.apply(cfg);
        const until = Date.now() + Number(opt('--wait') ?? 4000);
        while (Date.now() < until) {
          rt.hub.tick(cfg, Date.now());
          rt.fetches.tick(cfg, Date.now());
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      const out = opt('--out') ?? 'frame.png';
      const problems = writePreview(rt, screen, page, out, { demo: !flag('--live') });
      rt.stop();
      console.log(`${out}  ${screen.width}×${screen.height}  page "${page.name}"`);
      for (const p of problems) console.log(`  ${p}`);
      return;
    }
    case 'import-aimonitor': {
      const from = opt('--from') ?? `${process.env.HOME ?? ''}/.aimonitor/config.json`;
      if (!existsSync(from)) {
        console.error(`not found: ${from}`);
        process.exit(1);
      }
      const reg = await registry();
      const modePath = join(dirname(from), 'modo');
      const modeOverride = existsSync(modePath) ? readFileSync(modePath, 'utf8') : null;
      const { config: imported, notes } = importAimonitor(JSON.parse(readFileSync(from, 'utf8')), reg, modeOverride, { withSecrets: flag('--with-secrets') });
      if (modeOverride) notes.push(`mode from ${modePath}: ${modeOverride.trim()}`);
      for (const n of notes) console.log(`- ${n}`);
      if (flag('--write')) {
        if (existsSync(path)) writeFileSync(`${path}.bak`, readFileSync(path));
        saveConfig(imported, path);
        console.log(`written ${path}${existsSync(`${path}.bak`) ? ` (previous one in ${path}.bak)` : ''}`);
      } else {
        console.log(JSON.stringify(imported, null, 2));
        console.log('\n(dry run: add --write to save it)');
      }
      return;
    }
    case 'usb': {
      if (argv[1] === 'test') {
        process.env.KIOSKO_QUIET ??= '1';
        const reg = await registry();
        const [w, h] = (opt('--size') ?? '1920x462').split('x').map(Number) as [number, number];
        const cfg = starterConfig(reg, { width: w || 1920, height: h || 462 });
        const screen = cfg.screens[0]!;
        screen.device = { driver: 'usb', ...(opt('--serial') ? { serial: opt('--serial')! } : {}) };
        screen.rotate = Number(opt('--rotate') ?? 0) as 0 | 90 | 180 | 270;
        const rt = new Runtime(reg, cfg, { demo: true });
        rt.start();
        const seconds = Number(opt('--seconds') ?? 10);
        let ok = false;
        for (let i = 0; i < seconds; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          const d = rt.status().screens[0]?.device;
          ok ||= !!d?.ok;
          console.log(`${String(i + 1).padStart(2)} s  ${d?.ok ? 'ok ' : 'ERR'}  ${d?.message ?? ''}  frames ${d?.framesSent ?? 0}`);
        }
        rt.stop();
        process.exitCode = ok ? 0 : 1;
        return;
      }
      const usb = await listUsb();
      if (!usb.ok) console.log(`usb not available: ${usb.error}`);
      else if (!usb.panels.length) console.log('no LY panel (0416:5408/5409) plugged in');
      for (const p of usb.panels) console.log(`LY panel ${p.pid.toString(16)} at ${p.location}, serial ${p.serial ?? '(unreadable)'}${p.error ? `  ✗ ${p.error}` : ''}`);
      return;
    }
    case 'doctor': {
      const reg = await registry();
      const { config: cfg, exists, error } = loadConfig(path);
      console.log(`Kiosko ${VERSION} on ${process.platform}/${process.arch}, Node ${process.version}`);
      console.log(`config  ${path} ${exists ? (error ? `INVALID: ${error}` : 'ok') : '(not created yet)'}`);
      console.log(`plugins ${reg.list().map((p) => p.def.id).join(', ')}`);
      for (const p of reg.problems) console.log(`  ✗ ${p.origin}: ${p.message}`);
      const usb = await listUsb();
      if (!usb.ok) console.log(`usb     not available: ${usb.error}`);
      else if (!usb.panels.length) console.log('usb     no LY panel (0416:5408/5409) plugged in');
      for (const p of usb.panels) console.log(`usb     LY panel ${p.pid.toString(16)} at ${p.location}, serial ${p.serial ?? '(unreadable)'}${p.error ? `  ✗ ${p.error}` : ''}`);
      for (const s of cfg.screens) {
        const missing = s.pages.flatMap((p) => p.tiles.flatMap((t) => t.widgets.filter((w) => !reg.widget(w.type)).map((w) => w.type)));
        console.log(`screen  ${s.name} ${s.width}×${s.height} ${s.device.driver}${missing.length ? `  ✗ unknown widgets: ${[...new Set(missing)].join(', ')}` : ''}`);
      }
      return;
    }
    case 'service': {
      const pass = ['--port', '--host', '--config'].flatMap((f) => (opt(f) ? [f, opt(f)!] : []));
      const env: Record<string, string> = process.env.KIOSKO_HOME ? { KIOSKO_HOME: process.env.KIOSKO_HOME } : {};
      runService(argv[1] ?? 'print', servicePlan({ args: pass, env }));
      return;
    }
    case 'gallery': {
      process.env.KIOSKO_QUIET ??= '1';
      const reg = await registry();
      const out = opt('--out') ?? 'gallery';
      const n = buildGallery(reg, { out, locale: opt('--locale') ?? 'en', theme: opt('--theme') ?? 'midnight' });
      console.log(`${n} widgets → ${out}/index.html`);
      return;
    }
    case 'plugins': {
      process.env.KIOSKO_QUIET ??= '1';
      await pluginsCommand(argv.slice(1), registry);
      return;
    }
    case 'config': {
      process.env.KIOSKO_QUIET ??= '1';
      process.exitCode = await configCommand(argv.slice(1), { registry, configPath: path });
      return;
    }
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return;
    case 'version':
    case '--version':
      console.log(VERSION);
      return;
    default:
      console.log(USAGE);
  }
}

await main();
