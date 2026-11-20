/**
 * Every language Kiosko speaks (packages/sdk/src/languages.ts) is complete
 * everywhere it shows: the editor's dictionary, the demo's and the 3D page's
 * words, the site's page, the panel's words for times, the built-in plugins
 * and every `{ en, es, … }` text of the SDK, the core, the server and the
 * web. Adding a language to the list makes this test say what is missing.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FORMAT_LANGUAGES, LANGUAGES, pickLocale } from '@kiosko/sdk';
import { lintPlugin } from '@kiosko/core';
import corePlugin from '../../../plugins/core/src/index.ts';
import legacyPlugin from '../../../plugins/legacy/src/index.ts';
import { DICTIONARIES } from '../src/lang/index.ts';
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
  const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
  const dirs = ['packages/sdk/src', 'packages/core/src', 'packages/server/src', 'packages/web/src', 'packages/web/demo', 'packages/web/panel3d', 'packages/web/landing', 'plugins/core/src', 'plugins/legacy/src'];
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) {
        if (f !== 'node_modules' && f !== 'dist' && f !== 'shims') walk(p);
      } else if (/\.tsx?$/.test(f) && !/\.(test|d)\.tsx?$/.test(f)) files.push(p);
    }
  };
  for (const d of dirs) walk(join(root, d));
  const name = (p: import('typescript').ObjectLiteralElementLike) => (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null);
  const gaps: string[] = [];
  for (const file of files) {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (n: import('typescript').Node) => {
      if (ts.isObjectLiteralExpression(n)) {
        const keys = n.properties.map(name);
        // A localized text: en and es, every value a string or template (not a table of tables).
        const texts = n.properties.every((p) => ts.isPropertyAssignment(p) && (ts.isStringLiteral(p.initializer) || ts.isNoSubstitutionTemplateLiteral(p.initializer) || ts.isTemplateExpression(p.initializer)));
        if (texts && keys.includes('en') && keys.includes('es')) {
          const lacks = ids.filter((id) => !keys.includes(id));
          if (lacks.length) gaps.push(`${file.slice(root.length)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} lacks ${lacks.join(', ')}`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  assert.deepEqual(gaps, []);
});
