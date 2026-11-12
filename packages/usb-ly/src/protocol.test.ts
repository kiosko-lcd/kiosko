import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CHUNK_SIZE, MAX_FRAME_BYTES, PID_LY, PID_LY1, frameWrites, handshakeRequest, isAccepted, modelFor, parseHandshake, prepareFrame, UnrecognisedReply } from './protocol.ts';

const golden = JSON.parse(readFileSync(new URL('./golden.json', import.meta.url), 'utf8')) as { vectors: { pid: number; length: number; frameLength: number; sha256: string }[] };

test('prepareFrame is byte-for-byte what trcc 9.12 puts on the bus', () => {
  assert.ok(golden.vectors.length >= 20);
  for (const v of golden.vectors) {
    const payload = Buffer.from(Array.from({ length: v.length }, (_, i) => (i * 31 + 7) & 255));
    const frame = prepareFrame(payload, v.pid);
    assert.equal(frame.length, v.frameLength, `pid ${v.pid.toString(16)} length ${v.length}`);
    assert.equal(createHash('sha256').update(frame).digest('hex'), v.sha256, `pid ${v.pid.toString(16)} length ${v.length}`);
  }
});

test('LY pads the chunk count to a multiple of 4, LY1 does not', () => {
  assert.equal(prepareFrame(Buffer.alloc(1), PID_LY).length, 4 * CHUNK_SIZE);
  assert.equal(prepareFrame(Buffer.alloc(1), PID_LY1).length, CHUNK_SIZE);
});

test('frameWrites: 4096-byte transfers; LY ends with at most 2048, LY1 with what is left', () => {
  const ly = frameWrites(prepareFrame(Buffer.alloc(1984), PID_LY), PID_LY); // 5 chunks → 8 → 4096
  assert.deepEqual(ly.map((b) => b.length), [4096]);
  const ly6 = frameWrites(prepareFrame(Buffer.alloc(2 * 4 * 496), PID_LY), PID_LY); // 9 chunks → 12 → 6144
  assert.deepEqual(ly6.map((b) => b.length), [4096, 2048]);
  const ly1 = frameWrites(prepareFrame(Buffer.alloc(2 * 496), PID_LY1), PID_LY1); // 3 chunks → 1536
  assert.deepEqual(ly1.map((b) => b.length), [1536]);
  assert.equal(Buffer.concat(ly6).length, 6144);
});

test('handshake request is 2048 bytes: 02 FF … 01', () => {
  const h = handshakeRequest();
  assert.equal(h.length, 2048);
  assert.deepEqual([...h.subarray(0, 9)], [2, 0xff, 0, 0, 0, 0, 0, 0, 1]);
});

const reply = (r20: number, r22: number) => {
  const b = Buffer.alloc(512);
  b[0] = 3;
  b[1] = 0xff;
  b[8] = 1;
  b[20] = r20;
  b[22] = r22;
  return b;
};

test('parseHandshake: LY gives PM 64+raw (raw ≤ 3 counts as 1) and SUB+1', () => {
  assert.deepEqual({ ...parseHandshake(reply(1, 4), PID_LY), raw: undefined }, { pm: 65, sub: 5, raw: undefined }, 'the Trofeo Vision 9.16: PM 65 SUB 5');
  assert.equal(parseHandshake(reply(0, 0), PID_LY).pm, 65);
  assert.equal(parseHandshake(reply(5, 0), PID_LY).pm, 69);
});

test('parseHandshake: LY1 gives PM 49+raw and SUB as it is', () => {
  const h = parseHandshake(reply(16, 3), PID_LY1);
  assert.equal(h.pm, 65);
  assert.equal(h.sub, 3);
});

test('parseHandshake refuses what is not a panel', () => {
  assert.throws(() => parseHandshake(Buffer.alloc(10), PID_LY), UnrecognisedReply);
  const bad = reply(1, 1);
  bad[0] = 2;
  assert.throws(() => parseHandshake(bad, PID_LY), /\[0\]=2/);
  bad[0] = 3;
  bad[8] = 2;
  assert.throws(() => parseHandshake(bad, PID_LY), /\[8\]=2/);
});

test('modelFor: the Trofeo Vision is 1920×462 and is mounted upside down at SUB 5', () => {
  assert.deepEqual(modelFor(65, 5), { width: 1920, height: 462, rotate: 180 });
  assert.deepEqual(modelFor(65, 4), { width: 1920, height: 462, rotate: 0 });
  assert.deepEqual(modelFor(69, 2), { width: 1920, height: 440, rotate: 0 });
  assert.deepEqual(modelFor(72, 3), { width: 480, height: 480, rotate: 0 });
  assert.equal(modelFor(10, 1), undefined);
  assert.equal(modelFor(65, 99), undefined);
});

test('isAccepted reads byte 8 of the ACK: 1 kept, 2 dropped; a short ACK is not a verdict', () => {
  const ack = (v: number) => Buffer.from([3, 0xff, 0, 0, 0, 0, 0, 0, v, 0, 0, 0]);
  assert.equal(isAccepted(ack(1)), true);
  assert.equal(isAccepted(ack(2)), false);
  assert.equal(isAccepted(Buffer.alloc(4)), true);
  assert.equal(MAX_FRAME_BYTES, 1031 * 496 + 495);
});
