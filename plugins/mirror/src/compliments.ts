/**
 * A phrase for the time of day. A port of the `compliments` module that ships
 * with MagicMirror²: lists for the morning, the afternoon, the evening and
 * any time, and the phrase changes every `changeMs`.
 */
import { defineWidget, t } from '@tessera/sdk';
import { clamp, isEs } from './util.ts';

export interface Phrases {
  morning: string[];
  afternoon: string[];
  evening: string[];
  anytime: string[];
}

/** Used while the user hasn't written any list of their own. */
export const BUILTIN_PHRASES: Record<'en' | 'es', Phrases> = {
  en: {
    morning: ['Good morning.', 'Coffee first, commits later.', 'Today the tests pass on the first try.'],
    afternoon: ['A good afternoon to close a few issues.', 'Take a break, then carry on.'],
    evening: ['Time to commit and switch off.', 'Whatever is not done can wait until tomorrow.'],
    anytime: ['Breathe.', 'Drink some water.', 'One thing at a time.'],
  },
  es: {
    morning: ['Buenos días.', 'Café primero, commits después.', 'Hoy los tests pasan a la primera.'],
    afternoon: ['Buena tarde para cerrar issues.', 'Un descanso y sigues.'],
    evening: ['Hora de commitear y desconectar.', 'Lo que no esté hecho, mañana.'],
    anytime: ['Respira.', 'Bebe agua.', 'Una cosa cada vez.'],
  },
};

/** The user's lists, or the built-in ones in their language when they wrote none. */
export function phrasesFor(p: Phrases, locale: string): Phrases {
  const own = p.morning.length + p.afternoon.length + p.evening.length + p.anytime.length > 0;
  return own ? p : BUILTIN_PHRASES[isEs(locale) ? 'es' : 'en'];
}

/** The phrases for this hour: morning from 3 to 12, afternoon from 12 to 17, evening the rest. */
export function poolFor(p: Phrases, hour: number): string[] {
  const slot = hour >= 3 && hour < 12 ? p.morning : hour >= 12 && hour < 17 ? p.afternoon : p.evening;
  return [...slot, ...p.anytime].filter((s) => s.trim());
}

/** The phrase of this moment: stable for `changeMs`, the same on every repaint. */
export function pick(p: Phrases, now: number, changeMs: number): string | null {
  const pool = poolFor(p, new Date(now).getHours());
  if (!pool.length) return null;
  return pool[Math.floor(now / Math.max(60_000, changeMs)) % pool.length]!;
}

const listField = (en: string, es: string) =>
  t.list(t.string({ placeholder: '…' }), { label: { en, es }, help: { en: 'Leave every list empty to use the built-in phrases, in your language.', es: 'Con todas las listas vacías salen las frases de serie, en tu idioma.' } });

export const compliments = defineWidget({
  id: 'compliments',
  name: { en: 'Compliments', es: 'Frases' },
  description: { en: 'A phrase that suits the time of day, like the MagicMirror² classic.', es: 'Una frase según la hora del día, como el clásico de MagicMirror².' },
  icon: 'quote',
  category: 'fun',
  tags: ['magicmirror', 'motivation'],
  size: { min: { w: 200, h: 80 }, preferred: { w: 600, h: 220 } },
  options: t.object({
    morning: listField('Morning (3–12 h)', 'Mañana (3–12 h)'),
    afternoon: listField('Afternoon (12–17 h)', 'Tarde (12–17 h)'),
    evening: listField('Evening and night', 'Noche'),
    anytime: listField('Any time', 'A cualquier hora'),
    changeMs: t.duration({ default: 30 * 60_000, min: 60_000, label: { en: 'Change every', es: 'Cambia cada' } }),
    maxSize: t.integer({ default: 56, min: 16, max: 200, unit: 'px', slider: true, label: { en: 'Largest letter size', es: 'Tamaño máximo de letra' } }),
    align: t.enum(['left', 'center'] as const, { label: { en: 'Alignment', es: 'Alineación' }, labels: { left: { en: 'Left', es: 'Izquierda' }, center: { en: 'Centre', es: 'Centro' } } }),
  }),
  redraw: 'minute',
  render(g, { box, options, now, theme, kit, locale }) {
    const text = pick(phrasesFor(options, locale), now, options.changeMs);
    if (!text) return;
    const family = theme.fonts.sans;
    // The largest size at which it fits in up to four lines without an ellipsis.
    let size = Math.round(clamp(options.maxSize, 12, box.h));
    let lines: string[] = [];
    for (; size >= 12; size -= 2) {
      const maxLines = Math.max(1, Math.min(4, Math.floor(box.h / (size * 1.2))));
      lines = kit.wrapLines(g, text, box.w, maxLines, { size, family });
      if (lines.length * size * 1.2 <= box.h && !lines.at(-1)?.endsWith('…')) break;
    }
    const lh = size * 1.2;
    const top = box.y + (box.h - lines.length * lh) / 2 + size * 0.85;
    const x = options.align === 'center' ? box.x + box.w / 2 : box.x;
    lines.forEach((l, i) => kit.drawTracked(g, l, x, top + i * lh, { size, family, color: theme.colors.ink, align: options.align }));
  },
  // Needs no data: the built-in phrases are its sample.
  demo: () => ({}),
});
