/**
 * Basic widgets that every panel wants: a clock, the date, a note, a picture.
 * Also the reference for plugin authors: small, typed and with demo data.
 */
import { definePlugin, defineWidget, t, type Graphics, type RenderContext } from '@kiosko/sdk';

const pad2 = (n: number) => String(n).padStart(2, '0');

/** The largest size at which `text` fits `w×h` (one line). */
function fit(g: Graphics, text: string, family: string, w: number, h: number, max = 400): number {
  let size = Math.min(max, h);
  g.font = `${size}px "${family}"`;
  const width = g.measureText(text).width;
  if (width > w) size = Math.floor((size * w) / width);
  return Math.max(8, size);
}

export const clock = defineWidget({
  id: 'clock',
  name: { en: 'Clock', es: 'Reloj' },
  description: { en: 'Big digital clock, with optional seconds and date.', es: 'Reloj digital grande, con segundos y fecha opcionales.' },
  icon: 'clock',
  category: 'time',
  chrome: 'bare',
  size: { min: { w: 120, h: 60 }, preferred: { w: 320, h: 200 } },
  options: t.object({
    seconds: t.boolean({ label: { en: 'Show seconds', es: 'Mostrar segundos' } }),
    hour12: t.boolean({ label: { en: '12-hour clock', es: 'Reloj de 12 horas' } }),
    showDate: t.boolean({ default: true, label: { en: 'Show the date below', es: 'Fecha debajo' } }),
    color: t.enum(['ink', 'accent', 'dim'] as const, { label: { en: 'Colour', es: 'Color' }, labels: { ink: { en: 'Text', es: 'Texto' }, accent: { en: 'Accent', es: 'Acento' }, dim: { en: 'Dim', es: 'Tenue' } } }),
    align: t.enum(['center', 'left', 'right'] as const, { label: { en: 'Alignment', es: 'Alineación' } }),
  }),
  redraw: 'second',
  render(g, { box, now, options, theme, kit, locale }) {
    const d = new Date(now);
    let h = d.getHours();
    if (options.hour12) h = h % 12 || 12;
    const text = `${options.hour12 ? h : pad2(h)}:${pad2(d.getMinutes())}${options.seconds ? `:${pad2(d.getSeconds())}` : ''}`;
    const dateText = options.showDate ? d.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' }) : '';
    const dateH = options.showDate ? Math.min(box.h * 0.2, 40) : 0;
    const size = fit(g, text, theme.fonts.monoBold, box.w * 0.96, (box.h - dateH * 1.3) * 0.95);
    const color = options.color === 'accent' ? theme.colors.accent : options.color === 'dim' ? theme.colors.inkDim : theme.colors.ink;
    const x = options.align === 'left' ? box.x : options.align === 'right' ? box.x + box.w : box.x + box.w / 2;
    const block = size * 0.78 + (dateH ? dateH * 1.4 : 0);
    const base = box.y + (box.h - block) / 2 + size * 0.78;
    g.textAlign = options.align;
    g.fillStyle = color;
    g.font = `${size}px "${theme.fonts.monoBold}"`;
    g.fillText(text, x, base);
    if (dateH) {
      const ds = Math.min(dateH, fit(g, dateText, theme.fonts.sans, box.w * 0.96, dateH));
      g.font = `${ds}px "${theme.fonts.sans}"`;
      g.fillStyle = theme.colors.inkDim;
      g.fillText(dateText, x, base + dateH * 1.35);
    }
    g.textAlign = 'left';
  },
});

