/**
 * Basic widgets that every panel wants: a clock, the date, a note, a list, a
 * picture. Also the reference for plugin authors: small, typed and with demo
 * data. `list` is the reference for the shared list options (`listOptions`,
 * `listLayout`, `drawMore`, `drawEmpty`, `empty`).
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { jsonList, jsonText, jsonValue } from './json.ts';
import { push, pushSource } from './push.ts';
import { createFormatters, definePlugin, hanScript, expandPath, defineWidget, drawEmpty, drawMore, listLayout, listOptions, t, type Graphics, type RenderContext } from '@kiosko/sdk';

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
  name: { en: 'Clock', es: 'Reloj', de: 'Uhr', 'zh-Hant': '時鐘', 'zh-Hans': '时钟' },
  description: { en: 'Big digital clock, with optional seconds and date.', es: 'Reloj digital grande, con segundos y fecha opcionales.', de: 'Große Digitaluhr, wahlweise mit Sekunden und Datum.', 'zh-Hant': '大型數位時鐘，可選擇顯示秒數和日期。', 'zh-Hans': '大号数字时钟，可选显示秒数和日期。' },
  icon: 'clock',
  category: 'time',
  chrome: 'bare',
  size: { min: { w: 120, h: 60 }, preferred: { w: 320, h: 200 } },
  options: t.object({
    showSeconds: t.boolean({ label: { en: 'Show seconds', es: 'Mostrar segundos', de: 'Sekunden anzeigen', 'zh-Hant': '顯示秒數', 'zh-Hans': '显示秒数' } }),
    timeFormat: t.enum(['inherit', '24h', '12h'] as const, {
      label: { en: 'Time format', es: 'Formato de hora', de: 'Zeitformat', 'zh-Hant': '時間格式', 'zh-Hans': '时间格式' },
      labels: { inherit: { en: 'As in Settings', es: 'Como en Ajustes', de: 'Wie in den Einstellungen', 'zh-Hant': '依照設定', 'zh-Hans': '跟随设置' }, '24h': { en: '24 hours', es: '24 horas', de: '24 Stunden', 'zh-Hant': '24 小時制', 'zh-Hans': '24 小时制' }, '12h': { en: '12 hours', es: '12 horas', de: '12 Stunden', 'zh-Hant': '12 小時制', 'zh-Hans': '12 小时制' } },
    }),
    showDate: t.boolean({ default: true, label: { en: 'Show the date below', es: 'Fecha debajo', de: 'Datum darunter anzeigen', 'zh-Hant': '在下方顯示日期', 'zh-Hans': '在下方显示日期' } }),
    dateFormat: t.enum(['long', 'short', 'numeric'] as const, {
      label: { en: 'Date format', es: 'Formato de la fecha', de: 'Datumsformat', 'zh-Hant': '日期格式', 'zh-Hans': '日期格式' },
      labels: { long: { en: 'Long: Monday, 10 November', es: 'Larga: lunes, 10 de noviembre', de: 'Lang: Montag, 10. November', 'zh-Hant': '長：11月10日星期一', 'zh-Hans': '长：11月10日星期一' }, short: { en: 'Short: Mon, 10 Nov', es: 'Corta: lun, 10 nov', de: 'Kurz: Mo., 10. Nov.', 'zh-Hant': '短：11月10日週一', 'zh-Hans': '短：11月10日周一' }, numeric: { en: 'Numbers: 10/11/2026', es: 'En cifras: 10/11/2026', de: 'Zahlen: 10.11.2026', 'zh-Hant': '數字：2026/11/10', 'zh-Hans': '数字：2026/11/10' } },
      help: { en: 'The long one gets small on a narrow tile.', es: 'La larga se queda pequeña en una tesela estrecha.', de: 'Das lange wird auf einer schmalen Kachel klein.', 'zh-Hant': '方格較窄時，長格式會變得很小。', 'zh-Hans': '格子较窄时，长格式会变得很小。' },
    }),
    timeZone: t.string({
      placeholder: 'America/New_York',
      label: { en: 'Time zone', es: 'Zona horaria', de: 'Zeitzone', 'zh-Hant': '時區', 'zh-Hans': '时区' },
      help: { en: 'Empty: this computer\'s. A zone name (Europe/London, Asia/Tokyo) makes it the clock of another office; give the widget a title.', es: 'Vacía: la de este ordenador. Con el nombre de una zona (Europe/London, Asia/Tokyo) es el reloj de otra oficina; ponle un título al widget.', de: 'Leer: die dieses Computers. Ein Zonenname (Europe/London, Asia/Tokyo) macht sie zur Uhr eines anderen Büros; gib dem Widget einen Titel.', 'zh-Hant': '留空：使用這台電腦的時區。填入時區名稱（Europe/London、Asia/Tokyo）就成了另一間辦公室的時鐘；記得幫小工具加上標題。', 'zh-Hans': '留空：使用这台电脑的时区。填写时区名称（Europe/London、Asia/Tokyo）就成了另一个办公室的时钟；记得给小组件加个标题。' },
    }),
    color: t.enum(['ink', 'accent', 'dim'] as const, { label: { en: 'Colour', es: 'Color', de: 'Farbe', 'zh-Hant': '顏色', 'zh-Hans': '颜色' }, labels: { ink: { en: 'Text', es: 'Texto', de: 'Text', 'zh-Hant': '文字', 'zh-Hans': '文字' }, accent: { en: 'Accent', es: 'Acento', de: 'Akzent', 'zh-Hant': '強調色', 'zh-Hans': '强调色' }, dim: { en: 'Dim', es: 'Tenue', de: 'Gedämpft', 'zh-Hant': '淡色', 'zh-Hans': '暗淡' } } }),
    align: t.enum(['center', 'left', 'right'] as const, { label: { en: 'Alignment', es: 'Alineación', de: 'Ausrichtung', 'zh-Hant': '對齊', 'zh-Hans': '对齐' } }),
  }),
  // Without seconds it changes once a minute: repainting it every second only
  // made the same picture (and the whole screen's frame encoded) again.
  redraw: ({ options }) => (options.showSeconds ? 'second' : 'minute'),
  render(g, { box, now, options, theme, locale, fmt }) {
    const at = wallClock(now, options.timeZone);
    const clock = options.timeFormat === 'inherit' ? fmt : createFormatters({ locale, timeFormat: options.timeFormat, now });
    const text = clock.time(at, { seconds: options.showSeconds, ampm: false });
    // On a 12-hour clock, AM/PM small beside the digits (before them in Chinese: 下午 4:50), or
    // 4:50 would be the morning and the afternoon alike.
    const full = clock.hour12 ? clock.time(at, { seconds: options.showSeconds }) : text;
    const mark = full === text ? '' : full.replace(text, '').trim();
    const markFirst = !!mark && full.startsWith(mark);
    const dateText = options.showDate ? new Date(at).toLocaleDateString(locale, DATE_FORMATS[options.dateFormat]) : '';
    const dateH = options.showDate ? Math.min(box.h * 0.2, 40) : 0;
    const size = fit(g, text, theme.fonts.monoBold, box.w * (mark ? 0.76 : 0.96), (box.h - dateH * 1.3) * 0.95);
    const color = options.color === 'accent' ? theme.colors.accent : options.color === 'dim' ? theme.colors.inkDim : theme.colors.ink;
    const block = size * 0.78 + (dateH ? dateH * 1.4 : 0);
    const base = box.y + (box.h - block) / 2 + size * 0.78;
    g.font = `${size}px "${theme.fonts.monoBold}"`;
    const digitsW = g.measureText(text).width;
    const markSize = Math.max(8, Math.round(size * 0.26));
    g.font = `${markSize}px "${theme.fonts.sansBold}"`;
    const markW = mark ? g.measureText(mark).width + size * 0.08 : 0;
    const total = digitsW + markW;
    const left = options.align === 'left' ? box.x : options.align === 'right' ? box.x + box.w - total : box.x + (box.w - total) / 2;
    const digitsX = markFirst ? left + markW : left;
    g.textAlign = 'left';
    g.fillStyle = color;
    g.font = `${size}px "${theme.fonts.monoBold}"`;
    g.fillText(text, digitsX, base);
    if (mark) {
      // Its top level with the digits' top.
      g.fillStyle = theme.colors.inkDim;
      g.font = `${markSize}px "${theme.fonts.sansBold}"`;
      g.fillText(mark, markFirst ? left : left + digitsW + size * 0.08, base - size * 0.78 + markSize * 0.92);
    }
    const x = options.align === 'left' ? box.x : options.align === 'right' ? box.x + box.w : box.x + box.w / 2;
    g.textAlign = options.align;
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
  name: { en: 'Calendar day', es: 'Día del calendario', de: 'Kalendertag', 'zh-Hant': '日曆', 'zh-Hans': '日历' },
  description: { en: 'Day of the month, weekday and week number, like a desk calendar.', es: 'El día del mes, de la semana y el número de semana, como un taco de calendario.', de: 'Tag des Monats, Wochentag und Kalenderwoche, wie ein Tischkalender.', 'zh-Hant': '當月日期、星期和週數，就像桌曆一樣。', 'zh-Hans': '当月日期、星期和周数，就像台历一样。' },
  icon: 'calendar',
  category: 'time',
  size: { min: { w: 120, h: 120 }, preferred: { w: 220, h: 300 } },
  options: t.object({
    weekdayColor: t.enum(['accent', 'ink', 'dim', 'alert'] as const, {
      label: { en: 'Weekday colour', es: 'Color del día de la semana', de: 'Farbe des Wochentags', 'zh-Hant': '星期顏色', 'zh-Hans': '星期颜色' },
      labels: { accent: { en: 'Accent', es: 'Acento', de: 'Akzent', 'zh-Hant': '強調色', 'zh-Hans': '强调色' }, ink: { en: 'Text', es: 'Texto', de: 'Text', 'zh-Hant': '文字', 'zh-Hans': '文字' }, dim: { en: 'Dim', es: 'Tenue', de: 'Gedämpft', 'zh-Hant': '淡色', 'zh-Hans': '暗淡' }, alert: { en: 'Red, like a tear-off calendar', es: 'Rojo, como un taco de calendario', de: 'Rot, wie ein Abreißkalender', 'zh-Hant': '紅色，像撕頁日曆', 'zh-Hans': '红色，像手撕日历' } },
      help: { en: 'On the panel red means "needs you"; a red weekday spends it every day.', es: 'En el panel el rojo significa «te necesita»; un día de la semana en rojo lo gasta a diario.', de: 'Auf dem Panel heißt Rot „braucht dich“; ein roter Wochentag verbraucht das jeden Tag.', 'zh-Hant': '在面板上，紅色代表「需要你」；星期用紅色等於每天都在消耗它。', 'zh-Hans': '在屏幕上，红色代表“需要你”；星期用红色等于每天都在消耗它。' },
    }),
    showWeekNumber: t.boolean({ default: true, label: { en: 'Show week number', es: 'Número de semana', de: 'Kalenderwoche anzeigen', 'zh-Hant': '顯示週數', 'zh-Hans': '显示周数' } }),
  }),
  redraw: 'minute',
  render(g, { box, now, options, theme, kit, locale, t: tr }) {
    const d = new Date(now);
    const weekday = d.toLocaleDateString(locale, { weekday: 'long' });
    // Chinese writes the month as a number in both scripts (11月), not 十一月.
    const month = d.toLocaleDateString(locale, { month: hanScript(locale) ? 'short' : 'long' });
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
    if (options.showWeekNumber) line += ` · ${tr({ en: 'wk {n}', es: 'sem {n}', de: 'KW {n}', 'zh-Hant': '第 {n} 週', 'zh-Hans': '第 {n} 周' }).replace('{n}', String(isoWeek(d)))}`;
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
  name: { en: 'Text note', es: 'Nota de texto', de: 'Textnotiz', 'zh-Hant': '文字便條', 'zh-Hans': '文字便签' },
  description: { en: 'A note or a motto, auto-sized to fill its tile; or the contents of a file a script writes.', es: 'Una nota o un lema, con la letra ajustada a la tesela; o lo que un script escribe en un fichero.', de: 'Eine Notiz oder ein Motto, in der Größe an die Kachel angepasst; oder der Inhalt einer Datei, die ein Skript schreibt.', 'zh-Hant': '一則便條或座右銘，字體自動縮放填滿方格；或是顯示腳本寫入檔案的內容。', 'zh-Hans': '一条便签或座右铭，字号自动缩放填满格子；或者显示脚本写入文件的内容。' },
  icon: 'type',
  category: 'productivity',
  size: { min: { w: 120, h: 60 }, preferred: { w: 400, h: 160 } },
  options: t.object({
    text: t.string({ default: 'Hello, panel!', multiline: true, label: { en: 'Text', es: 'Texto', de: 'Text', 'zh-Hant': '文字', 'zh-Hans': '文字' }, help: { en: 'With a file, shown until the file can be read.', es: 'Con un fichero, se ve hasta que se pueda leer.', de: 'Mit einer Datei: angezeigt, bis die Datei gelesen werden kann.', 'zh-Hant': '使用檔案時，在檔案可讀取之前顯示這段文字。', 'zh-Hans': '使用文件时，在文件可读取之前显示这段文字。' } }),
    file: t.string({
      format: 'path',
      risk: 'path',
      placeholder: '~/status.txt',
      label: { en: 'Text file', es: 'Fichero de texto', de: 'Textdatei', 'zh-Hant': '文字檔', 'zh-Hans': '文本文件' },
      help: {
        en: 'Paints what a script writes there (on call, a deploy, the last backup), read again on every refresh. Empty: the text above.',
        es: 'Pinta lo que un script escribe ahí (guardia, despliegue, última copia), releído en cada refresco. Vacío: el texto de arriba.',
        de: 'Zeigt, was ein Skript dort hineinschreibt (Bereitschaft, ein Deployment, das letzte Backup), bei jeder Aktualisierung neu gelesen. Leer: der Text oben.',
        'zh-Hant': '顯示腳本寫入的內容（值班、部署、上次備份），每次重新整理時重新讀取。留空：使用上方的文字。',
        'zh-Hans': '显示脚本写入的内容（值班、部署、上次备份），每次刷新时重新读取。留空：使用上方的文字。',
      },
    }),
    maxSize: t.integer({ default: 64, min: 10, max: 300, unit: 'px', slider: true, label: { en: 'Largest letter size', es: 'Tamaño máximo de letra', de: 'Größte Schriftgröße', 'zh-Hant': '最大字體大小', 'zh-Hans': '最大字号' } }),
    font: t.enum(['sans', 'bold', 'mono'] as const, {
      label: { en: 'Font', es: 'Letra', de: 'Schrift', 'zh-Hant': '字型', 'zh-Hans': '字体' },
      labels: { sans: { en: 'Regular', es: 'Normal', de: 'Normal', 'zh-Hant': '一般', 'zh-Hans': '常规' }, bold: { en: 'Bold', es: 'Negrita', de: 'Fett', 'zh-Hant': '粗體', 'zh-Hans': '粗体' }, mono: { en: 'Monospaced', es: 'Monoespaciada', de: 'Festbreite', 'zh-Hant': '等寬', 'zh-Hans': '等宽' } },
    }),
    align: t.enum(['left', 'center', 'right'] as const, { label: { en: 'Alignment', es: 'Alineación', de: 'Ausrichtung', 'zh-Hant': '對齊', 'zh-Hans': '对齐' }, labels: { left: { en: 'Left', es: 'Izquierda', de: 'Links', 'zh-Hant': '靠左', 'zh-Hans': '左对齐' }, center: { en: 'Centre', es: 'Centro', de: 'Mitte', 'zh-Hant': '置中', 'zh-Hans': '居中' }, right: { en: 'Right', es: 'Derecha', de: 'Rechts', 'zh-Hant': '靠右', 'zh-Hans': '右对齐' } } }),
    valign: t.enum(['middle', 'top', 'bottom'] as const, {
      label: { en: 'Vertical alignment', es: 'Alineación vertical', de: 'Vertikale Ausrichtung', 'zh-Hant': '垂直對齊', 'zh-Hans': '垂直对齐' },
      labels: { middle: { en: 'Middle', es: 'En medio', de: 'Mitte', 'zh-Hant': '置中', 'zh-Hans': '居中' }, top: { en: 'Top', es: 'Arriba', de: 'Oben', 'zh-Hant': '靠上', 'zh-Hans': '顶部' }, bottom: { en: 'Bottom', es: 'Abajo', de: 'Unten', 'zh-Hant': '靠下', 'zh-Hans': '底部' } },
    }),
    color: t.color({ default: '', label: { en: 'Colour (empty = theme)', es: 'Color (vacío = el del tema)', de: 'Farbe (leer = Design)', 'zh-Hant': '顏色（留空 = 主題色）', 'zh-Hans': '颜色（留空 = 主题色）' } }),
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
  name: { en: 'List', es: 'Lista', de: 'Liste', 'zh-Hant': '清單', 'zh-Hans': '列表' },
  description: { en: 'A list you write: to-dos, reminders, the shopping. Shows what fits and how many more.', es: 'Una lista que escribes tú: pendientes, recordatorios, la compra. Muestra lo que cabe y cuántas más hay.', de: 'Eine Liste, die du schreibst: Aufgaben, Erinnerungen, der Einkauf. Zeigt, was passt, und wie viele noch fehlen.', 'zh-Hant': '你自己寫的清單：待辦事項、提醒、購物清單。顯示放得下的項目，以及還有多少項。', 'zh-Hans': '你自己写的列表：待办事项、提醒、购物清单。显示放得下的条目，以及还有多少条。' },
  icon: 'list',
  category: 'productivity',
  size: { min: { w: 160, h: 80 }, preferred: { w: 360, h: 240 } },
  options: t.object({
    items: t.string({
      default: 'Water the plants\nCall the bank | before 14:00\nBook the dentist | Dr. Ruiz, any morning\nBuy coffee',
      multiline: true,
      label: { en: 'Items', es: 'Elementos', de: 'Einträge', 'zh-Hant': '項目', 'zh-Hans': '条目' },
      help: { en: 'One per line. Text after a "|" is a detail, shown under the item in the detailed layout.', es: 'Uno por línea. Lo que va tras una «|» es un detalle, que se ve debajo en el formato detallado.', de: 'Einer pro Zeile. Text nach einem „|“ ist ein Detail, das im ausführlichen Layout unter dem Eintrag steht.', 'zh-Hant': '每行一項。「|」後面的文字是細節，在詳細版面中顯示於項目下方。', 'zh-Hans': '每行一条。“|”后面的文字是详情，在详细布局中显示在条目下方。' },
    }),
    ...listOptions({ layouts: ['one-line', 'detailed'] }),
  }),
  empty: ({ options }) => !parseItems(options.items).length,
  render(g, ctx) {
    const { box, options, theme, kit } = ctx;
    const items = parseItems(options.items);
    if (!items.length) return drawEmpty(g, ctx, ctx.t({ en: 'Nothing on the list', es: 'Nada en la lista', de: 'Nichts auf der Liste', 'zh-Hant': '清單是空的', 'zh-Hans': '列表为空' }));
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

/**
 * A picture shrunk to the widest panel in another thread (a 12-megapixel
 * photo held every panel up to 130 ms the first time it was painted), or
 * whole on a canvas API without it (the browser demo).
 */
