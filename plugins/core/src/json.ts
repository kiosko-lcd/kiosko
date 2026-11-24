/**
 * Any JSON as a widget, without writing a plugin: a URL Kiosko asks every
 * so often (an API, a script's status page, a sensor on the network), or a
 * push name a script posts to (`POST /api/push/<name>`, see push.ts). A path
 * picks the value (json-path.ts) and the widget writes it: a big number with
 * its unit, colour thresholds and a curve of its history (`core/json`),
 * several fields or the items of a list (`core/json-list`), or a sentence
 * with values in it (`core/json-text`).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHttp, defineWidget, drawEmpty, drawMore, listLayout, listOptions, t, type Graphics, type Localized, type RenderContext } from '@kiosko/sdk';
import { formatValue, TONES, toNumber, toneFor, valueText, type Threshold, type Tone } from './json-format.ts';
import { leafPaths, parsePath, readPath } from './json-path.ts';
import { live, type PushData } from './push-store.ts';

const L = (en: string, es: string, de: string, hant: string, hans: string): Localized => ({ en, es, de, 'zh-Hant': hant, 'zh-Hans': hans });

/** The source every widget here reads pushes from. */
export const PUSH_SOURCE = 'core/push';

const TONE_LABELS: Record<Tone, Localized> = {
  ok: L('Green (fine)', 'Verde (bien)', 'Grün (gut)', '綠色（正常）', '绿色（正常）'),
  info: L('Blue (note)', 'Azul (aviso)', 'Blau (Hinweis)', '藍色（提示）', '蓝色（提示）'),
  warn: L('Amber (watch)', 'Ámbar (ojo)', 'Bernstein (aufpassen)', '琥珀色（注意）', '琥珀色（注意）'),
  alert: L('Red (needs you)', 'Rojo (te necesita)', 'Rot (braucht dich)', '紅色（需要處理）', '红色（需要处理）'),
  accent: L('Accent', 'Acento', 'Akzent', '強調色', '强调色'),
  dim: L('Dim', 'Tenue', 'Gedämpft', '淡色', '暗淡'),
};

/** The colour of a tone in the theme. */
export const toneColor = (theme: RenderContext<unknown, unknown>['theme'], tone: Tone | undefined): string =>
  tone === undefined ? theme.colors.ink : tone === 'dim' ? theme.colors.inkDim : theme.colors[tone];

/** Where the data comes from: a URL, or a push name. Shared by every widget here. */
export function sourceOptions() {
  return {
    url: t.string({
      format: 'url',
      risk: 'network',
      placeholder: 'https://api.example.com/status.json',
      label: L('URL', 'URL', 'URL', 'URL', 'URL'),
      help: L(
        'Asked every refresh (the widget\'s interval). It should answer JSON; plain text is read as one value. {secret} in it becomes the secret below.',
        'Se consulta en cada refresco (el intervalo del widget). Debería responder JSON; el texto plano se lee como un solo valor. {secret} se cambia por el secreto de abajo.',
        'Wird bei jeder Aktualisierung abgefragt (Intervall des Widgets). Sie sollte JSON liefern; reiner Text gilt als ein Wert. {secret} wird durch das Geheimnis unten ersetzt.',
        '每次重新整理時查詢（小工具的間隔）。應回傳 JSON；純文字會當成單一數值。其中的 {secret} 會換成下方的密鑰。',
        '每次刷新时请求（小组件的间隔）。应返回 JSON；纯文本会当作单个值。其中的 {secret} 会替换为下方的密钥。',
      ),
    }),
    push: t.string({
      choices: { source: PUSH_SOURCE, list: 'names' },
      placeholder: 'garage',
      label: L('Or a push name', 'O un nombre de push', 'Oder ein Push-Name', '或推送名稱', '或推送名称'),
      help: L(
        'Instead of a URL: what a script sends to POST /api/push/<name>. Set up push names in Settings → Push.',
        'En vez de una URL: lo que un script envía a POST /api/push/<nombre>. Los nombres se crean en Ajustes → Push.',
        'Statt einer URL: was ein Skript an POST /api/push/<name> sendet. Push-Namen legst du unter Einstellungen → Push an.',
        '取代 URL：腳本傳送到 POST /api/push/<名稱> 的內容。推送名稱在「設定 → 推送」中建立。',
        '代替 URL：脚本发送到 POST /api/push/<名称> 的内容。推送名称在“设置 → 推送”中创建。',
      ),
    }),
    secret: t.string({
      secret: true,
      label: L('Secret (token, API key)', 'Secreto (token, clave de API)', 'Geheimnis (Token, API-Schlüssel)', '密鑰（權杖、API 金鑰）', '密钥（令牌、API 密钥）'),
      help: L(
        'Sent in the header below (e.g. "Bearer abc123"), or wherever {secret} appears in the URL, headers or body.',
        'Se envía en la cabecera de abajo (p. ej. «Bearer abc123»), o donde aparezca {secret} en la URL, las cabeceras o el cuerpo.',
        'Wird im Header unten gesendet (z. B. „Bearer abc123“) oder dort, wo {secret} in URL, Headern oder Body steht.',
        '放在下方的標頭中送出（例如「Bearer abc123」），或放在 URL、標頭、內文中 {secret} 出現的位置。',
        '放在下方的请求头中发送（例如“Bearer abc123”），或放在 URL、请求头、请求体中 {secret} 出现的位置。',
      ),
    }),
    authHeader: t.string({
      default: 'Authorization',
      advanced: true,
      label: L('Header for the secret', 'Cabecera del secreto', 'Header für das Geheimnis', '密鑰使用的標頭', '密钥使用的请求头'),
      help: L('Authorization, X-Api-Key… Empty: only where {secret} is written.', 'Authorization, X-Api-Key… Vacía: solo donde esté {secret}.', 'Authorization, X-Api-Key… Leer: nur dort, wo {secret} steht.', 'Authorization、X-Api-Key… 留空：只放在 {secret} 的位置。', 'Authorization、X-Api-Key… 留空：只放在 {secret} 的位置。'),
    }),
    headers: t.map({ advanced: true, label: L('Other headers', 'Otras cabeceras', 'Weitere Header', '其他標頭', '其他请求头'), keyLabel: L('Header', 'Cabecera', 'Header', '標頭', '请求头'), valueLabel: L('Value', 'Valor', 'Wert', '值', '值') }),
    method: t.enum(['GET', 'POST'] as const, { advanced: true, label: L('Method', 'Método', 'Methode', '方法', '方法') }),
    body: t.string({ multiline: true, advanced: true, placeholder: '{"query": "…"}', label: L('Body (POST)', 'Cuerpo (POST)', 'Body (POST)', '內文（POST）', '请求体（POST）'), help: L('Sent as JSON when it looks like JSON, else as text.', 'Se envía como JSON si lo parece; si no, como texto.', 'Wird als JSON gesendet, wenn es danach aussieht, sonst als Text.', '看起來像 JSON 時以 JSON 送出，否則以純文字送出。', '看起来像 JSON 时按 JSON 发送，否则按纯文本发送。') }),
    timeoutMs: t.duration({ default: 10_000, min: 1_000, max: 60_000, advanced: true, label: L('Give up after', 'Abandonar tras', 'Aufgeben nach', '逾時時間', '超时时间') }),
    maxKb: t.integer({ default: 512, min: 1, max: 5_120, unit: 'KB', advanced: true, label: L('Largest answer', 'Respuesta más grande', 'Größte Antwort', '回應大小上限', '响应大小上限'), help: L('A longer answer is refused, so a wrong URL can\'t fill the memory.', 'Una más larga se rechaza, para que una URL equivocada no llene la memoria.', 'Eine längere wird abgelehnt, damit eine falsche URL nicht den Speicher füllt.', '超過的回應會被拒絕，以免錯誤的 URL 塞滿記憶體。', '超出的响应会被拒绝，以免错误的 URL 占满内存。') }),
  };
}

