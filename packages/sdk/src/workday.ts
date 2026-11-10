/**
 * The user's working week, set once in Settings and handed to every plugin
 * as `ctx.workday`: which days, from when to when, how many hours are due,
 * days with other hours (a short Friday) and days off. Plugins default to it
 * instead of asking for their own start, end and holidays.
 */

/** Other hours on one weekday. Unset fields are the week's. */
export interface DayHours {
  start?: string;
  end?: string;
  hours?: number;
}

export interface Workday {
  /** Working days, 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** `HH:MM`, 24 h. */
  start: string;
  end: string;
  /** Hours due on a working day (what a timesheet expects), not the span from start to end. */
  hours: number;
  /** Days off, `YYYY-MM-DD`: no work hours, nothing due. */
  holidays: string[];
  /** Days with other hours, by weekday (`"5"` = Friday): `{ "5": { "end": "15:00", "hours": 6 } }`. */
  byDay: Partial<Record<string, DayHours>>;
}

export const DEFAULT_WORKDAY: Workday = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', hours: 8, holidays: [], byDay: {} };

/** `"09:30"` → 570. Anything unreadable is 0. */
export function minutesOf(hhmm: string | undefined): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/** `YYYY-MM-DD` of the local day `at` falls in. */
export function dayKey(at: number | Date): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface DaySchedule {
  /** A working day that is not a holiday. */
  working: boolean;
  holiday: boolean;
  start: string;
  end: string;
  /** Minutes from local midnight. */
  startMin: number;
  endMin: number;
  /** Hours due that day: 0 on days off. */
  hours: number;
}

/** The schedule of the local day `at` falls in. */
export function scheduleOn(w: Workday, at: number | Date): DaySchedule {
  const day = new Date(at).getDay();
  const own = w.byDay?.[String(day)] ?? {};
  const start = own.start || w.start;
  const end = own.end || w.end;
  const holiday = (w.holidays ?? []).includes(dayKey(at));
  const working = w.days.includes(day) && !holiday;
  return { working, holiday, start, end, startMin: minutesOf(start), endMin: minutesOf(end), hours: working ? (own.hours ?? w.hours ?? 0) : 0 };
}

/** Inside work hours at `at`: a working day, not a holiday, between its start and end. */
export function isWorkingAt(w: Workday, at: number | Date): boolean {
  const s = scheduleOn(w, at);
  if (!s.working) return false;
  const d = new Date(at);
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins >= s.startMin && mins < s.endMin;
}

/** Hours due in a normal week (no holidays): the sum over the working days. */
export function weeklyHours(w: Workday): number {
  return w.days.reduce((sum, d) => sum + (w.byDay?.[String(d)]?.hours ?? w.hours ?? 0), 0);
}
