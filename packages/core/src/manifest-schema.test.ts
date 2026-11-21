import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import core from '@kiosko/plugin-core';
import { validateJson, type JsonSchema } from './config/jsonschema.ts';
import { pluginManifest } from './plugin-meta.ts';

const schema = JSON.parse(readFileSync(new URL('../schema/manifest.json', import.meta.url), 'utf8')) as JsonSchema;
const plugins = new URL('../../../../kiosko-plugins/', import.meta.url);

test('the manifest schema: what pluginManifest writes passes, with and without the store fields', () => {
  assert.deepEqual(validateJson(schema, JSON.parse(JSON.stringify(pluginManifest(core)))), []);
  const store = { ...core, markets: { only: ['ES', 'EU'] }, pricing: { model: 'free' as const }, support: { issues: 'https://x.dev/i' }, funding: 'https://x.dev/f', resources: { cpu: 'low' as const } };
  assert.deepEqual(validateJson(schema, JSON.parse(JSON.stringify(pluginManifest(store)))), []);
});

test('the manifest schema says no to what a store must not trust', () => {
  const m = JSON.parse(JSON.stringify(pluginManifest(core)));
  const bad = (change: (x: any) => void) => {
    const x = structuredClone(m);
    change(x);
    return validateJson(schema, x).map((i) => i.path);
  };
  assert.deepEqual(bad((x) => (x.id = 'Core!')), ['id']);
  assert.deepEqual(bad((x) => (x.pricing = { model: 'paid' })), ['pricing.model']);
  assert.deepEqual(bad((x) => (x.markets = { only: ['Spain'] })), ['markets.only[0]']);
  assert.deepEqual(bad((x) => (x.widgets[0].screenshot = '../../etc/passwd')), ['widgets[0].screenshot']);
  assert.deepEqual(bad((x) => (x.permissions = { camera: ['x'] })), ['permissions.camera']);
});

// The official plugins, cloned next to Kiosko (as the Pages workflow does): their published manifests pass.
test('the manifest schema: the official plugins’ kiosko-manifest.json', { skip: !existsSync(plugins) && 'no ../kiosko-plugins' }, () => {
  let n = 0;
  for (const dir of readdirSync(plugins).filter((d) => d.startsWith('kiosko-plugin-'))) {
    const file = join(fileURLToPath(plugins), dir, 'kiosko-manifest.json');
    if (!existsSync(file)) continue;
    n++;
    assert.deepEqual(validateJson(schema, JSON.parse(readFileSync(file, 'utf8'))).map((i) => `${i.path}: ${i.message}`), [], dir);
  }
  assert.ok(n > 0);
});