const pathField = (o: { label?: Localized; help?: Localized; placeholder?: string } = {}) =>
  t.string({
    placeholder: o.placeholder ?? '$.current.temperature_2m',
    label: o.label ?? L('Path to the value', 'Ruta del valor', 'Pfad zum Wert', '數值路徑', '数值路径'),
    help:
      o.help ??
      L(
        '$.a.b, items[0].price, items[-1], [\'key with spaces\']. Empty: the widget lists the paths it finds.',
        '$.a.b, items[0].price, items[-1], [\'clave con espacios\']. Vacía: el widget enseña las rutas que encuentra.',
        '$.a.b, items[0].price, items[-1], [\'Schlüssel mit Leerzeichen\']. Leer: Das Widget zeigt die gefundenen Pfade.',
        '$.a.b、items[0].price、items[-1]、[\'含空格的鍵\']。留空：小工具會列出找到的路徑。',
        '$.a.b、items[0].price、items[-1]、[\'含空格的键\']。留空：小组件会列出找到的路径。',
      ),
  });

const formatOptions = () => ({
  prefix: t.string({ placeholder: '$', label: L('Before the value', 'Antes del valor', 'Vor dem Wert', '數值前綴', '数值前缀') }),
  unit: t.string({ placeholder: '°C', label: L('Unit', 'Unidad', 'Einheit', '單位', '单位') }),
  decimals: t.integer({ default: -1, min: -1, max: 6, label: L('Decimals', 'Decimales', 'Nachkommastellen', '小數位數', '小数位数'), help: L('-1: as it comes (up to 2).', '-1: tal como viene (hasta 2).', '-1: wie geliefert (bis zu 2).', '-1：依原始值（最多 2 位）。', '-1：按原始值（最多 2 位）。') }),
  thresholds: t.list(
    t.object({
      when: t.string({ placeholder: '>= 30', label: L('When', 'Cuando', 'Wenn', '條件', '条件') }),
      tone: t.enum(TONES, { default: 'warn', label: L('Colour', 'Color', 'Farbe', '顏色', '颜色'), labels: TONE_LABELS }),
    }),
    {
      max: 8,
      label: L('Colours by value', 'Colores según el valor', 'Farben nach Wert', '依數值變色', '按数值变色'),
      help: L(
        'The first that holds wins: >= 30, > 30, < 0, <= 5, = failed, != ok, or a bare number (meaning >=).',
        'Gana la primera que se cumple: >= 30, > 30, < 0, <= 5, = failed, != ok, o un número solo (es >=).',
        'Die erste zutreffende gilt: >= 30, > 30, < 0, <= 5, = failed, != ok oder eine bloße Zahl (bedeutet >=).',
        '第一個成立的條件生效：>= 30、> 30、< 0、<= 5、= failed、!= ok，或單獨一個數字（表示 >=）。',
        '第一个成立的条件生效：>= 30、> 30、< 0、<= 5、= failed、!= ok，或单独一个数字（表示 >=）。',
      ),
    },
  ),
});

type SourceOpts = { url: string; push: string; secret: string; authHeader: string; headers: Record<string, string>; method: 'GET' | 'POST'; body: string; timeoutMs: number; maxKb: number };
type FormatOpts = { prefix: string; unit: string; decimals: number; thresholds: Threshold[] };

const http = createHttp({ agent: 'kiosko-core' });