const load = (canvas: RenderContext<unknown, unknown>['canvas'], src: string | Buffer) =>
  canvas.loadImageScaled ? canvas.loadImageScaled(src, { width: 1920, height: 1080, fit: 'cover' }) : canvas.loadImage(src);

export const image = defineWidget({
  id: 'image',
  name: { en: 'Picture', es: 'Imagen', de: 'Bild', 'zh-Hant': '圖片', 'zh-Hans': '图片' },
  description: { en: 'A local image, a folder of them in turn, or a URL (refreshed every few minutes, good for webcams and charts).', es: 'Una imagen local, una carpeta de ellas por turnos o una URL (se refresca cada pocos minutos: webcams, gráficas).', de: 'Ein lokales Bild, ein Ordner voller Bilder im Wechsel oder eine URL (alle paar Minuten aktualisiert, gut für Webcams und Diagramme).', 'zh-Hant': '本機圖片、輪流顯示的圖片資料夾，或 URL（每隔幾分鐘重新整理，適合網路攝影機和圖表）。', 'zh-Hans': '本地图片、轮流显示的图片文件夹，或 URL（每隔几分钟刷新一次，适合网络摄像头和图表）。' },
  icon: 'image',
  category: 'media',
  chrome: 'bare',
  size: { min: { w: 60, h: 60 }, preferred: { w: 400, h: 300 } },
  options: t.object({
    src: t.string({
      format: 'url',
      risk: ['network', 'path'],
      placeholder: 'https://… or /path/to/image.png',
      label: { en: 'Image (path, folder or URL)', es: 'Imagen (ruta, carpeta o URL)', de: 'Bild (Pfad, Ordner oder URL)', 'zh-Hant': '圖片（路徑、資料夾或 URL）', 'zh-Hans': '图片（路径、文件夹或 URL）' },
      help: {
        en: 'A folder shows its pictures by name, the next one on every refresh. In a URL, {now} and {unix} become the current time (milliseconds, seconds).',
        es: 'Una carpeta enseña sus imágenes por orden de nombre, la siguiente en cada refresco. En una URL, {now} y {unix} se cambian por la hora actual (milisegundos, segundos).',
        de: 'Ein Ordner zeigt seine Bilder nach Namen, bei jeder Aktualisierung das nächste. In einer URL werden {now} und {unix} durch die aktuelle Zeit ersetzt (Millisekunden, Sekunden).',
        'zh-Hant': '資料夾會依檔名顯示圖片，每次重新整理換下一張。在 URL 中，{now} 和 {unix} 會換成目前時間（毫秒、秒）。',
        'zh-Hans': '文件夹会按文件名显示图片，每次刷新换下一张。在 URL 中，{now} 和 {unix} 会替换为当前时间（毫秒、秒）。',
      },
    }),
    addTimestamp: t.boolean({
      label: { en: 'Add a timestamp to the URL', es: 'Añadir marca de tiempo a la URL', de: 'Zeitstempel an die URL anhängen', 'zh-Hant': '在 URL 加上時間戳記', 'zh-Hans': '在 URL 中添加时间戳' },
      help: {
        en: 'Appends t=<now> on every refresh, for webcams that would otherwise be served from a cache.',
        es: 'Añade t=<ahora> en cada refresco, para webcams que si no se sirven desde una caché.',
        de: 'Hängt bei jeder Aktualisierung t=<jetzt> an, für Webcams, die sonst aus einem Cache kämen.',
        'zh-Hant': '每次重新整理時附加 t=<now>，以免網路攝影機的畫面來自快取。',
        'zh-Hans': '每次刷新时附加 t=<now>，避免网络摄像头的画面来自缓存。',
      },
    }),
    fit: t.enum(['cover', 'contain'] as const, { label: { en: 'Fit', es: 'Ajuste', de: 'Einpassen', 'zh-Hant': '縮放方式', 'zh-Hans': '缩放方式' }, labels: { cover: { en: 'Fill (crop)', es: 'Llenar (recorta)', de: 'Füllen (zuschneiden)', 'zh-Hant': '填滿（裁切）', 'zh-Hans': '填满（裁剪）' }, contain: { en: 'Whole image', es: 'Imagen entera', de: 'Ganzes Bild', 'zh-Hant': '完整圖片', 'zh-Hans': '完整图片' } } }),
    position: t.enum(['center', 'top', 'bottom', 'left', 'right'] as const, {
      label: { en: 'Keep in view', es: 'Mantener a la vista', de: 'Im Blick behalten', 'zh-Hant': '保留可見', 'zh-Hans': '保持可见' },
      labels: { center: { en: 'The centre', es: 'El centro', de: 'Die Mitte', 'zh-Hant': '中央', 'zh-Hans': '中间' }, top: { en: 'The top', es: 'La parte de arriba', de: 'Oben', 'zh-Hant': '上方', 'zh-Hans': '顶部' }, bottom: { en: 'The bottom', es: 'La parte de abajo', de: 'Unten', 'zh-Hant': '下方', 'zh-Hans': '底部' }, left: { en: 'The left', es: 'La izquierda', de: 'Links', 'zh-Hant': '左側', 'zh-Hans': '左侧' }, right: { en: 'The right', es: 'La derecha', de: 'Rechts', 'zh-Hant': '右側', 'zh-Hans': '右侧' } },
      help: { en: 'What filling crops last: the sky of a webcam, the axis of a chart.', es: 'Lo último que recorta al llenar: el cielo de una webcam, el eje de una gráfica.', de: 'Was beim Füllen zuletzt abgeschnitten wird: der Himmel einer Webcam, die Achse eines Diagramms.', 'zh-Hant': '填滿時最後才裁切的部分：例如網路攝影機的天空、圖表的座標軸。', 'zh-Hans': '填满时最后才裁剪的部分：例如网络摄像头的天空、图表的坐标轴。' },
    }),
    dim: t.integer({ default: 0, min: 0, max: 90, step: 5, unit: '%', slider: true, label: { en: 'Darken', es: 'Oscurecer', de: 'Abdunkeln', 'zh-Hant': '調暗', 'zh-Hans': '调暗' }, help: { en: 'Keeps a photo from outshining everything else.', es: 'Para que una foto no deslumbre al resto.', de: 'Damit ein Foto nicht alles andere überstrahlt.', 'zh-Hant': '避免照片搶走其他內容的風采。', 'zh-Hans': '避免照片抢了其他内容的风头。' } }),
  }),
  intervalMs: 5 * 60_000,
  async fetch({ options, canvas, signal }): Promise<ImageData> {
    if (!options.src) return { img: null };
    if (/^https?:/.test(options.src)) {
      const res = await fetch(imageUrl(options.src, Date.now(), options.addTimestamp), { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { img: await load(canvas, Buffer.from(await res.arrayBuffer())) };
    }
    const path = (await stat(options.src)).isDirectory() ? await nextInFolder(options.src) : options.src;
    if (!path) throw new Error(`no pictures in ${options.src}`);
    return { img: await load(canvas, path) };
  },
  render(g, { box, data, options, theme, kit, t: tr }) {
    const img = data?.img;
    if (!img) {
      g.fillStyle = theme.colors.surface;
      g.fillRect(box.x, box.y, box.w, box.h);
      kit.drawTracked(g, options.src ? '…' : tr({ en: 'No image', es: 'Sin imagen', de: 'Kein Bild', 'zh-Hant': '沒有圖片', 'zh-Hans': '没有图片' }), box.x + box.w / 2, box.y + box.h / 2, { size: Math.min(28, box.h / 4), family: theme.fonts.sans, color: theme.colors.inkFaint, align: 'center' });
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
  name: { en: 'Essentials', es: 'Básicos', de: 'Grundlagen', 'zh-Hant': '基本工具', 'zh-Hans': '基础组件' },
  version: '0.2.13',
  languages: ['en', 'es', 'de', 'zh-Hant', 'zh-Hans'],
  sdk: '^0.2.0',
  // The picture widget reads the image (or folder, or URL) you give it; the JSON ones ask the URL you give them.
  permissions: { files: ['user'], network: ['user'] },
  description: { en: 'Clock, date, notes, lists, pictures, any JSON and pushes from your scripts.', es: 'Reloj, fecha, notas, listas, imágenes, cualquier JSON y los push de tus scripts.', de: 'Uhr, Datum, Notizen, Listen, Bilder, beliebiges JSON und Pushes deiner Skripte.', 'zh-Hant': '時鐘、日期、便條、清單、圖片、任何 JSON，以及腳本傳來的推送。', 'zh-Hans': '时钟、日期、便签、列表、图片、任何 JSON，以及脚本发来的推送。' },
  author: 'Kiosko',
  license: 'MIT',
  icon: 'box',
  widgets: [clock, date, text, list, image, jsonValue, jsonList, jsonText, push],
  sources: [pushSource],
});

export { jsonList, jsonText, jsonValue, push, pushSource };
export { pushes, PushStore, PUSH_LIMITS, PUSH_NAME, type PushData, type PushEntry } from './push-store.ts';
