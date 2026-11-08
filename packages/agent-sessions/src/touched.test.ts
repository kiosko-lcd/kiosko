import { test } from 'node:test';
import assert from 'node:assert';
import { MAX_FILES, touchedFiles } from './touched.ts';

test('Touched files: Edit and Write record the path, most recent first', () => {
  let f = touchedFiles(undefined, 'PreToolUse', 'Edit', { file_path: '/r/a.ts' }, '/r');
  f = touchedFiles(f, 'PreToolUse', 'Write', { file_path: '/r/b.ts' }, '/r');
  f = touchedFiles(f, 'PostToolUse', 'Edit', { file_path: '/r/a.ts' }, '/r');
  assert.deepStrictEqual(f, ['/r/a.ts', '/r/b.ts']);
});

test('Touched files: read-only tools do not count', () => {
  const prev = ['/r/a.ts'];
  assert.strictEqual(touchedFiles(prev, 'PreToolUse', 'Read', { file_path: '/r/z.ts' }, '/r'), prev);
  assert.strictEqual(touchedFiles(prev, 'PreToolUse', 'Bash', { command: 'rm x' }, '/r'), prev);
  assert.strictEqual(touchedFiles(prev, 'Notification', 'Edit', { file_path: '/r/z.ts' }, '/r'), prev);
});

test('Touched files: relative paths, notebooks and Gemini tools', () => {
  assert.deepStrictEqual(touchedFiles(undefined, 'PreToolUse', 'write_file', { file_path: 'src/x.ts' }, '/r'), ['/r/src/x.ts']);
  assert.deepStrictEqual(touchedFiles(undefined, 'PreToolUse', 'NotebookEdit', { notebook_path: '/r/n.ipynb' }, '/r'), ['/r/n.ipynb']);
  assert.deepStrictEqual(touchedFiles(undefined, 'PreToolUse', 'MultiEdit', { file_path: '/r/m.ts' }, '/r'), ['/r/m.ts']);
});

test('Touched files: new session, empty list', () => {
  assert.strictEqual(touchedFiles(['/r/a.ts'], 'SessionStart', '', {}, '/r'), undefined);
});

test('Touched files: list cap', () => {
  let f: string[] | undefined;
  for (let i = 0; i < MAX_FILES + 5; i++) f = touchedFiles(f, 'PreToolUse', 'Edit', { file_path: `/r/${i}.ts` }, '/r');
  assert.strictEqual(f!.length, MAX_FILES);
  assert.strictEqual(f![0], `/r/${MAX_FILES + 4}.ts`);
});

test('Touched files: odd inputs do not break the hook', () => {
  assert.strictEqual(touchedFiles(undefined, 'PreToolUse', 'Edit', null, '/r'), undefined);
  assert.strictEqual(touchedFiles(undefined, 'PreToolUse', 'Edit', 'text', '/r'), undefined);
  assert.strictEqual(touchedFiles(undefined, 'PreToolUse', 'Edit', { file_path: '' }, '/r'), undefined);
});
