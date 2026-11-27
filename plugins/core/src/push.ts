/**
 * Pushes: a script, a cron job, CI or Home Assistant tells the panel
 * something with `POST /api/push/<name>` (the server checks the name's
 * token and writes to `pushes`, see push-store.ts). The `core/push` source
 * hands every name's latest payload to the widgets: the **Push** widget
 * here, and the JSON ones (json.ts) when given a push name.
 *
 *   { "value": 42, "text": "Backup finished", "level": "warn", "ttlMs": 3600000 }
 *
 * `level: alert` keeps the tile; `critical` also raises a full-screen alert;
 * `ttlMs` hides it when it runs out.
 */
import { defineSource, defineWidget, t, type Alert, type Localized } from '@kiosko/sdk';
import { formatValue, toNumber, valueText, type Tone } from './json-format.ts';
import { PUSH_SOURCE, toneColor } from './json.ts';
import { live, pushes, type PushData, type PushEntry } from './push-store.ts';

const L = (en: string, es: string, de: string, hant: string, hans: string): Localized => ({ en, es, de, 'zh-Hant': hant, 'zh-Hans': hans });

export const pushSource = defineSource({
  id: 'push',
  name: L('Pushes', 'Pushes', 'Pushes', '推送', '推送'),
  description: L(
    'What scripts send to POST /api/push/<name>, for the Push widget and the JSON ones.',
    'Lo que los scripts envían a POST /api/push/<nombre>, para el widget Push y los JSON.',
    'Was Skripte an POST /api/push/<name> senden, für das Push-Widget und die JSON-Widgets.',
    '腳本傳送到 POST /api/push/<名稱> 的內容，供推送小工具與 JSON 小工具使用。',
    '脚本发送到 POST /api/push/<名称> 的内容，供推送小组件和 JSON 小组件使用。',
  ),
  watch(_ctx, emit) {
    emit(pushes.snapshot());
    return pushes.subscribe(emit);
  },
  choices: {
    names: (d: PushData) => Object.keys(d?.hooks ?? {}).map((value) => ({ value })),
  },
  demo: ({ now }) => demoPushes(now),
});

/** What the Push widget shows of a payload. */
export interface PushView {
  title?: string;
  value?: unknown;
  text?: string;
  unit?: string;
  level?: 'ok' | 'info' | 'warn' | 'alert' | 'critical';
}

const LEVELS = ['ok', 'info', 'warn', 'alert', 'critical'] as const;
const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined);

