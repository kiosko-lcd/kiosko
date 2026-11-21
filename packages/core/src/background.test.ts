/**
 * Sources that run with no widget (`SourceDefinition.background`): only
 * those that may, only when the user turned them on, only while their
 * plugin is enabled; and their alerts take the panel over like any other.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { definePlugin, defineSource, defineWidget } from '@kiosko/sdk';
import { backgroundSources, canRunInBackground } from './config/sources.ts';
import { normalize as norm } from './config/store.ts';
import { Registry } from './registry.ts';
import { Runtime } from './runtime.ts';

process.env.KIOSKO_QUIET = '1';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
  assert.ok(cond(), 'timed out');
}

let reads = 0;
const warnings = defineSource({
  id: 'warnings',
  name: 'Warnings',
  background: true,
  intervalMs: 60_000,
  read: async () => (reads++, { tsunami: true }),
  alerts: ({ data }) => (data?.tsunami ? [{ id: 'ntwc-1', level: 'critical', title: 'Tsunami warning', text: 'M7.8 off Portugal', source: 'NWS', detail: 'Move away from the coast' }] : []),
});
const plain = defineSource({ id: 'plain', name: 'Plain', alerts: () => [{ id: 'p', level: 'warn', title: 'Plain' }], read: async () => 1 });
const silent = defineSource({ id: 'silent', name: 'Silent', background: true, read: async () => 1 });

function registry() {
  const reg = new Registry();
  reg.add(definePlugin({ id: 'hz', name: 'Hazards', version: '1', sources: [warnings, plain, silent], widgets: [defineWidget({ id: 'latest', name: 'Latest', sources: ['hz/warnings'], render: () => undefined })] }));
  return reg;
}

test('background sources: only those with background and alerts, only when switched on, only of enabled plugins', () => {
  assert.equal(canRunInBackground(warnings), true);
  assert.equal(canRunInBackground(plain), false, 'not declared');
  assert.equal(canRunInBackground(silent), false, 'no alerts to give');
  const reg = registry();
  const find = (type: string) => reg.source(type);
  const on = { 'hz/warnings': { background: true }, 'hz/plain': { background: true }, 'hz/silent': { background: true }, 'gone/x': { background: true } };
  assert.deepEqual(backgroundSources({ sources: on }, find), ['hz/warnings']);
  assert.deepEqual(backgroundSources({ sources: { 'hz/warnings': { background: false } } }, find), []);
  assert.deepEqual(backgroundSources({ sources: { 'hz/warnings': {} } }, find), [], 'off by default');
  reg.setDisabled(['hz']);
  assert.deepEqual(backgroundSources({ sources: on }, find), []);
});

test('runtime: a source switched on in the background runs with no tile using it, and its alert takes the panel over with its source and detail', async () => {
  const reg = registry();
  const cfg = (background: boolean | undefined, disabled: string[] = []) =>
    norm({
      plugins: { disabled },
      sources: background === undefined ? {} : { 'hz/warnings': { background } },
      screens: [{ id: 's', name: 'S', width: 192, height: 46, device: { driver: 'virtual' }, pages: [{ id: 'p', name: 'p', grid: { cols: 1, rows: 1, gap: 0, padding: 0 }, tiles: [] }] }],
    });
  const running = (rt: Runtime) => rt.status().sources.map((s) => s.type);
  const rt = new Runtime(reg, cfg(undefined));
  rt.start();
  try {
    // Off by default: nothing uses it, nothing runs.
    await sleep(150);
    assert.deepEqual(running(rt), []);
    assert.equal(reads, 0);

    rt.apply(cfg(true));
    await until(() => rt.lastFrame('s')?.alert === 'hz/warnings:ntwc-1');
    assert.deepEqual(running(rt), ['hz/warnings']);
    const [a] = rt.listAlerts();
    assert.deepEqual([a!.origin, a!.from, a!.source, a!.detail], ['source', 'hz/warnings', 'NWS', 'Move away from the coast']);

    // Its plugin switched off: it stops, and its alert goes.
    rt.apply(cfg(true, ['hz']));
    await until(() => rt.listAlerts().length === 0);
    assert.deepEqual(running(rt), []);

    // Switched off again: stopped.
    rt.apply(cfg(true));
    await until(() => running(rt).length === 1);
    rt.apply(cfg(false));
    await until(() => running(rt).length === 0 && rt.listAlerts().length === 0);
  } finally {
    rt.stop();
  }
});
