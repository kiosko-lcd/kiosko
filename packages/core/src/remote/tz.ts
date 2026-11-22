/**
 * The machine's time zone as a POSIX TZ string ("<+01>-1<+02>,M3.5.0/2,M10.5.0/3"),
 * for a remote screen's idle clock: its C library knows no zone names, only
 * rules. The rule is read off this year's transitions (Intl knows them); zones
 * that change by other rules than "the nth weekday of a month" are rare, and
 * Kiosko pushes it again on every connection anyway.
 */
const formats = new Map<string, Intl.DateTimeFormat>();
function offsetMinutes(tz: string, at: number): number {
  let f = formats.get(tz);
  if (!f) formats.set(tz, (f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })));
  const p = Object.fromEntries(f.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  return Math.round((local - Math.floor(at / 60_000) * 60_000) / 60_000);
}

const name = (min: number) => {
  const s = min < 0 ? '-' : '+';
  const a = Math.abs(min);
  return `<${s}${String(Math.floor(a / 60)).padStart(2, '0')}${a % 60 ? String(a % 60).padStart(2, '0') : ''}>`;
};
// POSIX counts west of Greenwich as positive.
const off = (min: number) => {
  const a = Math.abs(min);
  return `${min > 0 ? '-' : ''}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, '0')}` : ''}`;
};

/** "Mm.w.d/h": month, week (5 = last), weekday, local hour of a transition at `localMs` (UTC fields = local time). */
function rule(localMs: number): string {
  const d = new Date(localMs);
  const day = d.getUTCDate();
  const days = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const week = day + 7 > days ? 5 : Math.ceil(day / 7);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return `M${d.getUTCMonth() + 1}.${week}.${d.getUTCDay()}${mins === 120 ? '' : `/${Math.floor(mins / 60)}${mins % 60 ? `:${String(mins % 60).padStart(2, '0')}` : ''}`}`;
}

export function posixTz(tz = Intl.DateTimeFormat().resolvedOptions().timeZone, year = new Date().getUTCFullYear()): string {
  try {
    const start = Date.UTC(year, 0, 1);
    const changes: { at: number; from: number; to: number }[] = [];
    let prev = offsetMinutes(tz, start);
    const DAY = 86_400_000;
    for (let t = start + DAY; t <= Date.UTC(year + 1, 0, 1); t += DAY) {
      const o = offsetMinutes(tz, t);
      if (o === prev) continue;
      // Then to the minute.
      let lo = t - DAY, hi = t;
      while (hi - lo > 60_000) {
        const mid = Math.floor((lo + hi) / 120_000) * 60_000;
        if (offsetMinutes(tz, mid) === prev) lo = mid;
        else hi = mid;
      }
      changes.push({ at: hi, from: prev, to: o });
      prev = o;
    }
    if (changes.length !== 2) return `${name(prev)}${off(prev)}`;
    const on = changes.find((c) => c.to > c.from)!, offc = changes.find((c) => c.to < c.from)!;
    const std = on.from, dst = on.to;
    // Each transition in the local time in force just before it.
    return `${name(std)}${off(std)}${name(dst)}${dst - std === 60 ? '' : off(dst)},${rule(on.at + std * 60_000)},${rule(offc.at + dst * 60_000)}`;
  } catch {
    return 'UTC0';
  }
}
