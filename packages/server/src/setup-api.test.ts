import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { normalize, offersSetup, Registry, Runtime } from '@kiosko/core';
import core from '@kiosko/plugin-core';
import { startServer, type Discovered } from './server.ts';
import { starterConfig } from './starter.ts';

process.env.KIOSKO_QUIET = '1';

/**
 * The setup wizard only uses what the editor already had: "Detect panels" and the config API. The
 * detection can be handed fakes (no real panel is touched), and what the wizard saves is a config
 * like any other, behind the X-Kiosko header.
 */
test('the setup wizard’s API: detection with fakes, and its config saved like any edit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiosko-setup-api-'));
  const reg = new Registry();
  reg.add(core);
  const first = starterConfig(reg, { locale: 'es-ES' });
  const rt = new Runtime(reg, first);
  const port = 20_000 + Math.floor(Math.random() * 30_000);
  const asked: string[] = [];
  const fake: Discovered = { trcc: [], usb: [{ serial: 'A1', key: 'A1', width: 1920, height: 462, location: '1-4' }, { serial: 'B2', key: 'B2', width: 0, height: 0, location: '1-5', error: 'LIBUSB_ERROR_ACCESS' }] };
  const configPath = join(dir, 'config.json');
  const srv = startServer({ runtime: rt, host: '127.0.0.1', port, configPath, webDir: dir, version: '0', checkUpdates: false, homeassistant: false, discover: async (url) => (asked.push(url), fake) });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { 'x-kiosko': '1' }) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as any };
  };
  try {
    const st = await call('GET', '/api/state');
    assert.ok(offersSetup(st.body.config), 'a first run is offered the setup');
    const d = await call('GET', '/api/devices/discover');
    assert.deepEqual(d.body, fake);
    assert.deepEqual(asked, ['http://127.0.0.1:8099']);
    // What the wizard makes (a file screen here: a test never opens a USB device): its screens, and `setup` so it is not offered again.
    const made = normalize({ ...st.body.config, setup: 'done', screens: [{ ...st.body.config.screens[0], id: 'desk', name: 'Desk', device: { driver: 'file', dir: join(dir, 'frames') } }] });
    assert.equal((await call('PUT', '/api/config', { config: made, baseRev: st.body.rev }, {})).status, 403, 'not from a foreign page');
    const put = await call('PUT', '/api/config', { config: made, baseRev: st.body.rev });
    assert.equal(put.status, 200);
    const saved = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(saved.setup, 'done');
    assert.equal(saved.screens[0].name, 'Desk');
    assert.equal(offersSetup((await call('GET', '/api/state')).body.config), false);
  } finally {
    srv.close();
    rt.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
