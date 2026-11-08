import { test } from 'node:test';
import assert from 'node:assert';
import { longestDefinition, todosAdded } from './craft.ts';

test('Craft: TODOs added, not the ones already there', () => {
  assert.strictEqual(todosAdded('Edit', { old_string: 'a', new_string: '// TODO: b\n// FIXME c' }), 2);
  assert.strictEqual(todosAdded('Edit', { old_string: '// TODO: b', new_string: '// TODO: b fixed' }), 0);
  assert.strictEqual(todosAdded('Write', { content: 'TODO TODO' }), 2);
  assert.strictEqual(todosAdded('MultiEdit', { edits: [{ old_string: '', new_string: 'TODO' }, { old_string: 'x', new_string: 'FIXME' }] }), 2);
  assert.strictEqual(todosAdded('Read', { file_path: 'TODO' }), 0);
  assert.strictEqual(todosAdded('Edit', { new_string: 'TODOS los días' }), 0, 'whole word only');
});

test('Craft: the longest definition, in lines', () => {
  const f = (n: number) => `function f() {\n${'  x();\n'.repeat(n)}}\n`;
  assert.strictEqual(longestDefinition(`${f(3)}${f(10)}`), 13);
  assert.ok(longestDefinition(f(600)) > 500);
  assert.ok(longestDefinition(`def a():\n${'    pass\n'.repeat(520)}def b():\n    pass\n`) > 500);
  assert.strictEqual(longestDefinition('const a = 1;\n'), 0);
});