/** Answers shared for a moment, so two widgets on the same URL ask it once. */
const recent = new Map<string, { at: number; doc: Promise<unknown> }>();
const SHARE_MS = 2_000;

const fill = (s: string, secret: string) => s.replace(/\{secret\}/g, secret);

/** The request a widget's options describe: URL, method, headers and body, with the secret in its place. */
export function requestOf(o: SourceOpts): { url: string; method: 'GET' | 'POST'; headers: Record<string, string>; body?: string } {
  const placed = [o.url, o.body, ...Object.keys(o.headers), ...Object.values(o.headers)].some((s) => s.includes('{secret}'));
  const url = o.url.includes('{secret}') ? o.url.replace(/\{secret\}/g, encodeURIComponent(o.secret)) : o.url.trim();
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.headers)) if (k.trim()) headers[k.trim()] = fill(String(v), o.secret);
  if (o.secret && !placed && o.authHeader.trim()) headers[o.authHeader.trim()] = o.secret;
  const body = o.method === 'POST' && o.body.trim() ? fill(o.body, o.secret) : undefined;
  if (body !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = /^\s*[[{]/.test(body) ? 'application/json' : 'text/plain; charset=utf-8';
  return { url, method: o.method, headers, ...(body !== undefined ? { body } : {}) };
}

/** Parses an answer: JSON when it is, else the text itself (a plain-text status page). */
export function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.trim();
  }
}

