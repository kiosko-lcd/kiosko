import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBaseContext, validate } from '@kiosko/sdk';
import plugin from './index.ts';

test('a module\'s own updateMs is its fetch interval', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiosko-legacy-'));
  try {
    writeFileSync(join(dir, 'slow.mjs'), 'export default { name: "slow", updateMs: 90000, fetch: async () => 1, draw() {} };\n');
    writeFileSync(join(dir, 'plain.mjs'), 'export default { name: "plain", draw() {} };\n');
    const w = plugin.widgets!.find((x) => x.id === 'module')!;
    const fetched = async (module: string) => {
      const options = validate(w.options!, { module, dir }).value;
      const data = await w.fetch!({ ...createBaseContext({ now: 0 }), options, canvas: {} as never, signal: new AbortController().signal, timeoutMs: 1000, sources: {} } as never);
      return w.intervalOf!({ options, data } as never);
    };
    assert.equal(await fetched('slow'), 90_000);
    assert.equal(await fetched('plain'), undefined, 'none declared: the widget\'s 60 s');
    assert.equal(w.intervalOf!({ options: {}, data: undefined } as never), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
