import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { normalize, Registry, Runtime, type UpdateCheck } from '@kiosko/core';
import type { InstallInfo } from './install-kind.ts';
import type { Run } from './self-update.ts';
import { startServer } from './server.ts';

process.env.KIOSKO_QUIET = '1';

const PREFIX = '/opt/node';
const npmInstall: InstallInfo = { kind: 'npm-global', dir: `${PREFIX}/lib/node_modules/kiosko`, cli: `${PREFIX}/lib/node_modules/kiosko/cli.js`, prefix: PREFIX, service: 'systemd', platform: 'linux' };

function serve(o: { install?: InstallInfo; demo?: boolean; latest?: string | null; run?: Run }) {
  const dir = mkdtempSync(join(tmpdir(), 'kiosko-self-api-'));
  const rt = new Runtime(new Registry(), normalize({ screens: [] }), { demo: !!o.demo });
  // Below 40 000: Windows reserves blocks of its dynamic range (49 152 and up: Hyper-V, WSL), and listening there fails with EACCES.
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const check: UpdateCheck = { checkedAt: 1, plugins: [], errors: [], ...(o.latest ? { kiosko: { current: '0.2.8', latest: o.latest, versions: [o.latest] } } : {}) };
  const calls: string[] = [];
  const run: Run = o.run ?? (async (cmd, args) => {
    calls.push(`${cmd.split(/[\\/]/).at(-1)!.replace(/\.cmd$/i, '')} ${args.join(' ')}`);
    if (args[0] === 'prefix') return { code: 0, stdout: PREFIX, stderr: '' };
    if (args[1] === '--version') return { code: 0, stdout: '0.2.9', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  });
  const srv = startServer({
    runtime: rt, host: '127.0.0.1', port, configPath: join(dir, 'config.json'), webDir: dir, version: '0.2.8', checkUpdates: false, homeassistant: false, home: dir,
    updateCheck: async () => check,
    install: o.install ?? npmInstall,
    selfUpdate: { run, restartHow: 'systemd', mark: () => undefined, registry: 'https://registry.npmjs.org' },
  });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { 'x-kiosko': '1' }) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const stop = () => {
    srv.close();
    rt.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  return { call, stop, calls, srv };
}

test('the Kiosko update API: guarded like the rest, only the version the check found, one at a time', async () => {
  const s = serve({ latest: '0.2.9' });
  try {
    // Before the check: nothing to update to.
    assert.equal((await s.call('POST', '/api/kiosko/update', { version: '0.2.9' })).body.code, 'noKioskoUpdate');
    await s.call('GET', '/api/plugins/updates?refresh=1');
    const st = await s.call('GET', '/api/state');
    assert.equal(st.body.kioskoUpdate.install.kind, 'npm-global');
    assert.equal(st.body.kioskoUpdate.canUpdate, true);
    assert.equal(st.body.kioskoUpdate.instructions.command, 'npm install -g kiosko@0.2.9');
    assert.equal(st.body.kioskoUpdate.status.state, 'idle');
    // A web page can't start it: no X-Kiosko header.
    assert.equal((await s.call('POST', '/api/kiosko/update', { version: '0.2.9' }, {})).status, 403);
    assert.equal((await s.call('POST', '/api/kiosko/update/confirm', { version: '0.2.9' }, {})).status, 403);
    // Another version than the one found (a downgrade, a typo): refused.
    assert.equal((await s.call('POST', '/api/kiosko/update', { version: '0.2.7' })).body.code, 'noKioskoUpdate');
    assert.equal((await s.call('POST', '/api/kiosko/update', {})).body.code, 'noKioskoUpdate');
    const go = await s.call('POST', '/api/kiosko/update', { version: '0.2.9' });
    assert.equal(go.status, 202);
    const again = await s.call('POST', '/api/kiosko/update', { version: '0.2.9' });
    assert.ok(again.status === 409 || again.status === 202);
    // Wait for it to end: the fake service manager "restarts" it.
    for (let i = 0; i < 50 && (await s.call('GET', '/api/kiosko/update')).body.status.state === 'working'; i++) await new Promise((r) => setTimeout(r, 20));
    const end = (await s.call('GET', '/api/kiosko/update')).body.status;
    assert.equal(end.state, 'restarting', JSON.stringify(end));
    assert.equal(s.calls.at(-1), 'systemctl --user --no-block restart kiosko.service');
    assert.equal(s.calls.filter((c) => c.startsWith('npm install')).length, 1, 'one install, not two');
    // Its steps are in the activity log.
    const logs = (await s.call('GET', '/api/logs')).body as { scope: string; message: string }[];
    assert.ok(logs.some((l) => l.scope === 'kiosko-update' && /0\.2\.8 → 0\.2\.9/.test(l.message)));
    // Confirm is only for a verified Windows installer.
    assert.equal((await s.call('POST', '/api/kiosko/update/confirm', { version: '0.2.9' })).body.code, 'notReady');
    const v = await s.call('GET', '/api/version');
    assert.equal(v.body.version, '0.2.8');
    assert.match(v.body.instance, /^[0-9a-f]{16}$/);
  } finally {
    s.stop();
  }
});

test('the Kiosko update API: no button for a checkout or in the demo, only the instructions', async () => {
  const src = serve({ latest: '0.2.9', install: { kind: 'source', dir: '/src/kiosko', cli: '/src/kiosko/packages/server/src/cli.ts', service: null, platform: 'linux' } });
  try {
    await src.call('GET', '/api/plugins/updates?refresh=1');
    const st = (await src.call('GET', '/api/kiosko/update')).body;
    assert.equal(st.canUpdate, false);
    assert.equal(st.blocker, 'source');
    assert.match(st.instructions.command, /^git pull/);
    const r = await src.call('POST', '/api/kiosko/update', { version: '0.2.9' });
    assert.equal(r.body.code, 'cantUpdateKiosko');
    assert.equal(src.calls.length, 0, 'nothing ran');
  } finally {
    src.stop();
  }
  const demo = serve({ latest: '0.2.9', demo: true });
  try {
    await demo.call('GET', '/api/plugins/updates?refresh=1');
    assert.equal((await demo.call('POST', '/api/kiosko/update', { version: '0.2.9' })).body.code, 'demo');
  } finally {
    demo.stop();
  }
});