/** The parts of a payload the Push widget knows: `value`, `text` (or `message`), `title`, `unit`, `level`. Text alone is the text. */
export function viewOf(payload: unknown): PushView {
  if (typeof payload === 'string') return { text: payload };
  if (typeof payload === 'number' || typeof payload === 'boolean') return { value: payload };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const p = payload as Record<string, unknown>;
  const level = typeof p.level === 'string' ? p.level.toLowerCase() : undefined;
  const text = str(p.text) ?? str(p.message);
  const title = str(p.title);
  const unit = str(p.unit);
  return {
    ...(title ? { title } : {}),
    ...(p.value !== undefined ? { value: p.value } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(unit ? { unit } : {}),
    ...(LEVELS.includes(level as never) ? { level: level as PushView['level'] } : {}),
  };
}

const entryOf = (sources: Record<string, unknown>, name: string): PushEntry | null | undefined => (sources[PUSH_SOURCE] as PushData | undefined)?.hooks?.[name.trim()];

export const push = defineWidget({
  id: 'push',
  name: L('Push', 'Push', 'Push', '推送', '推送'),
  description: L(
    'What a script, cron, CI or Home Assistant sends to POST /api/push/<name>: a value, a text and a level. An alert keeps the tile; it goes away when its time runs out.',
    'Lo que un script, cron, la CI o Home Assistant envía a POST /api/push/<nombre>: un valor, un texto y un nivel. Una alerta se queda la tesela; se quita sola cuando caduca.',
    'Was ein Skript, Cron, CI oder Home Assistant an POST /api/push/<name> sendet: ein Wert, ein Text und eine Stufe. Ein Alarm behält die Kachel; er verschwindet, wenn seine Zeit abläuft.',
    '腳本、cron、CI 或 Home Assistant 傳送到 POST /api/push/<名稱> 的內容：數值、文字與等級。警報會佔住方格，到期後自動消失。',
    '脚本、cron、CI 或 Home Assistant 发送到 POST /api/push/<名称> 的内容：数值、文字和级别。警报会占住格子，到期后自动消失。',
  ),
  icon: 'webhook',
  category: 'dev',
  tags: ['webhook', 'push', 'curl', 'script', 'cron', 'ci'],
  size: { min: { w: 120, h: 60 }, preferred: { w: 360, h: 200 } },
  sources: [PUSH_SOURCE],
  options: t.object({
    name: t.string({ choices: { source: PUSH_SOURCE, list: 'names' }, placeholder: 'backup', label: L('Push name', 'Nombre del push', 'Push-Name', '推送名稱', '推送名称'), help: L('Set up push names, with their URL and token, in Settings → Push.', 'Los nombres, con su URL y su token, se crean en Ajustes → Push.', 'Push-Namen mit URL und Token legst du unter Einstellungen → Push an.', '推送名稱及其 URL 和權杖在「設定 → 推送」中建立。', '推送名称及其 URL 和令牌在“设置 → 推送”中创建。') }),
    unit: t.string({ placeholder: '°C', label: L('Unit', 'Unidad', 'Einheit', '單位', '单位'), help: L('When the push doesn\'t say one.', 'Si el push no trae una.', 'Wenn der Push keine mitbringt.', '推送內容未指定單位時使用。', '推送内容未指定单位时使用。') }),
    decimals: t.integer({ default: -1, min: -1, max: 6, label: L('Decimals', 'Decimales', 'Nachkommastellen', '小數位數', '小数位数'), help: L('-1: as it comes (up to 2).', '-1: tal como viene (hasta 2).', '-1: wie geliefert (bis zu 2).', '-1：依原始值（最多 2 位）。', '-1：按原始值（最多 2 位）。') }),
    showAge: t.boolean({ default: true, label: L('Show how long ago', 'Mostrar hace cuánto', 'Anzeigen, wie lange her', '顯示多久以前', '显示多久以前') }),
  }),
  redraw: 'minute',
  visible: ({ options, sources, now }) => {
    const e = entryOf(sources, options.name);
    // Nothing yet: shown, with how to send it. Run out: hidden.
    return !e || live(e, now);
  },
  urgent: ({ options, sources, now }) => {
    const e = entryOf(sources, options.name);
    const level = live(e, now) ? viewOf(e.payload).level : undefined;
    return level === 'alert' || level === 'critical';
  },
  alerts: ({ options, sources, now }) => {
    const e = entryOf(sources, options.name);
    if (!live(e, now)) return [];
    const v = viewOf(e.payload);
    if (v.level !== 'critical') return [];
    const title = v.title ?? v.text ?? options.name;
    const alert: Alert = { id: `push-${options.name.trim()}-${e.at}`, level: 'critical', title, icon: 'webhook', source: 'Push', ...(e.expiresAt ? { expiresAt: e.expiresAt } : {}) };
    if (v.title && v.text) alert.text = v.text;
    return [alert];
  },
  render(g, ctx) {
    const { box, options, theme, kit, now, sources, fmt } = ctx;
    const name = options.name.trim();
    const small = Math.max(10, Math.min(24, Math.round(box.h / 7)));
    const dimFont = { size: small, family: theme.fonts.sans, color: theme.colors.inkDim };
    if (!name) return void kit.drawTracked(g, kit.truncate(g, ctx.t(L('Choose a push name', 'Elige un nombre de push', 'Wähle einen Push-Namen', '請選擇推送名稱', '请选择推送名称')), box.w, dimFont), box.x, box.y + small * 1.1, dimFont);
    const e = entryOf(sources, name);
    if (!e) {
      kit.drawTracked(g, kit.truncate(g, ctx.t(L('Waiting for a push', 'Esperando un push', 'Warte auf einen Push', '等待推送', '等待推送')), box.w, dimFont), box.x, box.y + small * 1.1, dimFont);
      const mono = { size: Math.max(9, Math.round(small * 0.8)), family: theme.fonts.mono, color: theme.colors.inkFaint };
      kit.drawTracked(g, kit.truncate(g, `POST /api/push/${name}`, box.w, mono), box.x, box.y + small * 2.5, mono);
      return;
    }
    const v = viewOf(e.payload);
    const tone: Tone | undefined = v.level === 'critical' ? 'alert' : v.level;
    const color = toneColor(theme, tone);
    let y = box.y;
    const footer = options.showAge ? small * 1.3 : 0;
    if (v.title) {
      const tf = { size: small, family: theme.fonts.sansBold, color: theme.colors.inkDim, smallCaps: true, tracking: 1 };
      kit.drawTracked(g, kit.truncate(g, v.title, box.w, tf), box.x, y + small * 0.9, tf);
      y += small * 1.4;
    }
    const room = box.y + box.h - footer - y;
    const hasValue = v.value !== undefined;
    const hasText = !!v.text?.trim();
    if (hasValue) {
      const valueH = hasText ? room * 0.62 : room;
      const text = valueText(v.value, { decimals: options.decimals, locale: ctx.locale });
      const unit = (v.unit ?? options.unit).trim();
      const numeric = toNumber(v.value) !== undefined;
      const family = numeric ? theme.fonts.monoBold : theme.fonts.sansBold;
      let size = Math.min(valueH * 0.9, 400);
      g.font = `${size}px "${family}"`;
      const unitK = 0.42;
      const full = () => g.measureText(text).width + (unit ? (g.measureText(unit).width * unitK) + size * 0.1 : 0);
      const w = full();
      if (w > box.w) size = Math.max(8, Math.floor((size * box.w) / w));
      g.font = `${size}px "${family}"`;
      const tw = g.measureText(text).width;
      const base = y + (valueH + size * 0.72) / 2;
      g.fillStyle = color;
      g.textAlign = 'left';
      g.fillText(text, box.x, base);
      if (unit) {
        g.font = `${Math.max(8, Math.round(size * unitK))}px "${theme.fonts.sans}"`;
        g.fillStyle = theme.colors.inkDim;
        g.fillText(unit, box.x + tw + size * 0.1, base);
      }
      y += valueH;
    }
    if (hasText) {
      const h = hasValue ? room * 0.38 : room;
      let size = Math.min(hasValue ? h * 0.8 : 64, h);
      let lines: string[] = [];
      for (;; size -= 2) {
        lines = kit.wrapLines(g, v.text!, box.w, hasValue ? 2 : 6, { size, family: theme.fonts.sans });
        if (size - 2 < 10 || lines.length * size * 1.2 <= h) break;
      }
      const lh = size * 1.2;
      const top = y + Math.max(0, h - lines.length * lh) / 2 + size * 0.85;
      const tc = hasValue ? theme.colors.ink : color;
      lines.forEach((l, i) => kit.drawTracked(g, l, box.x, top + i * lh, { size, family: theme.fonts.sans, color: tc }));
    }
    if (!hasValue && !hasText) {
      const raw = formatValue(e.payload, { decimals: options.decimals, prefix: '', unit: '', locale: ctx.locale });
      kit.drawTracked(g, kit.truncate(g, raw, box.w, { size: small, family: theme.fonts.mono }), box.x, y + small * 1.2, { size: small, family: theme.fonts.mono, color: theme.colors.ink });
    }
    if (footer) {
      const af = { size: Math.max(9, Math.round(small * 0.8)), family: theme.fonts.sans, color: theme.colors.inkFaint };
      kit.drawTracked(g, fmt.ago(e.at), box.x + box.w, box.y + box.h - af.size * 0.3, { ...af, align: 'right' });
    }
  },
  demo: ({ now }) => ({ options: { name: 'backup' }, sources: { [PUSH_SOURCE]: demoPushes(now) } }),
});

/** Sample pushes for the gallery and the browser demo. */
function demoPushes(now: number): PushData {
  const at = now - 25 * 60_000;
  const backup = { title: 'Backup', value: 'OK', text: 'nas → b2 · 12.4 GB', level: 'ok' };
  const garage = { temp: 21.4, humidity: 48 };
  return {
    hooks: {
      backup: { at, payload: backup, history: [{ at, payload: backup }] },
      garage: { at: now - 60_000, payload: garage, history: Array.from({ length: 24 }, (_, i) => ({ at: now - (23 - i) * 3600_000, payload: { temp: 18 + 4 * Math.sin(i / 4), humidity: 48 } })) },
    },
  };
}
