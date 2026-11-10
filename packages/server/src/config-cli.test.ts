import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { configSchema, Registry, validateConfig } from '@kiosko/core';
import { BUILTIN_PLUGINS, OFFICIAL_PLUGINS } from './builtin.ts';
import { readConfigText } from './config-cli.ts';
import { starterConfig } from './starter.ts';

const root = resolve(import.meta.dirname, '../../..');

/** Built-in plugins plus the official ones that are installed (CI clones none). */
async function registry(): Promise<Registry> {
  const r = new Registry();
  for (const p of BUILTIN_PLUGINS) r.add(p);
  for (const o of OFFICIAL_PLUGINS) {
    try {
      const mod = (await import(import.meta.resolve(o.npm))) as { default?: Parameters<Registry['add']>[0] };
      if (mod.default) r.add(mod.default, o.npm);
    } catch {
      /* not installed */
    }
  }
  return r;
}

const reg = await registry();
const plugins = reg.list().map((p) => p.def);
const schema = configSchema(plugins);

test('the starter config is valid, without warnings', () => {
  const r = validateConfig(JSON.parse(JSON.stringify(starterConfig(reg))), plugins, schema);
  assert.deepEqual(r, { errors: [], warnings: [] });
});

for (const name of readdirSync(join(root, 'examples')).filter((f) => f.endsWith('.json'))) {
  const cfg = JSON.parse(readFileSync(join(root, 'examples', name), 'utf8')) as { screens?: { pages?: { tiles?: { widgets?: { type: string }[] }[] }[] }[] };
  const missing = [...new Set((cfg.screens ?? []).flatMap((s) => (s.pages ?? []).flatMap((p) => (p.tiles ?? []).flatMap((t) => (t.widgets ?? []).map((w) => w.type)))))].filter((type) => !reg.widget(type));
  test(`examples/${name} is valid`, { skip: missing.length ? `plugins not installed for ${missing.join(', ')}` : false }, () => {
    const r = validateConfig(cfg, plugins, schema);
    assert.deepEqual(r.errors, []);
  });
}

/** `x-risk` of every option of every widget, source and interlude, as `{ type: { 'feeds[].url': 'network' } }`. */
function risksBy(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  const walk = (type: string, s: Record<string, any> | undefined, path: string) => {
    if (!s) return;
    if (s['x-risk'] !== undefined) (out[type] ??= {})[path] = s['x-risk'];
    for (const [k, sub] of Object.entries((s.properties ?? {}) as Record<string, any>)) walk(type, sub, path ? `${path}.${k}` : k);
    if (s.items) walk(type, s.items, `${path}[]`);
  };
  const d = schema.$defs as Record<string, any>;
  for (const b of [...d.widget.oneOf, ...(d.interlude.oneOf ?? [])]) walk(b.properties.type.const, b.properties.options, '');
  for (const [type, s] of Object.entries((schema.properties as any).sources.properties as Record<string, any>)) walk(type, s, '');
  return out;
}

// Values that run programs, contact hosts or read paths. A new risky option
// must be added here (and marked with `risk` in its plugin).
const EXPECTED_RISKS: Record<string, Record<string, unknown>> = {
  'core/text': { file: 'path' },
  'core/image': { src: ['network', 'path'] },
  'legacy/module': { module: 'exec', dir: 'exec' },
  'agents/sessions': { dir: 'path' },
  'system/health': { 'mounts[]': 'path' },
  'system/vitals': { diskPath: 'path' },
  'usage/ccusage': { bin: 'exec' },
  'calendar/events': { 'urls[]': 'network' },
  'news/deck': { 'feeds[].url': 'network' },
  'mirror/tasks': { file: 'path', bin: 'exec' },
  'gitlab/merge-requests': { host: 'network', bin: 'exec' },
  'github/activity': { host: 'network', bin: 'exec' },
  'timesheet/timelogs': { host: 'network', bin: 'exec' },
  'timesheet/activity': { dir: 'path' },
  'llm/servers': { 'endpoints[].url': 'network' },
  'gpu/devices': { ssh: 'exec', url: 'network' },
};

test('the plugins mark every option that runs programs, contacts hosts or reads paths', () => {
  const installed = new Set(plugins.map((p) => p.id));
  const expected = Object.fromEntries(Object.entries(EXPECTED_RISKS).filter(([type]) => installed.has(type.split('/')[0]!)));
  assert.deepEqual(risksBy(), expected);
});

test('a config pasted from a chat: code fence and BOM are tolerated, bad JSON is explained', () => {
  assert.deepEqual(readConfigText('﻿```json\n{"theme":"paper"}\n```\n').value, { theme: 'paper' });
  assert.equal(readConfigText('```json\n{}\n```').notes.length, 1);
  const bad = readConfigText('{\n  "theme": "paper",\n}\n');
  assert.match(bad.error!, /^not valid JSON: .*\. Write plain JSON, with no comments or trailing commas$/);
});

test('kiosko config validate: exit code and --json report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiosko-validate-'));
  try {
    const file = join(dir, 'ai.json');
    writeFileSync(file, JSON.stringify({ screens: [{ pages: [{ tiles: [{ x: 0, y: 0, w: 4, h: 3, widgets: [{ type: 'core/clock', options: { showSeconds: 'yes' } }] }] }] }] }));
    const run = (...args: string[]) => spawnSync(process.execPath, ['--conditions=source', join(root, 'packages/server/src/cli.ts'), 'config', ...args], { encoding: 'utf8', env: { ...process.env, KIOSKO_HOME: dir, NO_COLOR: '1' } });
    const json = run('validate', file, '--json');
    assert.equal(json.status, 1, json.stderr);
    const report = JSON.parse(json.stdout) as { ok: boolean; errors: { path: string; message: string }[] };
    assert.equal(report.ok, false);
    assert.deepEqual(
      report.errors.map((e) => `${e.path}: ${e.message}`),
      ['screens[0].pages[0].tiles[0].widgets[0].options.showSeconds: must be true or false; got the text "yes"'],
    );
    const text = run('validate', file);
    assert.match(text.stdout, /1 error[\s\S]*options\.showSeconds \(core\/clock\): must be true or false/);
    writeFileSync(file, JSON.stringify({ theme: 'paper' }));
    assert.equal(run('validate', file).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