export const date = defineWidget({
  id: 'date',
  name: { en: 'Calendar day', es: 'Día del calendario' },
  description: { en: 'Day of the month, weekday and week number, like a desk calendar.', es: 'El día del mes, de la semana y el número de semana, como un taco de calendario.' },
  icon: 'calendar',
  category: 'time',
  size: { min: { w: 120, h: 120 }, preferred: { w: 220, h: 300 } },
  options: t.object({ weekNumber: t.boolean({ default: true, label: { en: 'Show week number', es: 'Número de semana' } }) }),
  redraw: 'minute',
  render(g, { box, now, options, theme, kit, locale }) {
    const d = new Date(now);
    const weekday = d.toLocaleDateString(locale, { weekday: 'long' });
    const month = d.toLocaleDateString(locale, { month: 'long' });
    const top = Math.min(box.h * 0.16, 36);
    kit.drawTracked(g, weekday, box.x + box.w / 2, box.y + top, { size: top, family: theme.fonts.sansBold, color: theme.colors.alert, align: 'center', smallCaps: true, tracking: 2 });
    const num = String(d.getDate());
    const size = fit(g, num, theme.fonts.sansBold, box.w * 0.9, box.h * 0.56);
    g.font = `${size}px "${theme.fonts.sansBold}"`;
    g.fillStyle = theme.colors.ink;
    g.textAlign = 'center';
    g.fillText(num, box.x + box.w / 2, box.y + top * 1.4 + size * 0.86);
    g.textAlign = 'left';
    const bottom = box.y + box.h - 4;
    const ms = Math.min(top, box.h * 0.13);
    let line = month;
    if (options.weekNumber) {
      const t0 = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
      const day = t0.getUTCDay() || 7;
      t0.setUTCDate(t0.getUTCDate() + 4 - day);
      const week = Math.ceil(((t0.getTime() - Date.UTC(t0.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
      line += ` · ${locale.startsWith('es') ? 'sem' : 'wk'} ${week}`;
    }
    const ls = Math.min(ms, fit(g, line, theme.fonts.sans, box.w * 0.96, ms));
    g.font = `${ls}px "${theme.fonts.sans}"`;
    g.fillStyle = theme.colors.inkDim;
    g.textAlign = 'center';
    g.fillText(line, box.x + box.w / 2, bottom);
    g.textAlign = 'left';
  },
});

export const text = defineWidget({
  id: 'text',
  name: { en: 'Text note', es: 'Nota de texto' },
  description: { en: 'A note or a motto, auto-sized to fill its tile.', es: 'Una nota o un lema, con la letra ajustada a la tesela.' },
  icon: 'type',
  category: 'productivity',
  size: { min: { w: 120, h: 60 }, preferred: { w: 400, h: 160 } },
  options: t.object({
    text: t.string({ default: 'Hello, panel!', multiline: true, label: { en: 'Text', es: 'Texto' } }),
    maxSize: t.integer({ default: 64, min: 10, max: 300, unit: 'px', slider: true, label: { en: 'Largest letter size', es: 'Tamaño máximo de letra' } }),
    align: t.enum(['left', 'center', 'right'] as const, { label: { en: 'Alignment', es: 'Alineación' } }),
    mono: t.boolean({ label: { en: 'Monospaced', es: 'Monoespaciada' } }),
    color: t.color({ default: '', label: { en: 'Colour (empty = theme)', es: 'Color (vacío = el del tema)' } }),
  }),
  render(g, { box, options, theme, kit }) {
    const family = options.mono ? theme.fonts.mono : theme.fonts.sans;
    let size = options.maxSize;
    let lines: string[] = [];
    const paragraphs = options.text.split('\n');
    for (; size >= 10; size -= 2) {
      lines = paragraphs.flatMap((p) => (p.trim() ? kit.wrapLines(g, p, box.w, 50, { size, family }) : ['']));
      if (lines.length * size * 1.2 <= box.h && !lines.some((l) => l.endsWith('…'))) break;
    }
    const lh = size * 1.2;
    const top = box.y + Math.max(0, (box.h - lines.length * lh) / 2) + size * 0.85;
    const x = options.align === 'center' ? box.x + box.w / 2 : options.align === 'right' ? box.x + box.w : box.x;
    lines.forEach((l, i) => kit.drawTracked(g, l, x, top + i * lh, { size, family, color: options.color || theme.colors.ink, align: options.align }));
  },
});

interface ImageData {
  img: Awaited<ReturnType<RenderContext<unknown, unknown>['canvas']['loadImage']>> | null;
}

export const image = defineWidget({
  id: 'image',
  name: { en: 'Picture', es: 'Imagen' },
  description: { en: 'A local image or a URL (refreshed every few minutes, good for webcams and charts).', es: 'Una imagen local o una URL (se refresca cada pocos minutos: webcams, gráficas).' },
  icon: 'image',
  category: 'media',
  chrome: 'bare',
  size: { min: { w: 60, h: 60 }, preferred: { w: 400, h: 300 } },
  options: t.object({
    src: t.string({ format: 'url', placeholder: 'https://… or /path/to/image.png', label: { en: 'Image (path or URL)', es: 'Imagen (ruta o URL)' } }),
    fit: t.enum(['cover', 'contain'] as const, { label: { en: 'Fit', es: 'Ajuste' }, labels: { cover: { en: 'Fill (crop)', es: 'Llenar (recorta)' }, contain: { en: 'Whole image', es: 'Imagen entera' } } }),
    dim: t.number({ default: 0, min: 0, max: 0.9, step: 0.05, slider: true, label: { en: 'Darken', es: 'Oscurecer' }, help: { en: 'Keeps a photo from outshining everything else.', es: 'Para que una foto no deslumbre al resto.' } }),
  }),
  intervalMs: 5 * 60_000,
  async fetch({ options, canvas, signal }): Promise<ImageData> {
    if (!options.src) return { img: null };
    if (/^https?:/.test(options.src)) {
      const res = await fetch(options.src, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { img: await canvas.loadImage(Buffer.from(await res.arrayBuffer())) };
    }
    return { img: await canvas.loadImage(options.src) };
  },
  render(g, { box, data, options, theme, kit }) {
    const img = data?.img;
    if (!img) {
      g.fillStyle = theme.colors.surface;
      g.fillRect(box.x, box.y, box.w, box.h);
      kit.drawTracked(g, options.src ? '…' : 'No image', box.x + box.w / 2, box.y + box.h / 2, { size: Math.min(28, box.h / 4), family: theme.fonts.sans, color: theme.colors.inkFaint, align: 'center' });
      return;
    }
    const s = options.fit === 'cover' ? Math.max(box.w / img.width, box.h / img.height) : Math.min(box.w / img.width, box.h / img.height);
    const w = img.width * s, h = img.height * s;
    g.drawImage(img, box.x + (box.w - w) / 2, box.y + (box.h - h) / 2, w, h);
    if (options.dim > 0) {
      g.fillStyle = `rgba(0,0,0,${options.dim})`;
      g.fillRect(box.x, box.y, box.w, box.h);
    }
  },
});

export default definePlugin({
  id: 'core',
  name: { en: 'Essentials', es: 'Básicos' },
  version: '0.1.0',
  description: { en: 'Clock, date, notes and pictures.', es: 'Reloj, fecha, notas e imágenes.' },
  author: 'Kiosko',
  license: 'MIT',
  icon: 'box',
  widgets: [clock, date, text, image],
});
