/**
 * Keys every polled source accepts next to its own options, in
 * `sources["plugin/source"]`, and that Kiosko handles itself: how often the
 * source is read (`intervalMs`) and how long one read may take
 * (`timeoutMs`). Plugins only declare defaults and a floor
 * (`SourceDefinition.intervalMs`, `minIntervalMs`, `timeoutMs`).
 *
 * `sourceOptionsField` merges both into one schema, so the runtime, the JSON
 * Schema, `kiosko config validate` and the editor's Data sources form all
 * agree. Pure (no Node).
 */
import { t, type Field, type ObjectField, type SourceDefinition } from '@kiosko/sdk';

/** Interval of a source that doesn't say. */
export const DEFAULT_SOURCE_MS = 30_000;
/** Shortest interval a user may set on a source that doesn't say (or its own default, if shorter). */
export const DEFAULT_MIN_SOURCE_MS = 5_000;
/** Longest a read (or a widget's fetch) may take, for those that don't say. */
export const DEFAULT_TIMEOUT_MS = 2 * 60_000;
/** Bounds the editor and the schema offer. */
const MAX_INTERVAL_MS = 24 * 3_600_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

/** The keys Kiosko handles in a source's options. */
export const SOURCE_COMMON_KEYS = ['intervalMs', 'timeoutMs'] as const;

/** `5000` → "5 s", `120000` → "2 min". */
function human(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${+(ms / 1000).toFixed(1)} s`;
}

/** The defaults and the floor of a source's timing. */
export function sourceTiming(def: SourceDefinition<any, any>): { intervalMs: number; minIntervalMs: number; timeoutMs: number } {
  const intervalMs = Math.max(1, def.intervalMs ?? DEFAULT_SOURCE_MS);
  const minIntervalMs = Math.max(1, def.minIntervalMs ?? Math.min(DEFAULT_MIN_SOURCE_MS, intervalMs));
  return { intervalMs: Math.max(intervalMs, minIntervalMs), minIntervalMs, timeoutMs: def.timeoutMs ?? DEFAULT_TIMEOUT_MS };
}

/**
 * The fields Kiosko adds to a source's options: none for push-only sources
 * (`watch` without `read`), and none that the plugin declares itself. A
 * plugin's own `intervalMs` or `timeoutMs` option keeps its plugin meaning
 * (gpu's read cadence, a per-request timeout) and Kiosko uses the
 * definition's value instead; dropping the option hands it over to Kiosko.
 */
export function sourceCommonFields(def: SourceDefinition<any, any>): Record<string, Field> {
  if (!def.read) return {};
  const { intervalMs, minIntervalMs, timeoutMs } = sourceTiming(def);
  const fields: Record<string, Field> = {
    intervalMs: t.duration({
      default: intervalMs,
      min: minIntervalMs,
      max: Math.max(MAX_INTERVAL_MS, intervalMs),
      label: { en: 'Read every', es: 'Leer cada', de: 'Lesen alle', 'zh-Hant': '讀取間隔', 'zh-Hans': '读取间隔' },
      help: { en: `How often Kiosko reads it while a widget uses it. At least ${human(minIntervalMs)}.`, es: `Cada cuánto lo lee Kiosko mientras algún widget lo usa. Como mínimo, ${human(minIntervalMs)}.`, de: `Wie oft Kiosko sie liest, solange ein Widget sie verwendet. Mindestens ${human(minIntervalMs)}.`, 'zh-Hant': `小工具使用時，Kiosko 讀取它的頻率。最少 ${human(minIntervalMs)}。`, 'zh-Hans': `有小组件使用时 Kiosko 读取它的频率。最少 ${human(minIntervalMs)}。` },
    }),
    timeoutMs: t.duration({
      default: timeoutMs,
      min: MIN_TIMEOUT_MS,
      max: Math.max(MAX_TIMEOUT_MS, timeoutMs),
      advanced: true,
      label: { en: 'Give up a reading after', es: 'Abandonar una lectura tras', de: 'Lesen abbrechen nach', 'zh-Hant': '讀取逾時', 'zh-Hans': '读取超时' },
      help: { en: 'A reading that takes longer is cancelled and counts as failed; the next try comes sooner.', es: 'Una lectura que tarde más se cancela y cuenta como fallida; el siguiente intento llega antes.', de: 'Ein Lesevorgang, der länger dauert, wird abgebrochen und zählt als fehlgeschlagen; der nächste Versuch kommt früher.', 'zh-Hant': '超過此時間的讀取會被取消並視為失敗；下次會提早重試。', 'zh-Hans': '超过此时间的读取会被取消并视为失败；下次会提前重试。' },
    }),
  };
  const own = def.options?.props ?? {};
  return Object.fromEntries(Object.entries(fields).filter(([k]) => !(k in own)));
}

/** The interval and timeout Kiosko uses for a source, from its validated options. */
export function sourceTimes(def: SourceDefinition<any, any>, options: Record<string, unknown>): { intervalMs: number; timeoutMs: number } {
  const timing = sourceTiming(def);
  const managed = sourceCommonFields(def);
  const pick = (k: 'intervalMs' | 'timeoutMs') => (k in managed && typeof options[k] === 'number' ? (options[k] as number) : timing[k]);
  return { intervalMs: pick('intervalMs'), timeoutMs: pick('timeoutMs') };
}

const merged = new WeakMap<SourceDefinition<any, any>, ObjectField | null>();

/**
 * The source's own options plus Kiosko's (`intervalMs`, `timeoutMs`), as one
 * schema. Undefined when there is nothing to set.
 */
export function sourceOptionsField(def: SourceDefinition<any, any>): ObjectField | undefined {
  if (!merged.has(def)) {
    const own = (def.options?.props ?? {}) as Record<string, Field>;
    const props = { ...own, ...sourceCommonFields(def) };
    const o = def.options;
    merged.set(def, Object.keys(props).length ? t.object(props, { ...(o?.label ? { label: o.label } : {}), ...(o?.help ? { help: o.help } : {}) }) : null);
  }
  return merged.get(def) ?? undefined;
}
