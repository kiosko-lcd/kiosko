import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DeviceConfig } from '../config/model.ts';
import { dimFor, nightOf } from './backlight.ts';

/** Local time today at hh:mm (the night window is local time, like quiet hours). */
const at = (hh: number, mm = 0) => new Date(2026, 10, 24, hh, mm).getTime();
const remote = (night?: unknown): DeviceConfig => ({ driver: 'remote', uid: 'a0b1c2d3e4f5', ...(night !== undefined ? { night } : {}) }) as DeviceConfig;
const screen = (device: DeviceConfig, enabled = true) => ({ enabled, device });
const awake = { sleeping: false, alert: false };

test('dimFor: the night window, across midnight, start included and end not', () => {
  const s = screen(remote({ start: '22:30', end: '07:00', brightness: 10 }));
  assert.equal(dimFor(s, awake, at(12)), null);
  assert.equal(dimFor(s, awake, at(22, 29)), null);
  assert.equal(dimFor(s, awake, at(22, 30)), 10);
  assert.equal(dimFor(s, awake, at(2)), 10);
  assert.equal(dimFor(s, awake, at(6, 59)), 10);
  assert.equal(dimFor(s, awake, at(7)), null);
  // Within one day, and off at night.
  const day = screen(remote({ start: '13:00', end: '15:00', brightness: 0 }));
  assert.equal(dimFor(day, awake, at(14)), 0);
  assert.equal(dimFor(day, awake, at(16)), null);
});

test('dimFor: black screens go dark, alerts always light up, other drivers are left alone', () => {
  const s = screen(remote({ start: '22:00', end: '07:00', brightness: 20 }));
  assert.equal(dimFor(s, { sleeping: true, alert: false }, at(12)), 0);
  assert.equal(dimFor(s, { sleeping: true, alert: false }, at(23)), 0);
  assert.equal(dimFor(screen(remote(), false), awake, at(12)), 0, 'a disabled screen');
  assert.equal(dimFor(s, { sleeping: true, alert: true }, at(23)), null, 'an alert over a switched-off screen at night');
  assert.equal(dimFor(screen(remote()), awake, at(23)), null, 'no night window');
  assert.equal(dimFor(screen({ driver: 'virtual' }), { sleeping: true, alert: false }, at(23)), null);
});

test('nightOf: a hand-edited window that makes no sense is none', () => {
  assert.deepEqual(nightOf(remote({ start: '22:00', end: '07:00', brightness: 33.4 })), { start: '22:00', end: '07:00', brightness: 33 });
  assert.deepEqual(nightOf(remote({ start: '22:00', end: '07:00', brightness: 250 }))?.brightness, 100);
  assert.equal(nightOf(remote({ start: '22:00', end: '22:00', brightness: 5 })), null);
  assert.equal(nightOf(remote({ start: '25:00', end: '07:00', brightness: 5 })), null);
  assert.equal(nightOf(remote({ start: '22:00', end: '07:00' })), null);
  assert.equal(nightOf(remote('tonight')), null);
  assert.equal(nightOf({ driver: 'virtual' }), null);
});
