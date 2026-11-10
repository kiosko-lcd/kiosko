/**
 * The parts of a plugin context that don't depend on the host: language,
 * texts, formatters, place and working week. Kiosko builds every context on
 * top of this; plugin tests can build theirs with it instead of by hand:
 *
 *   const ctx = { ...createBaseContext({ now, locale: 'es' }), options, signal, intervalMs: 60_000, timeoutMs: 20_000 };
 */
import { createFormatters, type TimeFormat } from './format.ts';
import { localize, type Localized } from './i18n.ts';
import type { BaseContext, Location, Logger } from './plugin.ts';
import { DEFAULT_WORKDAY, type Workday } from './workday.ts';

export function createBaseContext(o: { now: number; locale?: string; timeFormat?: TimeFormat; workday?: Workday; location?: Location; log?: Logger; dataDir?: string }): BaseContext {
  const locale = o.locale ?? 'en';
  return {
    now: o.now,
    locale,
    t: (text: Localized) => localize(text, locale),
    fmt: createFormatters({ locale, timeFormat: o.timeFormat ?? 'auto', now: o.now }),
    log: o.log ?? (() => undefined),
    dataDir: o.dataDir ?? '',
    ...(o.location ? { location: o.location } : {}),
    workday: o.workday ?? DEFAULT_WORKDAY,
  };
}
