#!/usr/bin/env node
/**
 * `tessera` command line.
 *
 *   tessera start [--port 7420] [--host 127.0.0.1] [--config file] [--open] [--demo]
 *   tessera render [--screen id|name] [--page id|name] [--out frame.png] [--live]
 *   tessera import-aimonitor [--from ~/.aimonitor/config.json] [--write]
 *   tessera doctor
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Registry, Runtime, loadConfig, paths, saveConfig, type Config } from '@tessera/core';
import { BUILTIN_PLUGINS } from './builtin.ts';
import { importAimonitor } from './import-aimonitor.ts';
import { runService, servicePlan } from './service.ts';
import { startServer } from './server.ts';
import { starterConfig } from './starter.ts';

const VERSION = '0.1.0';
const USAGE = `Tessera ${VERSION}: a widget mosaic for USB LCD panels

  tessera start [--port 7420] [--host 127.0.0.1] [--config file] [--open] [--demo]
  tessera render [--screen id|name] [--page id|name] [--out frame.png] [--live]
  tessera import-aimonitor [--from ~/.aimonitor/config.json] [--write]
  tessera doctor
  tessera service install|uninstall|print   (start with your session)
  tessera version`;
const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'start';
const flag = (name: string) => argv.includes(name);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

async function registry(): Promise<Registry> {
  const r = new Registry();
  for (const p of BUILTIN_PLUGINS) r.add(p);
  await r.loadDir(paths.plugins);
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
      console.log(`Tessera ${VERSION} — editor at ${url}`);
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
      process.env.TESSERA_QUIET ??= '1';
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
      const r = rt.preview(screen, page, { demo: !flag('--live') });
      const out = opt('--out') ?? 'frame.png';
      writeFileSync(out, r.canvas.toBuffer('image/png'));
      rt.stop();
      console.log(`${out}  ${screen.width}×${screen.height}  page "${page.name}"`);
      for (const t of r.tiles) if (t.error) console.log(`  tile ${t.id}: ${t.error}`);
      return;
    }
    case 'import-aimonitor': {
      const from = opt('--from') ?? `${process.env.HOME ?? ''}/.aimonitor/config.json`;
      if (!existsSync(from)) {
        console.error(`not found: ${from}`);
        process.exit(1);
      }
      const reg = await registry();
      const { config: imported, notes } = importAimonitor(JSON.parse(readFileSync(from, 'utf8')), reg);
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
    case 'doctor': {
      const reg = await registry();
      const { config: cfg, exists, error } = loadConfig(path);
      console.log(`Tessera ${VERSION} on ${process.platform}/${process.arch}, Node ${process.version}`);
      console.log(`config  ${path} ${exists ? (error ? `INVALID: ${error}` : 'ok') : '(not created yet)'}`);
      console.log(`plugins ${reg.list().map((p) => p.def.id).join(', ')}`);
      for (const p of reg.problems) console.log(`  ✗ ${p.origin}: ${p.message}`);
      for (const s of cfg.screens) {
        const missing = s.pages.flatMap((p) => p.tiles.flatMap((t) => t.widgets.filter((w) => !reg.widget(w.type)).map((w) => w.type)));
        console.log(`screen  ${s.name} ${s.width}×${s.height} ${s.device.driver}${missing.length ? `  ✗ unknown widgets: ${[...new Set(missing)].join(', ')}` : ''}`);
      }
      return;
    }
    case 'service': {
      const pass = ['--port', '--host', '--config'].flatMap((f) => (opt(f) ? [f, opt(f)!] : []));
      const env: Record<string, string> = process.env.TESSERA_HOME ? { TESSERA_HOME: process.env.TESSERA_HOME } : {};
      runService(argv[1] ?? 'print', servicePlan({ args: pass, env }));
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
