import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MALLOC_ENV, mallocRestartEnv, type MallocBootInput } from './malloc-boot.ts';

const linux = (over: Partial<MallocBootInput> = {}): MallocBootInput => ({ platform: 'linux', glibc: '2.39', env: { PATH: '/usr/bin' }, args: [], hasExecve: true, ...over });

test('malloc: `kiosko start` on Linux with glibc starts again with malloc tuned, marked so it does only once', () => {
  for (const args of [[], ['start'], ['--port', '7421'], ['--sandbox', '/tmp/x', 'start', '--demo'], ['--demo', '--open']]) {
    const env = mallocRestartEnv(linux({ args }));
    assert.ok(env, `restarts for ${JSON.stringify(args)}`);
    for (const [k, v] of Object.entries(MALLOC_ENV)) assert.equal(env[k], v);
    assert.equal(env.PATH, '/usr/bin', 'the rest of the environment as it was');
    assert.equal(mallocRestartEnv(linux({ env, args })), null, 'the second start goes on');
  }
});

test('malloc: other commands, other systems and an allocator someone already chose are left alone', () => {
  for (const args of [['doctor'], ['render', '--out', 'x.png'], ['--version'], ['-v'], ['start', '--help'], ['service', 'install'], ['sandbox', 'list']]) assert.equal(mallocRestartEnv(linux({ args })), null, JSON.stringify(args));
  assert.equal(mallocRestartEnv(linux({ platform: 'darwin' })), null);
  assert.equal(mallocRestartEnv(linux({ platform: 'win32' })), null);
  assert.equal(mallocRestartEnv(linux({ glibc: undefined })), null, 'musl');
  assert.equal(mallocRestartEnv(linux({ hasExecve: false })), null, 'Node before process.execve');
  for (const env of [{ MALLOC_ARENA_MAX: '4' }, { GLIBC_TUNABLES: 'glibc.malloc.arena_max=8' }, { MALLOC_MMAP_THRESHOLD_: '65536' }, { KIOSKO_MALLOC: 'system' }, { LD_PRELOAD: '/usr/lib/x86_64-linux-gnu/libjemalloc.so.2' }]) assert.equal(mallocRestartEnv(linux({ env })), null, JSON.stringify(env));
});

const glibc = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header?.glibcVersionRuntime;
const canRestart = process.platform === 'linux' && Boolean(glibc) && typeof (process as { execve?: unknown }).execve === 'function';

test('malloc: the restart really happens, in the same process', { skip: !canRestart && 'needs Linux, glibc and process.execve' }, async () => {
  const probe = fileURLToPath(new URL('./test-fixtures/malloc-boot-probe.ts', import.meta.url));
  const env = { ...process.env };
  for (const k of ['MALLOC_ARENA_MAX', 'MALLOC_ARENA_TEST', 'MALLOC_MMAP_THRESHOLD_', 'MALLOC_TRIM_THRESHOLD_', 'MALLOC_TOP_PAD_', 'GLIBC_TUNABLES', 'KIOSKO_MALLOC', 'LD_PRELOAD']) delete env[k];
  const run = async (args: string[], extra: NodeJS.ProcessEnv = {}) => {
    const child = spawn(process.execPath, ['--conditions=source', probe, ...args], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d));
    await new Promise((r) => child.on('close', r));
    return { spawned: child.pid, ...(JSON.parse(out.trim()) as { pid: number; arenaMax: string | null; mark: string | null }) };
  };
  const started = await run(['start']);
  assert.equal(started.arenaMax, MALLOC_ENV.MALLOC_ARENA_MAX);
  assert.equal(started.mark, 'tuned');
  assert.equal(started.pid, started.spawned, 'the same process (systemd and launchers keep their pid)');
  const doctor = await run(['doctor']);
  assert.deepEqual([doctor.arenaMax, doctor.mark], [null, null], 'other commands are not restarted');
  assert.equal((await run(['start'], { KIOSKO_MALLOC: 'system' })).arenaMax, null, 'KIOSKO_MALLOC=system opts out');
});
