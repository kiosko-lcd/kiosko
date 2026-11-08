import { test } from 'node:test';
import assert from 'node:assert';
import { testOutcome } from './testsignal.ts';

const run = (command: string, stdout: string, extra: Record<string, unknown> = {}) => testOutcome('PostToolUse', 'Bash', { command }, { stdout, stderr: '', ...extra });

test('Tests: recognises a failing suite, whichever runner it comes from', () => {
  assert.strictEqual(run('npm test', 'ℹ tests 216\nℹ pass 214\nℹ fail 2'), 'fail');
  assert.strictEqual(run('pytest -q', '3 failed, 120 passed in 4.2s'), 'fail');
  assert.strictEqual(run('npx vitest run', ' Tests  2 failed | 40 passed (42)'), 'fail');
  assert.strictEqual(run('npm test', 'FAIL src/a.test.ts'), 'fail');
  assert.strictEqual(run('node --test', 'not ok 3 - something'), 'fail');
});

test('Tests: and a passing one', () => {
  assert.strictEqual(run('npm test', 'ℹ tests 216\nℹ pass 216\nℹ fail 0'), 'ok');
  assert.strictEqual(run('pytest', '120 passed in 4.2s'), 'ok');
  assert.strictEqual(run('cargo test', 'test result: ok. 12 passed; 0 failed'), 'ok');
});

test('Tests: the exit code wins when there is one', () => {
  assert.strictEqual(run('npm test', 'all good', { exit_code: 1 }), 'fail');
  assert.strictEqual(run('npm test', 'FAIL in a name', { exitCode: 0 }), 'ok');
});

test('Tests: anything that is not a test run, or cannot be understood, says nothing', () => {
  assert.strictEqual(run('ls -la', '1 failed'), null);
  assert.strictEqual(run('npm test', ''), null);
  assert.strictEqual(run('npm test', 'compiling…'), null);
  assert.strictEqual(testOutcome('PreToolUse', 'Bash', { command: 'npm test' }, null), null);
  assert.strictEqual(testOutcome('PostToolUse', 'Read', { command: 'npm test' }, '1 failed'), null);
});

test('Failed command: failure event, exit code and rebase with conflicts', async () => {
  const { commandFailed } = await import('./testsignal.ts');
  assert.strictEqual(commandFailed('PostToolUseFailure', 'Bash', { command: 'git rebase -i HEAD~3' }, { error: 'exit 1' }), true);
  assert.strictEqual(commandFailed('PostToolUse', 'run_shell_command', { command: 'ls' }, { exitCode: 2 }), true);
  assert.strictEqual(commandFailed('PostToolUse', 'Bash', { command: 'git rebase main' }, { stdout: 'CONFLICT (content): Merge conflict in a.ts\nerror: could not apply 1a2b3c' }), true);
  assert.strictEqual(commandFailed('PostToolUse', 'Bash', { command: 'git rebase main' }, { stdout: 'Successfully rebased and updated refs/heads/x.' }), false);
  assert.strictEqual(commandFailed('PostToolUse', 'Edit', {}, {}), null);
  assert.strictEqual(commandFailed('PreToolUse', 'Bash', { command: 'ls' }, undefined), null);
});
