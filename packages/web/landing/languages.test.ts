/**
 * Every language Kiosko speaks (packages/sdk/src/languages.ts) is complete
 * everywhere it shows: the editor's dictionary, the demo's and the 3D page's
 * words, the site's page, the panel's words for times, the built-in plugins
 * and every `{ en, es, … }` text of the SDK, the core, the server and the
 * web. Adding a language to the list makes this test say what is missing.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FORMAT_LANGUAGES, LANGUAGES, pickLocale } from '@kiosko/sdk';
import { lintPlugin } from '@kiosko/core';
import corePlugin from '../../../plugins/core/src/index.ts';
import legacyPlugin from '../../../plugins/legacy/src/index.ts';
import { DICTIONARIES } from '../src/lang/index.ts';
import { SAMPLE_PAGE_NAMES } from '@kiosko/core';
import { i18nGaps } from '../../../scripts/i18n-gaps.ts';
import { TEXTS as DEMO } from '../src/demo/texts.ts';
import { TEXTS as PANEL3D } from '../panel3d/texts.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const ids = LANGUAGES.map((l) => l.id);

test('the list itself: canonical tags, English first, each once', () => {
  assert.equal(ids[0], 'en');
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.equal(Intl.getCanonicalLocales(id)[0], id, id);
});

for (const l of LANGUAGES) {
  test(`${l.id}: editor, demo, 3D page, site and the panel's time words`, () => {
    // Everything that is missing at once, so a new language is one list of things to do.
    const missing = [
      !DICTIONARIES[l.id] && `packages/web/src/lang/${l.id}.ts (a copy of en.ts, translated) and its line in lang/index.ts`,
      !DEMO[l.id] && `packages/web/src/demo/texts.ts: '${l.id}'`,
      !PANEL3D[l.id] && `packages/web/panel3d/texts.ts: '${l.id}'`,
      !existsSync(join(root, 'packages/web/landing/i18n', `${l.id}.json`)) && `packages/web/landing/i18n/${l.id}.json (a copy of en.json, translated)`,
      pickLocale(FORMAT_LANGUAGES, l.id) !== l.id && `packages/sdk/src/format.ts: WORDS['${l.id}']`,
      pickLocale([l.id], l.panel) !== l.id && `packages/sdk/src/languages.ts: '${l.id}' panel locale ${l.panel} must be the same language and script`,
    ].filter(Boolean);
    assert.deepEqual(missing, []);
  });
}

test('the built-in plugins declare every language and miss no text in any', () => {
  for (const p of [corePlugin, legacyPlugin]) {
    assert.deepEqual([...(p.languages ?? [])].sort(), [...ids].sort(), `${p.id}: languages`);
    const missing = lintPlugin(p).filter((i) => /has no |languages/.test(i.message));
    assert.deepEqual(missing.map((i) => `${i.where}: ${i.message}`), [], p.id);
  }
});

test('every { en, es, … } text of the SDK, core, server and web has every language', () => {
  const dirs = ['packages/sdk/src', 'packages/core/src', 'packages/server/src', 'packages/web/src', 'packages/web/demo', 'packages/web/panel3d', 'packages/web/landing', 'plugins/core/src', 'plugins/legacy/src'];
  const lines: string[] = [];
  for (const id of ids) for (const d of dirs) for (const g of i18nGaps(join(root, d), id)) lines.push(`${g.file.slice(root.length)}:${g.line} ${g.kind === 'missing' ? 'lacks' : 'other placeholders in'} ${id}: ${g.en}`);
  // The whole list in the message (an assertion's diff would cut it short).
  assert.equal(lines.length, 0, `${lines.length} texts lack a language (also: node --conditions=source scripts/i18n-gaps.ts <folder> <language>):\n${lines.join('\n')}`);
});

test('the sample config, the installer and the editor’s week have every language', () => {
  const missing: string[] = [];
  for (const id of ids) {
    for (const [page, names] of Object.entries(SAMPLE_PAGE_NAMES)) if (!names[id]) missing.push(`packages/core/src/config/sample.ts: PAGE_NAMES['${page}']['${id}']`);
    const notes = id === 'en' ? 'notes.txt' : `notes.${id}.txt`;
    if (!existsSync(join(root, 'installer', notes))) missing.push(`installer/${notes} (UTF-8 with BOM)`);
    if (!new RegExp(`InfoAfterFile:\\s*"${notes.replace(/\./g, '\\.')}"`).test(readFileSync(join(root, 'installer/kiosko.iss'), 'utf8'))) missing.push(`installer/kiosko.iss: a [Languages] entry with InfoAfterFile: "${notes}"`);
    const days = DICTIONARIES[id]?.['days.short'];
    if (days !== undefined && days.split(',').length !== 7) missing.push(`packages/web/src/lang/${id}.ts: 'days.short' needs 7 comma-separated days, Sunday first`);
  }
  for (const [dir, p] of [['plugins/core', corePlugin], ['plugins/legacy', legacyPlugin]] as const) {
    const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')) as { kiosko?: { languages?: string[] } };
    if ([...(pkg.kiosko?.languages ?? [])].sort().join() !== [...(p.languages ?? [])].sort().join()) missing.push(`${dir}/package.json: kiosko.languages as in its definition`);
  }
  assert.deepEqual(missing, []);
});