/** Asks the URL of `o` (or reuses an answer of the last 2 s to the same request). */
export async function requestJson(o: SourceOpts, signal: AbortSignal): Promise<unknown> {
  const req = requestOf(o);
  if (!/^https?:\/\//i.test(req.url)) throw new Error('the URL must start with http:// or https://');
  const key = JSON.stringify([req, o.maxKb]);
  const now = Date.now();
  for (const [k, r] of recent) if (now - r.at > SHARE_MS) recent.delete(k);
  const hit = recent.get(key);
  if (hit) return hit.doc;
  const timeout = AbortSignal.timeout(o.timeoutMs);
  const doc = http
    .text(req.url, { signal: AbortSignal.any([signal, timeout]), method: req.method, headers: { Accept: 'application/json, text/plain;q=0.8, */*;q=0.5', ...req.headers }, ...(req.body !== undefined ? { body: req.body } : {}), maxBytes: o.maxKb * 1024 })
    .then((r) => parseBody(r.data));
  recent.set(key, { at: now, doc });
  doc.catch(() => recent.delete(key));
  return doc;
}

/** The pushed document of a push name, if there is one and it is still live. */
export function pushedDoc(sources: Record<string, unknown>, name: string, now: number): { found: boolean; doc: unknown; at?: number } {
  const e = (sources[PUSH_SOURCE] as PushData | undefined)?.hooks?.[name.trim()];
  return live(e, now) ? { found: true, doc: e.payload, at: e.at } : { found: false, doc: undefined };
}

/** "path = value" lines for the first leaves of a document: what to type as a path. */
export function hintsOf(doc: unknown, max = 6): string[] {
  return leafPaths(doc, max).map((l) => `${l.path} = ${valueText(l.value, { decimals: -1, locale: 'en' }).slice(0, 40)}`);
}

/** A value found by a path, or why not. */
export interface Picked {
  found: boolean;
  value?: unknown;
  /** Why it isn't there (bad path), for the tile. */
  error?: string;
  /** What the document has, when the path finds nothing. */
  hints?: string[];
}

export function pick(doc: unknown, path: string): Picked {
  if (!path.trim()) return { found: false, hints: hintsOf(doc) };
  try {
    const r = readPath(doc, path);
    return r.found ? { found: true, value: r.value } : { found: false, hints: hintsOf(doc) };
  } catch (err) {
    return { found: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/* History of a value, for the curve. */

/** Most points a curve keeps. */
const MAX_POINTS = 500;
/** Points closer than this are one (two widgets on the same URL both add theirs). */
const SAME_POINT_MS = 2_000;
const histories = new Map<string, [number, number][]>();

/** A short, stable name for a history file (FNV-1a). */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36);
}

/** Adds a point to a history, without two at the same moment, keeping the last `max`. */
export function addPoint(series: [number, number][], at: number, v: number, max: number): [number, number][] {
  const last = series.at(-1);
  const out = last && Math.abs(at - last[0]) < SAME_POINT_MS ? [...series.slice(0, -1), [at, v] as [number, number]] : [...series, [at, v] as [number, number]];
  return out.slice(-Math.max(2, Math.min(MAX_POINTS, max)));
}

/** The history of `key` with `v` added, kept in `dir` (the cache folder) so a restart doesn't blank the curve. */
async function remember(dir: string, key: string, at: number, v: number | undefined, max: number): Promise<[number, number][]> {
  const file = join(dir, 'json-history', `${hash(key)}.json`);
  let series = histories.get(key);
  if (!series) {
    try {
      const saved = JSON.parse(await readFile(file, 'utf8')) as unknown;
      series = Array.isArray(saved) ? saved.filter((p): p is [number, number] => Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number') : [];
    } catch {
      series = [];
    }
  }
  if (v !== undefined) {
    series = addPoint(series, at, v, max);
    await mkdir(join(dir, 'json-history'), { recursive: true });
    await writeFile(file, JSON.stringify(series));
  }
  histories.set(key, series);
  return series;
}

/** The curve of a pushed value: the path read in each payload kept. */
export function pushedSeries(sources: Record<string, unknown>, name: string, path: string, max: number): [number, number][] {
  const e = (sources[PUSH_SOURCE] as PushData | undefined)?.hooks?.[name.trim()];
  if (!e || !path.trim()) return [];
  let steps;
  try {
    steps = parsePath(path);
  } catch {
    return [];
  }
  const out: [number, number][] = [];
  for (const r of e.history) {
    const n = toNumber(readPath(r.payload, steps).value);
    if (n !== undefined) out.push([r.at, n]);
  }
  return out.slice(-max);
}

/* Painting. */

function fit(g: Graphics, text: string, family: string, w: number, h: number, max = 400): number {
  let size = Math.min(max, h);
  g.font = `${size}px "${family}"`;
  const width = g.measureText(text).width;
  if (width > w) size = Math.floor((size * w) / width);
  return Math.max(8, size);
}

type Ctx = RenderContext<any, any>;

/** What to paint when there is nothing yet: why, and the paths the document has. */
function drawNothing(g: Graphics, ctx: Ctx, p: { message: string; hints?: string[] | undefined }): void {
  const { box, kit, theme } = ctx;
  const size = Math.max(10, Math.min(26, Math.round(box.h / 7)));
  const font = { size, family: theme.fonts.sans, color: theme.colors.inkDim };
  kit.drawTracked(g, kit.truncate(g, p.message, box.w, font), box.x, box.y + size * 1.1, font);
  const hs = Math.max(9, Math.round(size * 0.8));
  const mono = { size: hs, family: theme.fonts.mono, color: theme.colors.inkFaint };
  (p.hints ?? []).forEach((h, i) => {
    const y = box.y + size * 1.1 + (i + 1) * hs * 1.35;
    if (y < box.y + box.h) kit.drawTracked(g, kit.truncate(g, h, box.w, mono), box.x, y, mono);
  });
}

const WAITING = L('Waiting for data…', 'Esperando datos…', 'Warte auf Daten…', '等待資料中…', '等待数据中…');
const NO_SOURCE = L('Set a URL or a push name', 'Pon una URL o un nombre de push', 'URL oder Push-Namen angeben', '請設定 URL 或推送名稱', '请设置 URL 或推送名称');
const NOT_FOUND = L('Nothing at that path. It has:', 'No hay nada en esa ruta. Tiene:', 'Unter diesem Pfad ist nichts. Vorhanden:', '該路徑沒有資料。可用的有：', '该路径没有数据。可用的有：');
const CHOOSE = L('Choose a path. It has:', 'Elige una ruta. Tiene:', 'Wähle einen Pfad. Vorhanden:', '請選擇路徑。可用的有：', '请选择路径。可用的有：');
const BAD_PATH = L('Wrong path: ', 'Ruta incorrecta: ', 'Falscher Pfad: ', '路徑錯誤：', '路径错误：');
const NO_PUSH = L('Nothing pushed to "{name}" yet', 'Aún no se ha enviado nada a «{name}»', 'Noch nichts an „{name}“ gesendet', '尚未有內容推送到「{name}」', '尚未有内容推送到“{name}”');

/** A line chart of `series` in `b`, scaled to its own range, with a soft fill. */
export function drawCurve(g: Graphics, ctx: Ctx, series: [number, number][], b: { x: number; y: number; w: number; h: number }, color: string): void {
  if (series.length < 2 || b.w < 4 || b.h < 4) return;
  const vs = series.map((p) => p[1]);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  if (hi === lo) {
    lo -= 1;
    hi += 1;
  }
  const t0 = series[0]![0], t1 = series.at(-1)![0];
  const span = t1 - t0 || 1;
  const lw = Math.max(2, Math.round(b.h / 24));
  const xy = (p: [number, number]): [number, number] => [b.x + ((p[0] - t0) / span) * b.w, b.y + lw / 2 + (1 - (p[1] - lo) / (hi - lo)) * (b.h - lw)];
  const pts = series.map(xy);
  g.save();
  g.beginPath();
  g.moveTo(pts[0]![0], b.y + b.h);
  for (const [x, y] of pts) g.lineTo(x, y);
  g.lineTo(pts.at(-1)![0], b.y + b.h);
  g.closePath();
  g.fillStyle = /^#[0-9a-f]{6}$/i.test(color) ? ctx.kit.css(ctx.kit.hex(color), 0.18) : color;
  g.fill();
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.strokeStyle = color;
  g.lineWidth = lw;
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.stroke();
  const [lx, ly] = pts.at(-1)!;
  g.fillStyle = color;
  g.beginPath();
  g.arc(lx, ly, lw * 1.4, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

/* core/json: one value, big. */

interface ValueData {
  at: number;
  picked: Picked;
  series: [number, number][];
}

export const jsonValue = defineWidget({
  id: 'json',
  name: L('JSON value', 'Valor JSON', 'JSON-Wert', 'JSON 數值', 'JSON 数值'),
  description: L(
    'One number or word from any URL that answers JSON, or from a push: big, with its unit, colours by value and a curve of its history.',
    'Un número o una palabra de cualquier URL que responda JSON, o de un push: grande, con su unidad, colores según el valor y una curva con su histórico.',
    'Eine Zahl oder ein Wort von einer beliebigen URL, die JSON liefert, oder aus einem Push: groß, mit Einheit, Farben nach Wert und einer Kurve des Verlaufs.',
    '來自任何回傳 JSON 的 URL 或推送的一個數字或文字：大字顯示，附單位、依數值變色，以及歷史曲線。',
    '来自任何返回 JSON 的 URL 或推送的一个数字或文字：大字显示，附单位、按数值变色，以及历史曲线。',
  ),
  icon: 'braces',
  category: 'dev',
  tags: ['rest', 'api', 'json', 'webhook', 'push'],
  size: { min: { w: 120, h: 80 }, preferred: { w: 320, h: 220 } },
  sources: [PUSH_SOURCE],
  options: t.object({
    ...sourceOptions(),
    select: pathField(),
    label: t.string({ placeholder: 'Temperature', label: L('Label', 'Etiqueta', 'Beschriftung', '標籤', '标签'), help: L('A few words above the value. The tile\'s title works too.', 'Unas palabras encima del valor. También vale el título de la tesela.', 'Ein paar Worte über dem Wert. Der Titel der Kachel geht auch.', '數值上方的幾個字。也可以用方格的標題。', '数值上方的几个字。也可以用格子的标题。') }),
    ...formatOptions(),
    chart: t.enum(['below', 'none'] as const, { label: L('History curve', 'Curva del histórico', 'Verlaufskurve', '歷史曲線', '历史曲线'), labels: { below: L('Under the value', 'Debajo del valor', 'Unter dem Wert', '在數值下方', '在数值下方'), none: L('None', 'Ninguna', 'Keine', '不顯示', '不显示') } }),
    points: t.integer({ default: 60, min: 5, max: MAX_POINTS, advanced: true, label: L('Points in the curve', 'Puntos de la curva', 'Punkte der Kurve', '曲線點數', '曲线点数'), help: L('One per refresh (or per push).', 'Uno por refresco (o por push).', 'Einer pro Aktualisierung (oder pro Push).', '每次重新整理（或每次推送）一點。', '每次刷新（或每次推送）一个点。') }),
  }),
  intervalMs: 60_000,
  timeoutMs: 65_000,
  async fetch({ options, signal, cacheDir }): Promise<ValueData | null> {
    if (options.push.trim() || !options.url.trim()) return null;
    const doc = await requestJson(options, signal);
    const picked = pick(doc, options.select);
    const at = Date.now();
    const n = picked.found ? toNumber(picked.value) : undefined;
    const series = options.chart === 'none' ? [] : await remember(cacheDir, JSON.stringify([requestOf(options).url, options.method, options.body, options.select]), at, n, options.points).catch(() => []);
    return { at, picked, series };
  },
  redraw: 'minute',
  render(g, ctx) {
    const { box, options, theme, kit, now, sources } = ctx;
    let picked: Picked | undefined;
    let series: [number, number][] = [];
    if (options.push.trim()) {
      const p = pushedDoc(sources, options.push, now);
      if (!p.found) return drawNothing(g, ctx, { message: ctx.t(NO_PUSH).replace('{name}', options.push.trim()) });
      picked = pick(p.doc, options.select);
      if (options.chart !== 'none') series = pushedSeries(sources, options.push, options.select, options.points);
    } else if (!options.url.trim()) return drawNothing(g, ctx, { message: ctx.t(NO_SOURCE) });
    else if (ctx.data) {
      picked = (ctx.data as ValueData).picked;
      series = (ctx.data as ValueData).series ?? [];
    }
    if (!picked) return drawNothing(g, ctx, { message: ctx.t(WAITING) });
    if (picked.error) return drawNothing(g, ctx, { message: ctx.t(BAD_PATH) + picked.error });
    if (!picked.found) return drawNothing(g, ctx, { message: ctx.t(options.select.trim() ? NOT_FOUND : CHOOSE), hints: picked.hints });
    const tone = toneFor(picked.value, options.thresholds);
    const color = toneColor(theme, tone);
    const labelH = options.label.trim() ? Math.max(10, Math.min(30, Math.round(box.h * 0.14))) : 0;
    const curve = options.chart !== 'none' && series.length >= 2;
    const curveH = curve ? Math.round(box.h * 0.32) : 0;
    if (labelH) kit.drawTracked(g, kit.truncate(g, options.label.trim(), box.w, { size: labelH, family: theme.fonts.sansBold }), box.x, box.y + labelH * 0.9, { size: labelH, family: theme.fonts.sansBold, color: theme.colors.inkDim, smallCaps: true, tracking: 1 });
    const text = options.prefix + valueText(picked.value, { decimals: options.decimals, locale: ctx.locale });
    const unit = options.unit.trim();
    const top = box.y + (labelH ? labelH * 1.4 : 0);
    const room = box.h - (top - box.y) - (curveH ? curveH + 6 : 0);
    const numeric = toNumber(picked.value) !== undefined;
    const family = numeric ? theme.fonts.monoBold : theme.fonts.sansBold;
    let size = fit(g, text, family, box.w * (unit ? 0.78 : 0.98), room * 0.92);
    let unitSize = Math.max(8, Math.round(size * 0.42));
    g.font = `${unitSize}px "${theme.fonts.sans}"`;
    const unitW = unit ? g.measureText(unit).width + size * 0.1 : 0;
    g.font = `${size}px "${family}"`;
    let textW = g.measureText(text).width;
    if (textW + unitW > box.w) {
      const k = box.w / (textW + unitW);
      size = Math.max(8, Math.floor(size * k));
      unitSize = Math.max(8, Math.round(size * 0.42));
      g.font = `${size}px "${family}"`;
      textW = g.measureText(text).width;
    }
    const base = top + (room + size * 0.72) / 2;
    g.fillStyle = color;
    g.textAlign = 'left';
    g.fillText(text, box.x, base);
    if (unit) {
      g.font = `${unitSize}px "${theme.fonts.sans}"`;
      g.fillStyle = theme.colors.inkDim;
      g.fillText(unit, box.x + textW + size * 0.1, base);
    }
    if (curve) drawCurve(g, ctx, series, { x: box.x, y: box.y + box.h - curveH, w: box.w, h: curveH }, tone ? color : theme.colors.accent);
  },
  demo: ({ now }) => ({
    options: { url: 'https://api.open-meteo.com/v1/forecast?latitude=40.4&longitude=-3.7&current=temperature_2m', select: '$.current.temperature_2m', label: 'Madrid', unit: '°C', decimals: 1, thresholds: [{ when: '>= 30', tone: 'alert' as const }, { when: '>= 25', tone: 'warn' as const }] },
    data: { at: now, picked: { found: true, value: 21.4 }, series: Array.from({ length: 24 }, (_, i) => [now - (23 - i) * 3600_000, 14 + 7 * Math.sin((i - 6) / 4) + (i % 3) * 0.3] as [number, number]) },
  }),
});

/* core/json-list: several values. */

interface Row {
  label: string;
  value: unknown;
  unit?: string;
  decimals?: number;
}

interface ListData {
  at: number;
  rows: Row[] | null;
  error?: string;
  hints?: string[];
}

type ListOpts = { items: string; itemLabel: string; itemValue: string; fields: { label: string; select: string; unit: string }[] };

/** The rows of `core/json-list`: the fields listed, or the items of a list with a label and a value each. */
export function rowsOf(doc: unknown, o: ListOpts): Omit<ListData, 'at'> {
  try {
    if (o.items.trim()) {
      const r = readPath(doc, o.items);
      const items = !r.found ? [] : Array.isArray(r.value) ? r.value : r.value && typeof r.value === 'object' ? Object.entries(r.value).map(([k, v]) => ({ key: k, value: v })) : [];
      if (!r.found) return { rows: null, hints: hintsOf(doc) };
      const labelSteps = o.itemLabel.trim() ? parsePath(o.itemLabel) : null;
      const valueSteps = o.itemValue.trim() ? parsePath(o.itemValue) : null;
      return {
        rows: items.slice(0, 200).map((it) => ({
          label: labelSteps ? valueText(readPath(it, labelSteps).value, { decimals: -1, locale: 'en' }) : valueText(it, { decimals: -1, locale: 'en' }),
          value: valueSteps ? readPath(it, valueSteps).value : undefined,
        })),
      };
    }
    const fields = o.fields.filter((f) => f.select.trim());
    if (!fields.length) return { rows: null, hints: hintsOf(doc, 8) };
    return { rows: fields.map((f) => ({ label: f.label || f.select, value: readPath(doc, f.select).value, ...(f.unit ? { unit: f.unit } : {}) })) };
  } catch (err) {
    return { rows: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export const jsonList = defineWidget({
  id: 'json-list',
  name: L('JSON list', 'Lista JSON', 'JSON-Liste', 'JSON 清單', 'JSON 列表'),
  description: L(
    'Several values from a URL that answers JSON, or from a push: the fields you choose, or the items of a list, each with its value.',
    'Varios valores de una URL que responda JSON, o de un push: los campos que elijas, o los elementos de una lista, cada uno con su valor.',
    'Mehrere Werte von einer URL, die JSON liefert, oder aus einem Push: die Felder, die du wählst, oder die Einträge einer Liste, jeder mit seinem Wert.',
    '來自回傳 JSON 的 URL 或推送的多個數值：你選的欄位，或清單中的每個項目及其數值。',
    '来自返回 JSON 的 URL 或推送的多个数值：你选的字段，或列表中的每个条目及其数值。',
  ),
  icon: 'list',
  category: 'dev',
  tags: ['rest', 'api', 'json', 'webhook', 'push'],
  size: { min: { w: 160, h: 80 }, preferred: { w: 360, h: 240 } },
  sources: [PUSH_SOURCE],
  options: t.object({
    ...sourceOptions(),
    fields: t.list(
      t.object({
        label: t.string({ label: L('Label', 'Etiqueta', 'Beschriftung', '標籤', '标签') }),
        select: pathField({ placeholder: '$.current.wind_speed_10m', help: L('$.a.b, items[0].price…', '$.a.b, items[0].price…', '$.a.b, items[0].price…', '$.a.b、items[0].price…', '$.a.b、items[0].price…') }),
        unit: t.string({ placeholder: 'km/h', label: L('Unit', 'Unidad', 'Einheit', '單位', '单位') }),
      }),
      { max: 30, label: L('Fields', 'Campos', 'Felder', '欄位', '字段'), help: L('One row each. Or leave them empty and give a list below.', 'Una fila cada uno. O déjalos vacíos y da una lista abajo.', 'Je eine Zeile. Oder leer lassen und unten eine Liste angeben.', '每個欄位一列。或留空，改在下方指定清單。', '每个字段一行。或留空，改在下方指定列表。') },
    ),
    items: pathField({ placeholder: '$.items', label: L('Or a list in it', 'O una lista suya', 'Oder eine Liste darin', '或其中的清單', '或其中的列表'), help: L('A row per item of the list (or per key of an object) at this path.', 'Una fila por elemento de la lista (o por clave de un objeto) en esta ruta.', 'Eine Zeile pro Eintrag der Liste (oder pro Schlüssel eines Objekts) unter diesem Pfad.', '此路徑下清單的每個項目（或物件的每個鍵）各一列。', '此路径下列表的每个条目（或对象的每个键）各一行。') }),
    itemLabel: t.string({ placeholder: 'name', label: L('Label of each item', 'Etiqueta de cada elemento', 'Beschriftung jedes Eintrags', '每個項目的標籤', '每个条目的标签'), help: L('A path inside the item (name, user.login; key for an object\'s keys).', 'Una ruta dentro del elemento (name, user.login; key para las claves de un objeto).', 'Ein Pfad im Eintrag (name, user.login; key für die Schlüssel eines Objekts).', '項目內的路徑（name、user.login；物件的鍵用 key）。', '条目内的路径（name、user.login；对象的键用 key）。') }),
    itemValue: t.string({ placeholder: 'price', label: L('Value of each item', 'Valor de cada elemento', 'Wert jedes Eintrags', '每個項目的數值', '每个条目的数值'), help: L('A path inside the item; empty: only the label.', 'Una ruta dentro del elemento; vacía: solo la etiqueta.', 'Ein Pfad im Eintrag; leer: nur die Beschriftung.', '項目內的路徑；留空：只顯示標籤。', '条目内的路径；留空：只显示标签。') }),
    ...formatOptions(),
    ...listOptions(),
  }),
  intervalMs: 60_000,
  timeoutMs: 65_000,
  async fetch({ options, signal }): Promise<ListData | null> {
    if (options.push.trim() || !options.url.trim()) return null;
    return { at: Date.now(), ...rowsOf(await requestJson(options, signal), options) };
  },
  render(g, ctx) {
    const { box, options, theme, kit, now, sources } = ctx;
    let d: Omit<ListData, 'at'> | null = null;
    if (options.push.trim()) {
      const p = pushedDoc(sources, options.push, now);
      if (!p.found) return drawNothing(g, ctx, { message: ctx.t(NO_PUSH).replace('{name}', options.push.trim()) });
      d = rowsOf(p.doc, options);
    } else if (!options.url.trim()) return drawNothing(g, ctx, { message: ctx.t(NO_SOURCE) });
    else d = (ctx.data as ListData | undefined) ?? null;
    if (!d) return drawNothing(g, ctx, { message: ctx.t(WAITING) });
    if (d.error) return drawNothing(g, ctx, { message: ctx.t(BAD_PATH) + d.error });
    if (!d.rows) return drawNothing(g, ctx, { message: ctx.t(options.items.trim() ? NOT_FOUND : CHOOSE), hints: d.hints });
    const rows = d.rows;
    if (!rows.length) return drawEmpty(g, ctx, ctx.t(L('The list is empty', 'La lista está vacía', 'Die Liste ist leer', '清單是空的', '列表为空')));
    const plan = listLayout(box, rows.length, options, { sizes: { 'one-line': { min: 18, max: 44 } }, minRows: 2 });
    const ts = plan.textSize;
    plan.rows.forEach((row, i) => {
      const r = rows[i]!;
      const base = row.y + plan.rowH * 0.5 + ts * 0.36;
      const hasValue = r.value !== undefined;
      const value = hasValue ? formatValue(r.value, { decimals: options.decimals, prefix: options.prefix, unit: r.unit ?? options.unit, locale: ctx.locale }) : '';
      const vfont = { size: ts, family: toNumber(r.value) !== undefined ? theme.fonts.monoBold : theme.fonts.sansBold, color: toneColor(theme, toneFor(r.value, options.thresholds)) };
      const vw = value ? Math.min(box.w * 0.6, kit.measureTracked(g, value, vfont)) : 0;
      const shown = value ? kit.truncate(g, value, vw, vfont) : '';
      if (shown) kit.drawTracked(g, shown, box.x + box.w, base, { ...vfont, align: 'right' });
      const lfont = { size: ts, family: theme.fonts.sans, color: hasValue ? theme.colors.inkDim : theme.colors.ink };
      kit.drawTracked(g, kit.truncate(g, r.label, Math.max(1, box.w - vw - ts * 0.6), lfont), box.x, base, lfont);
    });
    drawMore(g, ctx, plan);
  },
  demo: () => ({
    options: { url: 'https://api.open-meteo.com/v1/forecast?latitude=40.4&longitude=-3.7&current=temperature_2m,relative_humidity_2m,wind_speed_10m', fields: [{ label: 'Temperature', select: '$.current.temperature_2m', unit: '°C' }, { label: 'Humidity', select: '$.current.relative_humidity_2m', unit: '%' }, { label: 'Wind', select: '$.current.wind_speed_10m', unit: 'km/h' }], thresholds: [{ when: '>= 80', tone: 'info' as const }] },
    data: { at: 0, rows: [{ label: 'Temperature', value: 21.4, unit: '°C' } as Row, { label: 'Humidity', value: 83, unit: '%' }, { label: 'Wind', value: 12.6, unit: 'km/h' }] } as ListData | null,
  }),
});

/* core/json-text: a sentence with values in it. */

/** Most `{…}` a template may hold. */
const MAX_SLOTS = 40;

/** A template with `{path}` filled from `doc` (`Backup {$.status} at {$.time}`); `{{` and `}}` are braces. */
export function fillTemplate(template: string, doc: unknown, o: { decimals: number; locale: string }): string {
  let slots = 0;
  return template.replace(/\{\{|\}\}|\{([^{}\n]{1,300})\}/g, (m, path: string | undefined) => {
    if (m === '{{') return '{';
    if (m === '}}') return '}';
    if (++slots > MAX_SLOTS) return m;
    try {
      const r = readPath(doc, path!);
      return r.found ? (Array.isArray(r.value) && /\*/.test(path!) ? r.value.map((v) => valueText(v, o)).join(', ') : valueText(r.value, o)) : '—';
    } catch {
      return m;
    }
  });
}

interface TextData {
  at: number;
  text: string;
  tone?: Tone;
}

export const jsonText = defineWidget({
  id: 'json-text',
  name: L('JSON text', 'Texto JSON', 'JSON-Text', 'JSON 文字', 'JSON 文字'),
  description: L(
    'A sentence with values from a URL that answers JSON, or from a push: "Backup OK at 03:12", "Deploy #812: passed".',
    'Una frase con valores de una URL que responda JSON, o de un push: «Copia OK a las 03:12», «Despliegue #812: correcto».',
    'Ein Satz mit Werten von einer URL, die JSON liefert, oder aus einem Push: „Backup OK um 03:12“, „Deployment #812: bestanden“.',
    '一句話，其中的數值來自回傳 JSON 的 URL 或推送：「備份完成 03:12」、「部署 #812：通過」。',
    '一句话，其中的数值来自返回 JSON 的 URL 或推送：“备份完成 03:12”、“部署 #812：通过”。',
  ),
  icon: 'text-quote',
  category: 'dev',
  tags: ['rest', 'api', 'json', 'webhook', 'push'],
  size: { min: { w: 120, h: 60 }, preferred: { w: 400, h: 160 } },
  sources: [PUSH_SOURCE],
  options: t.object({
    ...sourceOptions(),
    template: t.string({
      default: '{$.text}',
      multiline: true,
      label: L('Text', 'Texto', 'Text', '文字', '文字'),
      help: L(
        'Paths in braces are filled in: Backup {$.status} at {$.time}. {$.items[*].name} lists them all. {{ and }} write braces.',
        'Las rutas entre llaves se rellenan: Copia {$.status} a las {$.time}. {$.items[*].name} las enumera todas. {{ y }} escriben llaves.',
        'Pfade in geschweiften Klammern werden ersetzt: Backup {$.status} um {$.time}. {$.items[*].name} zählt alle auf. {{ und }} schreiben Klammern.',
        '大括號中的路徑會被填入：備份 {$.status}，時間 {$.time}。{$.items[*].name} 會全部列出。{{ 和 }} 表示大括號本身。',
        '大括号中的路径会被填入：备份 {$.status}，时间 {$.time}。{$.items[*].name} 会全部列出。{{ 和 }} 表示大括号本身。',
      ),
    }),
    colorFrom: t.string({ advanced: true, placeholder: '$.status', label: L('Colour from', 'Color según', 'Farbe nach', '顏色依據', '颜色依据'), help: L('The path whose value the colours below look at.', 'La ruta cuyo valor miran los colores de abajo.', 'Der Pfad, dessen Wert die Farben unten prüfen.', '下方顏色規則所參考的路徑。', '下方颜色规则所参考的路径。') }),
    decimals: formatOptions().decimals,
    thresholds: formatOptions().thresholds,
    maxSize: t.integer({ default: 64, min: 10, max: 300, unit: 'px', slider: true, label: L('Largest letter size', 'Tamaño máximo de letra', 'Größte Schriftgröße', '最大字體大小', '最大字号') }),
    align: t.enum(['left', 'center', 'right'] as const, { label: L('Alignment', 'Alineación', 'Ausrichtung', '對齊', '对齐'), labels: { left: L('Left', 'Izquierda', 'Links', '靠左', '左对齐'), center: L('Centre', 'Centro', 'Mitte', '置中', '居中'), right: L('Right', 'Derecha', 'Rechts', '靠右', '右对齐') } }),
  }),
  intervalMs: 60_000,
  timeoutMs: 65_000,
  async fetch({ options, signal, locale }): Promise<TextData | null> {
    if (options.push.trim() || !options.url.trim()) return null;
    return textOf(await requestJson(options, signal), options, locale, Date.now());
  },
  render(g, ctx) {
    const { box, options, theme, kit, now, sources } = ctx;
    let d: TextData | null;
    if (options.push.trim()) {
      const p = pushedDoc(sources, options.push, now);
      if (!p.found) return drawNothing(g, ctx, { message: ctx.t(NO_PUSH).replace('{name}', options.push.trim()) });
      d = textOf(p.doc, options, ctx.locale, p.at ?? now);
    } else if (!options.url.trim()) return drawNothing(g, ctx, { message: ctx.t(NO_SOURCE) });
    else d = (ctx.data as TextData | undefined) ?? null;
    if (!d) return drawNothing(g, ctx, { message: ctx.t(WAITING) });
    const family = theme.fonts.sans;
    const paragraphs = d.text.split('\n');
    let size = options.maxSize;
    let lines: string[] = [];
    for (;; size -= 2) {
      lines = paragraphs.flatMap((p) => (p.trim() ? kit.wrapLines(g, p, box.w, 50, { size, family }) : ['']));
      if (size - 2 < 10 || (lines.length * size * 1.2 <= box.h && !lines.some((l) => l.endsWith('…')))) break;
    }
    const lh = size * 1.2;
    const top = box.y + Math.max(0, box.h - lines.length * lh) / 2 + size * 0.85;
    const x = options.align === 'center' ? box.x + box.w / 2 : options.align === 'right' ? box.x + box.w : box.x;
    lines.forEach((l, i) => kit.drawTracked(g, l, x, top + i * lh, { size, family, color: toneColor(theme, d.tone), align: options.align }));
  },
  demo: ({ now }) => ({
    options: { url: 'https://nas.local/backup/status.json', template: 'Backup {$.status} · {$.size}', thresholds: [{ when: '!= ok', tone: 'alert' as const }], colorFrom: '$.status' },
    data: { at: now, text: 'Backup ok · 12.4 GB' },
  }),
});

function textOf(doc: unknown, o: { template: string; colorFrom: string; decimals: number; thresholds: Threshold[] }, locale: string, at: number): TextData {
  const text = fillTemplate(o.template, doc, { decimals: o.decimals, locale });
  let tone: Tone | undefined;
  if (o.thresholds.length) {
    let v: unknown = text;
    try {
      if (o.colorFrom.trim()) v = readPath(doc, o.colorFrom).value;
    } catch {
      v = undefined;
    }
    tone = toneFor(v, o.thresholds);
  }
  return { at, text, ...(tone ? { tone } : {}) };
}
