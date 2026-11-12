import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renameReplacing } from './devices.ts';

const busy = () => Object.assign(new Error('busy'), { code: 'EBUSY' });

test('renameReplacing: retries while the destination is busy, then goes through', async () => {
  let calls = 0;
  await renameReplacing('a', 'b', () => {
    if (++calls < 3) throw busy();
  });
  assert.equal(calls, 3);
});

test('renameReplacing: gives up after the tries, and does not retry other errors', async () => {
  let calls = 0;
  await assert.rejects(renameReplacing('a', 'b', () => { calls++; throw busy(); }, 3), /busy/);
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(renameReplacing('a', 'b', () => { calls++; throw Object.assign(new Error('x'), { code: 'ENOENT' }); }), /x/);
  assert.equal(calls, 1);
});
