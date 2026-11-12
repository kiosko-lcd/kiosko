import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { installSdkResolver } from './sdk-resolver.ts';

test('a plugin installed with npm next to the CLI (no plugins folder, no node_modules of its own) gets Kiosko\'s SDK', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiosko-resolver-'));
  try {
    mkdirSync(join(dir, 'node_modules', 'kiosko-plugin-fake', 'dist'), { recursive: true });
    const file = join(dir, 'node_modules', 'kiosko-plugin-fake', 'dist', 'index.js');
    writeFileSync(file, "import { definePlugin } from '@kiosko/sdk';\nexport default definePlugin({ id: 'fake', name: 'Fake', version: '1.0.0', widgets: [] });\n");
    installSdkResolver();
    const mod = (await import(pathToFileURL(file).href)) as { default: { id: string } };
    assert.equal(mod.default.id, 'fake');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
