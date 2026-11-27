import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as kit from '@loksly/lcd-canvas-kit';
import { createCanvas } from '@napi-rs/canvas';
import { DEFAULT_THEME } from '@kiosko/sdk';
import { registerFonts, setFontLocale } from './fonts.ts';
import { keepTextWidths, maybeSaveTextWidths, SAVE_EVERY_MS } from './text-widths.ts';

test('text widths measured once are kept for the next thread or start: the same widths, without measuring again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiosko-widths-'));
  registerFonts();
  const text = 'Las noticias de hoy: 23 °C, «lluvia» y 漢字 — ¿mañana? 1234567890';
  const sizes = [14, 17.5, 22, 31];
  const measure = () => {
    const g = createCanvas(10, 10).getContext('2d');
    let calls = 0;
    const real = g.measureText.bind(g);
    g.measureText = (t: string) => (calls++, real(t));
    const widths = sizes.map((size) => kit.measureTracked(g, text, { size, family: DEFAULT_THEME.fonts.sans }));
    return { widths, calls };
  };
  try {
    // A first thread: measures, and keeps them.
    kit.clearTextCache();
    keepTextWidths(dir);
    setFontLocale('es');
    const first = measure();
    assert.ok(first.calls > 40, 'measured character by character');
    assert.equal(maybeSaveTextWidths(Date.now()), null, 'not at once');
    await maybeSaveTextWidths(Date.now() + SAVE_EVERY_MS);
    const files = readdirSync(dir).filter((f) => f.startsWith('text-widths-'));
    assert.equal(files.length, 1);
    assert.equal(maybeSaveTextWidths(Date.now() + 3 * SAVE_EVERY_MS), null, 'nothing new: not written again');

    // The next one (a new thread, Kiosko started again): nothing to measure.
    kit.clearTextCache();
    keepTextWidths(dir);
    setFontLocale('es');
    const next = measure();
    assert.equal(next.calls, 0, 'not measured again');
    assert.deepEqual(next.widths, first.widths, 'the same widths');

    // A file whose widths are not what these fonts measure (a font replaced under the same name): ignored.
    const path = join(dir, files[0]!);
    const kept = JSON.parse(readFileSync(path, 'utf8')) as { widths: Record<string, Record<string, number>> };
    for (const chars of Object.values(kept.widths)) for (const ch of Object.keys(chars)) chars[ch]! += 0.5;
    writeFileSync(path, JSON.stringify(kept));
    kit.clearTextCache();
    keepTextWidths(dir);
    setFontLocale('es');
    const wrong = measure();
    assert.ok(wrong.calls > 40, 'measured again');
    assert.deepEqual(wrong.widths, first.widths);
  } finally {
    keepTextWidths(null);
    kit.clearTextCache();
  }
});
