import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectPacket, encodeLength, MqttClient, readPackets } from './mqtt.ts';
import { matches, startBroker } from './mqtt-broker.test-helper.ts';

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), 'timed out');
};

test('packets: lengths over 127 take more bytes; a stream splits into whole packets', () => {
  assert.deepEqual([...encodeLength(0)], [0]);
  assert.deepEqual([...encodeLength(127)], [127]);
  assert.deepEqual([...encodeLength(128)], [0x80, 1]);
  assert.deepEqual([...encodeLength(16_383)], [0xff, 0x7f]);
  const two = Buffer.concat([Buffer.from([0xd0, 0]), Buffer.from([0x20, 2, 0, 0])]);
  const r = readPackets(Buffer.concat([two, Buffer.from([0x30, 5, 0])]));
  assert.deepEqual(r.packets.map((p) => p.type), [13, 2]);
  assert.equal(r.rest.length, 3, 'half a packet waits for the rest');
  // The login goes in the CONNECT: user and password flags.
  const c = connectPacket({ url: 'mqtt://x', clientId: 'k', username: 'u', password: 'p', will: { topic: 't', payload: 'offline', retain: true } });
  assert.equal(c[0], 0x10);
  assert.equal(c[9]! & 0xe4, 0x80 | 0x40 | 0x20 | 0x04);
  assert.ok(matches('kiosko/+/page/set', 'kiosko/desk/page/set'));
  assert.ok(matches('homeassistant/#', 'homeassistant/select/a/b/config'));
  assert.ok(!matches('kiosko/+/page/set', 'kiosko/desk/x/page/set'));
});

test('client: logs in, subscribes, publishes and receives; the will goes out when it vanishes', async () => {
  const broker = await startBroker({ users: { kiosko: 's3cret' } });
  const a = new MqttClient({ url: `mqtt://127.0.0.1:${broker.port}`, clientId: 'a', username: 'kiosko', password: 's3cret', will: { topic: 'a/status', payload: 'offline', retain: true } });
  const b = new MqttClient({ url: `mqtt://127.0.0.1:${broker.port}`, clientId: 'b', username: 'kiosko', password: 's3cret' });
  const got: [string, string][] = [];
  b.on('message', (t: string, p: string) => got.push([t, p]));
  b.on('connect', () => b.subscribe(['a/#']));
  try {
    await until(() => a.connected && b.connected);
    await new Promise((r) => setTimeout(r, 50));
    a.publish('a/hello', 'world');
    a.publish('a/status', 'online', true);
    await until(() => got.length >= 2);
    assert.deepEqual(got.slice(0, 2), [['a/hello', 'world'], ['a/status', 'online']]);
    assert.equal(broker.retained.get('a/status'), 'online');
    // Vanishing (no DISCONNECT): the broker publishes the will.
    (a as unknown as { sock: { destroy(): void } }).sock.destroy();
    await until(() => broker.retained.get('a/status') === 'offline');
  } finally {
    a.close();
    b.close();
    await broker.close();
  }
});

test('client: a wrong password is an error that says so, and it waits before trying again', async () => {
  const broker = await startBroker({ users: { kiosko: 's3cret' } });
  const c = new MqttClient({ url: `mqtt://127.0.0.1:${broker.port}`, clientId: 'x', username: 'kiosko', password: 'nope' });
  try {
    await until(() => c.state === 'error');
    assert.equal(c.error, 'wrong user name or password');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(broker.logins.length, 1, 'no second try right away');
  } finally {
    c.close();
    await broker.close();
  }
});

test('client: comes back after the broker drops it, and says what is wrong with the address', async () => {
  const broker = await startBroker();
  const c = new MqttClient({ url: `mqtt://127.0.0.1:${broker.port}`, clientId: 'r' });
  let connects = 0;
  c.on('connect', () => connects++);
  try {
    await until(() => connects === 1);
    broker.kick();
    await until(() => c.state === 'error');
    await until(() => connects === 2, 5000);
  } finally {
    c.close();
    await broker.close();
  }
  const bad = new MqttClient({ url: 'http://x', clientId: 'b' });
  assert.equal(bad.state, 'error');
  assert.match(bad.error!, /mqtt:\/\/ or mqtts:\/\//);
  bad.close();
});
