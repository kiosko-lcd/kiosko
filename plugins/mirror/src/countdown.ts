/**
 * Countdown: the days left until what matters (an exam, the holidays, a
 * deadline). A port of MMM-Countdown with several dates instead of one: the
 * nearest come first and past ones disappear on their own.
 */
import { defineWidget, t } from '@tessera/sdk';
import { clamp, dayOffset } from './util.ts';

export interface CountdownEvent {
  name: string;
  /** `YYYY-MM-DD` (or an ISO date-time), local time. */
  date: string;
}

const DAY = 86_400_000;

/** Whole days from today to that date, counted in local calendar days. */
export function daysUntil(date: string, now: number): number | null {
  const at = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00`) : new Date(date);
  if (Number.isNaN(at.getTime())) return null;
  const a = new Date(now);
  a.setHours(0, 0, 0, 0);
  at.setHours(0, 0, 0, 0);
  return Math.round((at.getTime() - a.getTime()) / DAY);
}

/** The ones still ahead, nearest first. */
export function upcoming(events: CountdownEvent[], now: number, max: number): { name: string; days: number }[] {
  return events
    .map((e) => ({ name: e.name, days: daysUntil(e.date, now) }))
    .filter((e): e is { name: string; days: number } => e.days !== null && e.days >= 0)
    .sort((a, b) => a.days - b.days)
    .slice(0, max);
}

/** Sample dates relative to `now`, for the gallery. */
export function demoEvents(now: number): CountdownEvent[] {
  return [
    { name: 'Project deadline', date: dayOffset(now, 1) },
    { name: 'Holidays', date: dayOffset(now, 5) },
    { name: 'Linear algebra exam', date: dayOffset(now, 26) },
    { name: 'Conference talk', date: dayOffset(now, 74) },
  ];
}

const OPTIONS = t.object({
  events: t.list(
    t.object({
      name: t.string({ label: { en: 'What', es: 'Qué' }, placeholder: 'Holidays' }),
      date: t.string({ format: 'date', label: { en: 'Date', es: 'Fecha' }, placeholder: '2027-01-25' }),
    }),
    { label: { en: 'Dates', es: 'Fechas' }, help: { en: 'Past dates hide themselves.', es: 'Las fechas pasadas desaparecen solas.' } },
  ),
  max: t.integer({ default: 4, min: 1, max: 8, label: { en: 'How many to show', es: 'Cuántas mostrar' } }),
});

export const countdown = defineWidget<typeof OPTIONS, CountdownEvent[]>({
  id: 'countdown',
  name: { en: 'Countdown', es: 'Cuenta atrás' },
  description: { en: 'Days left until your important dates, nearest first.', es: 'Los días que faltan para tus fechas importantes, la más cercana primero.' },
  icon: 'hourglass',
  category: 'time',
  tags: ['magicmirror', 'dates'],
  size: { min: { w: 240, h: 100 }, preferred: { w: 400, h: 300 } },
  options: OPTIONS,
  redraw: 'minute',
  render(g, { box, options, data, now, theme, kit, t: tr, preview }) {
    const { colors, fonts } = theme;
    // Unconfigured in the editor: show what it would look like.
    const events = options.events.length ? options.events : preview ? (data ?? demoEvents(now)) : [];
    const list = upcoming(events, now, Math.max(1, options.max));
    if (!list.length) {
      const s = clamp(box.h * 0.3, 12, 36);
      const msg = tr({ en: 'Nothing coming up', es: 'Nada a la vista' });
      kit.drawTracked(g, kit.truncate(g, msg, box.w, { size: s, family: fonts.sans }), box.x, box.y + s * 1.1, { size: s, family: fonts.sans, color: colors.inkDim });
      return;
    }
    const rowH = Math.min(96, box.h / list.length);
    const size = Math.round(clamp(Math.min(rowH * 0.62, box.w / 8), 12, 48));
    const unitSize = Math.round(size * 0.5);
    // The number, right-aligned in its column, as wide as the longest one.
    const numW = Math.max(...list.map((e) => kit.measureTracked(g, String(e.days), { size, family: fonts.sans })), kit.measureTracked(g, '00', { size, family: fonts.sans }));
    const daysWord = tr({ en: 'days', es: 'días' });
    const unitW = kit.measureTracked(g, daysWord, { size: unitSize, family: fonts.sans });
    const nx = box.x + numW + size * 0.18 + unitW + size * 0.35;
    // One size for every name: the largest at which they all fit (within limits).
    const nameSize = Math.min(...list.map((e) => kit.fitSize(g, e.name, box.x + box.w - nx, { size: Math.round(size * 0.8), family: fonts.sans }, Math.max(11, Math.round(size * 0.5)))));
    list.forEach((e, i) => {
      const base = box.y + i * rowH + rowH / 2 + size * 0.36;
      const color = e.days <= 1 ? colors.alert : e.days <= 7 ? colors.warn : colors.ink;
      if (e.days > 1) {
        kit.drawTracked(g, String(e.days), box.x + numW, base, { size, family: fonts.sans, color, align: 'right' });
        kit.drawTracked(g, daysWord, box.x + numW + size * 0.18, base, { size: unitSize, family: fonts.sans, color: colors.inkDim });
      } else {
        // "today" / "tomorrow" take the number's place, in its colour.
        const word = e.days === 0 ? tr({ en: 'today', es: 'hoy' }) : tr({ en: 'tomorrow', es: 'mañana' });
        const ws = kit.fitSize(g, word, nx - box.x - size * 0.3, { size: Math.round(size * 0.8), family: fonts.sans }, unitSize);
        kit.drawTracked(g, word, box.x, base, { size: ws, family: fonts.sans, color });
      }
      const name = kit.truncate(g, e.name, box.x + box.w - nx, { size: nameSize, family: fonts.sans });
      kit.drawTracked(g, name, nx, base, { size: nameSize, family: fonts.sans, color: colors.ink });
    });
  },
  // Configured with options only: the sample dates are drawn by `render` in the editor.
  demo: ({ now }) => ({ data: demoEvents(now) }),
});
