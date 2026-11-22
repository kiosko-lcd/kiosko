import { test } from 'node:test';
import assert from 'node:assert/strict';
import { posixTz } from './tz.ts';

test('posixTz: the rules the screen’s C library needs, from Intl', () => {
  assert.equal(posixTz('Europe/Madrid', 2026), '<+01>-1<+02>,M3.5.0,M10.5.0/3');
  assert.equal(posixTz('America/New_York', 2026), '<-05>5<-04>,M3.2.0,M11.1.0');
  assert.equal(posixTz('Asia/Shanghai', 2026), '<+08>-8');
  assert.equal(posixTz('Asia/Kolkata', 2026), '<+0530>-5:30');
  assert.equal(posixTz('UTC', 2026), '<+00>0');
  assert.equal(posixTz('Australia/Sydney', 2026), '<+10>-10<+11>,M10.1.0,M4.1.0/3');
  assert.equal(posixTz('Not/AZone', 2026), 'UTC0');
});
