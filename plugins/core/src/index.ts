/**
 * Basic widgets that every panel wants: a clock, the date, a note, a list, a
 * picture. Also the reference for plugin authors: small, typed and with demo
 * data. `list` is the reference for the shared list options (`listOptions`,
 * `listLayout`, `drawMore`, `drawEmpty`, `empty`).
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createFormatters, definePlugin, expandPath, defineWidget, drawEmpty, drawMore, listLayout, listOptions, t, type Graphics, type RenderContext } from '@kiosko/sdk';

/** The largest size at which `text` fits `w×h` (one line). */
function fit(g: Graphics, text: string, family: string, w: number, h: number, max = 400): number {
  let size = Math.min(max, h);
  g.font = `${size}px "${family}"`;
  const width = g.measureText(text).width;
  if (width > w) size = Math.floor((size * w) / width);
  return Math.max(8, size);
}

/** ISO 8601 week number (weeks start on Monday; week 1 holds the first Thursday). */
export function isoWeek(d: Date): number {
  const t0 = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t0.setUTCDate(t0.getUTCDate() + 4 - (t0.getUTCDay() || 7));
  return Math.ceil(((t0.getTime() - Date.UTC(t0.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
}

/** Date options of `core/clock`'s `dateFormat`. */
const DATE_FORMATS: Record<'long' | 'short' | 'numeric', Intl.DateTimeFormatOptions> = {
  long: { weekday: 'long', day: 'numeric', month: 'long' },
  short: { weekday: 'short', day: 'numeric', month: 'short' },
  numeric: { day: 'numeric', month: 'numeric', year: 'numeric' },
};

/**
 * `now` moved so that this computer's local clock reads what a clock in
 * `timeZone` reads, for the formatters (which paint local time). Empty or
 * unknown zone: `now`. In the hour a local daylight-saving change skips, a
 * wall time that doesn't exist here comes out an hour later.
 */
export function wallClock(now: number, timeZone: string): number {
  const zone = timeZone.trim();
  if (!zone) return now;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(now);
    const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return new Date(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'), ((now % 1000) + 1000) % 1000).getTime();
  } catch {
    return now;
  }
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
    showSeconds: t.boolean({ label: { en: 'Show seconds', es: 'Mostrar segundos' } }),
    timeFormat: t.enum(['inherit', '24h', '12h'] as const, {
      label: { en: 'Time format', es: 'Formato de hora' },
      labels: { inherit: { en: 'As in Settings', es: 'Como en Ajustes' }, '24h': { en: '24 hours', es: '24 horas' }, '12h': { en: '12 hours', es: '12 horas' } },
    }),
    showDate: t.boolean({ default: true, label: { en: 'Show the date below', es: 'Fecha debajo' } }),
    dateFormat: t.enum(['long', 'short', 'numeric'] as const, {
      label: { en: 'Date format', es: 'Formato de la fecha' },
      labels: { long: { en: 'Long: Monday, 10 November', es: 'Larga: lunes, 10 de noviembre' }, short: { en: 'Short: Mon, 10 Nov', es: 'Corta: lun, 10 nov' }, numeric: { en: 'Numbers: 10/11/2026', es: 'En cifras: 10/11/2026' } },
      help: { en: 'The long one gets small on a narrow tile.', es: 'La larga se queda pequeña en una tesela estrecha.' },
    }),
    timeZone: t.string({
      placeholder: 'America/New_York',
      label: { en: 'Time zone', es: 'Zona horaria' },
      help: { en: 'Empty: this computer\'s. A zone name (Europe/London, Asia/Tokyo) makes it the clock of another office; give the widget a title.', es: 'Vacía: la de este ordenador. Con el nombre de una zona (Europe/London, Asia/Tokyo) es el reloj de otra oficina; ponle un título al widget.' },
    }),
    color: t.enum(['ink', 'accent', 'dim'] as const, { label: { en: 'Colour', es: 'Color' }, labels: { ink: { en: 'Text', es: 'Texto' }, accent: { en: 'Accent', es: 'Acento' }, dim: { en: 'Dim', es: 'Tenue' } } }),
    align: t.enum(['center', 'left', 'right'] as const, { label: { en: 'Alignment', es: 'Alineación' } }),
  }),
  redraw: 'second',
  render(g, { box, now, options, theme, locale, fmt }) {
    const at = wallClock(now, options.timeZone);
    const clock = options.timeFormat === 'inherit' ? fmt : createFormatters({ locale, timeFormat: options.timeFormat, now });
    const text = clock.time(at, { seconds: options.showSeconds, ampm: false });
    const dateText = options.showDate ? new Date(at).toLocaleDateString(locale, DATE_FORMATS[options.dateFormat]) : '';
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
  options: t.object({
    weekdayColor: t.enum(['accent', 'ink', 'dim', 'alert'] as const, {
      label: { en: 'Weekday colour', es: 'Color del día de la semana' },
      labels: { accent: { en: 'Accent', es: 'Acento' }, ink: { en: 'Text', es: 'Texto' }, dim: { en: 'Dim', es: 'Tenue' }, alert: { en: 'Red, like a tear-off calendar', es: 'Rojo, como un taco de calendario' } },
      help: { en: 'On the panel red means "needs you"; a red weekday spends it every day.', es: 'En el panel el rojo significa «te necesita»; un día de la semana en rojo lo gasta a diario.' },
    }),
    showWeekNumber: t.boolean({ default: true, label: { en: 'Show week number', es: 'Número de semana' } }),
  }),
  redraw: 'minute',
  render(g, { box, now, options, theme, kit, locale, t: tr }) {
    const d = new Date(now);
    const weekday = d.toLocaleDateString(locale, { weekday: 'long' });
    const month = d.toLocaleDateString(locale, { month: 'long' });
    const top = Math.min(box.h * 0.16, 36);
    const c = theme.colors;
    const weekdayColor = { accent: c.accent, ink: c.ink, dim: c.inkDim, alert: c.alert }[options.weekdayColor];
    kit.drawTracked(g, weekday, box.x + box.w / 2, box.y + top, { size: top, family: theme.fonts.sansBold, color: weekdayColor, align: 'center', smallCaps: true, tracking: 2 });
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
    if (options.showWeekNumber) line += ` · ${tr({ en: 'wk', es: 'sem' })} ${isoWeek(d)}`;
    const ls = Math.min(ms, fit(g, line, theme.fonts.sans, box.w * 0.96, ms));
    g.font = `${ls}px "${theme.fonts.sans}"`;
    g.fillStyle = theme.colors.inkDim;
    g.textAlign = 'center';
    g.fillText(line, box.x + box.w / 2, bottom);
    g.textAlign = 'left';
  },
});

/** Where `core/text`'s `file` lives: `~/…` is the home folder. */
function expandHome(path: string): string {
  return expandPath(path.trim());
}

/** A file read by `core/text` is cut at this many characters: a note, not a log. */
const MAX_FILE_CHARS = 20_000;

export const text = defineWidget({
  id: 'text',
  name: { en: 'Text note', es: 'Nota de texto' },
  description: { en: 'A note or a motto, auto-sized to fill its tile; or the contents of a file a script writes.', es: 'Una nota o un lema, con la letra ajustada a la tesela; o lo que un script escribe en un fichero.' },
  icon: 'type',
  category: 'productivity',
  size: { min: { w: 120, h: 60 }, preferred: { w: 400, h: 160 } },
  options: t.object({
    text: t.string({ default: 'Hello, panel!', multiline: true, label: { en: 'Text', es: 'Texto' }, help: { en: 'With a file, shown until the file can be read.', es: 'Con un fichero, se ve hasta que se pueda leer.' } }),
    file: t.string({
      format: 'path',
      risk: 'path',
      placeholder: '~/status.txt',
      label: { en: 'Text file', es: 'Fichero de texto' },
      help: {
        en: 'Paints what a script writes there (on call, a deploy, the last backup), read again on every refresh. Empty: the text above.',
        es: 'Pinta lo que un script escribe ahí (guardia, despliegue, última copia), releído en cada refresco. Vacío: el texto de arriba.',
      },
    }),
    maxSize: t.integer({ default: 64, min: 10, max: 300, unit: 'px', slider: true, label: { en: 'Largest letter size', es: 'Tamaño máximo de letra' } }),
    font: t.enum(['sans', 'bold', 'mono'] as const, {
      label: { en: 'Font', es: 'Letra' },
      labels: { sans: { en: 'Regular', es: 'Normal' }, bold: { en: 'Bold', es: 'Negrita' }, mono: { en: 'Monospaced', es: 'Monoespaciada' } },
    }),
    align: t.enum(['left', 'center', 'right'] as const, { label: { en: 'Alignment', es: 'Alineación' }, labels: { left: { en: 'Left', es: 'Izquierda' }, center: { en: 'Centre', es: 'Centro' }, right: { en: 'Right', es: 'Derecha' } } }),
    valign: t.enum(['middle', 'top', 'bottom'] as const, {
      label: { en: 'Vertical alignment', es: 'Alineación vertical' },
      labels: { middle: { en: 'Middle', es: 'En medio' }, top: { en: 'Top', es: 'Arriba' }, bottom: { en: 'Bottom', es: 'Abajo' } },
    }),
    color: t.color({ default: '', label: { en: 'Colour (empty = theme)', es: 'Color (vacío = el del tema)' } }),
  }),
  intervalMs: 60_000,
  timeoutMs: 10_000,
  async fetch({ options, signal }): Promise<{ text: string | null }> {
    if (!options.file.trim()) return { text: null };
    const body = await readFile(expandHome(options.file), { encoding: 'utf8', signal });
    return { text: body.slice(0, MAX_FILE_CHARS).replace(/\s+$/, '') };
  },
  empty: ({ options, data }) => !noteOf(options, data).trim(),
  render(g, { box, options, data, theme, kit }) {
    const family = options.font === 'mono' ? theme.fonts.mono : options.font === 'bold' ? theme.fonts.sansBold : theme.fonts.sans;
    const paragraphs = noteOf(options, data).split('\n');
    let size = options.maxSize;
    let lines: string[] = [];
    for (;; size -= 2) {
      lines = paragraphs.flatMap((p) => (p.trim() ? kit.wrapLines(g, p, box.w, 50, { size, family }) : ['']));
      if (size - 2 < 10 || (lines.length * size * 1.2 <= box.h && !lines.some((l) => l.endsWith('…')))) break;
    }
    const lh = size * 1.2;
    const spare = Math.max(0, box.h - lines.length * lh);
    const top = box.y + (options.valign === 'top' ? 0 : options.valign === 'bottom' ? spare : spare / 2) + size * 0.85;
    const x = options.align === 'center' ? box.x + box.w / 2 : options.align === 'right' ? box.x + box.w : box.x;
    lines.forEach((l, i) => kit.drawTracked(g, l, x, top + i * lh, { size, family, color: options.color || theme.colors.ink, align: options.align }));
  },
});

/** What `core/text` paints: the file's contents once read, otherwise the text option. */
function noteOf(options: { text: string; file: string }, data: { text: string | null } | undefined): string {
  return options.file.trim() && typeof data?.text === 'string' ? data.text : options.text;
}

/** One entry of `core/list`: the text, and an optional detail after " | ". */
export function parseItems(text: string): { text: string; detail: string }[] {
  return text
    .split('\n')
    .map((line) => {
      const [head = '', ...rest] = line.split('|');
      return { text: head.trim(), detail: rest.join('|').trim() };
    })
    .filter((x) => x.text);
}

export const list = defineWidget({
  id: 'list',
  name: { en: 'List', es: 'Lista' },
  description: { en: 'A list you write: to-dos, reminders, the shopping. Shows what fits and how many more.', es: 'Una lista que escribes tú: pendientes, recordatorios, la compra. Muestra lo que cabe y cuántas más hay.' },
  icon: 'list',
  category: 'productivity',
  size: { min: { w: 160, h: 80 }, preferred: { w: 360, h: 240 } },
  options: t.object({
    items: t.string({
      default: 'Water the plants\nCall the bank | before 14:00\nBook the dentist | Dr. Ruiz, any morning\nBuy coffee',
      multiline: true,
      label: { en: 'Items', es: 'Elementos' },
      help: { en: 'One per line. Text after a "|" is a detail, shown under the item in the detailed layout.', es: 'Uno por línea. Lo que va tras una «|» es un detalle, que se ve debajo en el formato detallado.' },
    }),
    ...listOptions({ layouts: ['one-line', 'detailed'] }),
  }),
  empty: ({ options }) => !parseItems(options.items).length,
  render(g, ctx) {
    const { box, options, theme, kit } = ctx;
    const items = parseItems(options.items);
    if (!items.length) return drawEmpty(g, ctx, ctx.t({ en: 'Nothing on the list', es: 'Nada en la lista' }));
    const plan = listLayout(box, items.length, options, {
      sizes: { 'one-line': { min: 18, max: 44 }, detailed: { min: 36, max: 76 } },
      // Two lines only when some item has a detail and every row has room for them.
      auto: (b, n) => (items.some((x) => x.detail) && b.h / n >= 40 ? 'detailed' : 'one-line'),
      minRows: 3,
    });
    const detailed = plan.layout === 'detailed';
    const { textSize: ts, detailSize: ds } = plan;
    const dot = Math.max(2, ts * 0.22);
    const tx = box.x + dot * 4;
    plan.rows.forEach((row, i) => {
      const item = items[i]!;
      const base = detailed ? row.y + ts * 1.05 : row.y + plan.rowH * 0.5 + ts * 0.36;
      g.fillStyle = theme.colors.accent;
      g.beginPath();
      g.arc(box.x + dot * 1.5, base - ts * 0.34, dot, 0, Math.PI * 2);
      g.fill();
      const main = { size: ts, family: theme.fonts.sans, color: theme.colors.ink };
      kit.drawTracked(g, kit.truncate(g, item.text, box.x + box.w - tx, main), tx, base, main);
      if (detailed && item.detail) {
        const sub = { size: ds, family: theme.fonts.sans, color: theme.colors.inkDim };
        kit.drawTracked(g, kit.truncate(g, item.detail, box.x + box.w - tx, sub), tx, base + ds * 1.45, sub);
      }
    });
    drawMore(g, ctx, plan, { indent: tx - box.x });
  },
  demo: () => ({}),
});

interface ImageData {
  img: Awaited<ReturnType<RenderContext<unknown, unknown>['canvas']['loadImage']>> | null;
}

/** Files `core/image` shows from a folder. */
const IMAGE_FILE = /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i;

/** Picture last shown of each folder, so every refresh moves on to the next one. */
const turns = new Map<string, number>();

/** The next picture of a folder's (sorted by name), or null if it has none. */
export async function nextInFolder(dir: string): Promise<string | null> {
  const files = (await readdir(dir, { withFileTypes: true })).filter((f) => f.isFile() && IMAGE_FILE.test(f.name)).map((f) => f.name).sort((a, b) => a.localeCompare(b));
  if (!files.length) return null;
  const i = ((turns.get(dir) ?? -1) + 1) % files.length;
  turns.set(dir, i);
  return join(dir, files[i]!);
}

/**
 * The URL to fetch for an image: `{now}` (milliseconds) and `{unix}` (seconds)
 * become the current time, and `addTimestamp` appends `t=<milliseconds>`, so a
 * webcam that always serves the same address isn't answered from a cache.
 */
export function imageUrl(src: string, now: number, addTimestamp = false): string {
  const filled = src.replace(/\{now\}/g, String(now)).replace(/\{unix\}/g, String(Math.floor(now / 1000)));
  if (!addTimestamp || filled !== src) return filled;
  const u = new URL(filled);
  u.searchParams.set('t', String(now));
  return u.href;
}

type Position = 'center' | 'top' | 'bottom' | 'left' | 'right';

/** Where an image of `w×h` goes in `box` (cover: fills and crops; contain: whole), anchored at `position`. */
export function placeImage(box: { x: number; y: number; w: number; h: number }, w: number, h: number, fit: 'cover' | 'contain', position: Position): { x: number; y: number; w: number; h: number } {
  const s = fit === 'cover' ? Math.max(box.w / w, box.h / h) : Math.min(box.w / w, box.h / h);
  const dw = w * s, dh = h * s;
  const fx = position === 'left' ? 0 : position === 'right' ? 1 : 0.5;
  const fy = position === 'top' ? 0 : position === 'bottom' ? 1 : 0.5;
  return { x: box.x + (box.w - dw) * fx, y: box.y + (box.h - dh) * fy, w: dw, h: dh };
}

export const image = defineWidget({
  id: 'image',
  name: { en: 'Picture', es: 'Imagen' },
  description: { en: 'A local image, a folder of them in turn, or a URL (refreshed every few minutes, good for webcams and charts).', es: 'Una imagen local, una carpeta de ellas por turnos o una URL (se refresca cada pocos minutos: webcams, gráficas).' },
  icon: 'image',
  category: 'media',
  chrome: 'bare',
  size: { min: { w: 60, h: 60 }, preferred: { w: 400, h: 300 } },
  options: t.object({
    src: t.string({
      format: 'url',
      risk: ['network', 'path'],
      placeholder: 'https://… or /path/to/image.png',
      label: { en: 'Image (path, folder or URL)', es: 'Imagen (ruta, carpeta o URL)' },
      help: {
        en: 'A folder shows its pictures by name, the next one on every refresh. In a URL, {now} and {unix} become the current time (milliseconds, seconds).',
        es: 'Una carpeta enseña sus imágenes por orden de nombre, la siguiente en cada refresco. En una URL, {now} y {unix} se cambian por la hora actual (milisegundos, segundos).',
      },
    }),
    addTimestamp: t.boolean({
      label: { en: 'Add a timestamp to the URL', es: 'Añadir marca de tiempo a la URL' },
      help: {
        en: 'Appends t=<now> on every refresh, for webcams that would otherwise be served from a cache.',
        es: 'Añade t=<ahora> en cada refresco, para webcams que si no se sirven desde una caché.',
      },
    }),
    fit: t.enum(['cover', 'contain'] as const, { label: { en: 'Fit', es: 'Ajuste' }, labels: { cover: { en: 'Fill (crop)', es: 'Llenar (recorta)' }, contain: { en: 'Whole image', es: 'Imagen entera' } } }),
    position: t.enum(['center', 'top', 'bottom', 'left', 'right'] as const, {
      label: { en: 'Keep in view', es: 'Mantener a la vista' },
      labels: { center: { en: 'The centre', es: 'El centro' }, top: { en: 'The top', es: 'La parte de arriba' }, bottom: { en: 'The bottom', es: 'La parte de abajo' }, left: { en: 'The left', es: 'La izquierda' }, right: { en: 'The right', es: 'La derecha' } },
      help: { en: 'What filling crops last: the sky of a webcam, the axis of a chart.', es: 'Lo último que recorta al llenar: el cielo de una webcam, el eje de una gráfica.' },
    }),
    dim: t.integer({ default: 0, min: 0, max: 90, step: 5, unit: '%', slider: true, label: { en: 'Darken', es: 'Oscurecer' }, help: { en: 'Keeps a photo from outshining everything else.', es: 'Para que una foto no deslumbre al resto.' } }),
  }),
  intervalMs: 5 * 60_000,
  async fetch({ options, canvas, signal }): Promise<ImageData> {
    if (!options.src) return { img: null };
    if (/^https?:/.test(options.src)) {
      const res = await fetch(imageUrl(options.src, Date.now(), options.addTimestamp), { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { img: await canvas.loadImage(Buffer.from(await res.arrayBuffer())) };
    }
    const path = (await stat(options.src)).isDirectory() ? await nextInFolder(options.src) : options.src;
    if (!path) throw new Error(`no pictures in ${options.src}`);
    return { img: await canvas.loadImage(path) };
  },
  render(g, { box, data, options, theme, kit, t: tr }) {
    const img = data?.img;
    if (!img) {
      g.fillStyle = theme.colors.surface;
      g.fillRect(box.x, box.y, box.w, box.h);
      kit.drawTracked(g, options.src ? '…' : tr({ en: 'No image', es: 'Sin imagen' }), box.x + box.w / 2, box.y + box.h / 2, { size: Math.min(28, box.h / 4), family: theme.fonts.sans, color: theme.colors.inkFaint, align: 'center' });
      return;
    }
    const at = placeImage(box, img.width, img.height, options.fit, options.position);
    g.save();
    g.beginPath();
    g.rect(box.x, box.y, box.w, box.h);
    g.clip();
    g.drawImage(img, at.x, at.y, at.w, at.h);
    g.restore();
    if (options.dim > 0) {
      g.fillStyle = `rgba(0,0,0,${options.dim / 100})`;
      g.fillRect(box.x, box.y, box.w, box.h);
    }
  },
});

export default definePlugin({
  id: 'core',
  name: { en: 'Essentials', es: 'Básicos' },
  version: '0.2.1',
  description: { en: 'Clock, date, notes, lists and pictures.', es: 'Reloj, fecha, notas, listas e imágenes.' },
  author: 'Kiosko',
  license: 'MIT',
  icon: 'box',
  widgets: [clock, date, text, list, image],
});
