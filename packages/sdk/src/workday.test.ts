import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_WORKDAY, dayKey, isWorkingAt, minutesOf, scheduleOn, weeklyHours, type Workday } from './workday.ts';

// 2026-11-13 is a Friday; 2026-11-14 a Saturday. Local times.
const fri = (h: number, m = 0) => new Date(2026, 10, 13, h, m).getTime();
const w: Workday = { ...DEFAULT_WORKDAY, start: '08:00', end: '17:00', hours: 8.5, byDay: { '5': { end: '15:00', hours: 6 } }, holidays: ['2026-12-25'] };

test('minutesOf and dayKey', () => {
  assert.equal(minutesOf('09:30'), 570);
  assert.equal(minutesOf('7:05'), 425);
  assert.equal(minutesOf(''), 0);
  assert.equal(minutesOf(undefined), 0);
  assert.equal(dayKey(fri(10)), '2026-11-13');
});

test('scheduleOn: days with other hours, weekends and holidays', () => {
  assert.deepEqual(scheduleOn(w, fri(10)), { working: true, holiday: false, start: '08:00', end: '15:00', startMin: 480, endMin: 900, hours: 6 });
  assert.equal(scheduleOn(w, new Date(2026, 10, 12, 10)).hours, 8.5);
  assert.equal(scheduleOn(w, new Date(2026, 10, 14, 10)).working, false);
  const xmas = scheduleOn(w, new Date(2026, 11, 25, 10));
  assert.deepEqual([xmas.working, xmas.holiday, xmas.hours], [false, true, 0]);
});

test('isWorkingAt follows the day\'s own end and the holidays', () => {
  assert.equal(isWorkingAt(w, fri(14, 59)), true);
  assert.equal(isWorkingAt(w, fri(15, 0)), false);
  assert.equal(isWorkingAt(w, fri(7, 59)), false);
  assert.equal(isWorkingAt(w, new Date(2026, 11, 25, 10)), false);
  assert.equal(isWorkingAt(DEFAULT_WORKDAY, new Date(2026, 10, 12, 16, 59)), true);
});

test('weeklyHours adds up the working days', () => {
  assert.equal(weeklyHours(DEFAULT_WORKDAY), 40);
  assert.equal(weeklyHours(w), 4 * 8.5 + 6);
});
