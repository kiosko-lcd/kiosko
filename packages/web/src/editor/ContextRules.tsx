/**
 * "Show this page when…": a page's context rules (core's context.ts) in the
 * page inspector, and the line that says why a page is on the panel now.
 */
import { useEffect, useState } from 'preact/hooks';
import { COMPARE_OPS, CONTEXT_TIMING, type CompareOp, type Page, type Screen, type ShowWhenRule } from '@kiosko/core/model';
import { api, type ContextInfo } from '../api.ts';
import { DurationInput, Toggle } from '../forms/SchemaForm.tsx';
import { typed } from '../forms/ime.ts';
import { Icon } from '../icons.tsx';
import { t, tr, uiLanguage, type TKey } from '../i18n.ts';
import { app, widgets } from '../store.ts';

type Kind = 'app' | 'source' | 'time' | 'urgent';
const KINDS: { kind: Kind; icon: string; make: () => ShowWhenRule }[] = [
  { kind: 'app', icon: 'app-window', make: () => ({ app: '' }) },
  { kind: 'source', icon: 'database', make: () => ({ source: '' }) },
  { kind: 'time', icon: 'clock', make: () => ({ time: { start: '18:00', end: '23:00' } }) },
  { kind: 'urgent', icon: 'siren', make: () => ({ urgent: true }) },
];
const APP_EXAMPLES = ['steam*', 'obs*', 'zoom*', 'teams*', 'discord*', 'code*'];
const NO_VALUE: CompareOp[] = ['truthy', 'falsy'];

/** Short weekday names in the editor's language, Sunday first. */
function weekdays(): string[] {
  const f = new Intl.DateTimeFormat(uiLanguage(), { weekday: 'short' });
  // 2026-11-22 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => f.format(new Date(2026, 10, 22 + i)));
}

type Setter = (fn: (pg: Page) => void, key?: string) => void;
type ScreenSetter = (fn: (sc: Screen) => void, key?: string) => void;

export function ContextRules({ page: p, screen: s, set, setScreen }: { page: Page; screen: Screen; set: Setter; setScreen: ScreenSetter }) {
  const rules = p.showWhen ?? [];
  const setRule = (i: number, fn: (r: ShowWhenRule) => void, key?: string) => set((pg) => {
    const r = pg.showWhen?.[i];
    if (r) fn(r);
  }, key);
  return (
    <section class="ctx-rules">
      <h3>
        <Icon name="zap" size={13} /> {tr('ctx.title')}
      </h3>
      <p class="muted small">{tr('ctx.hint')}</p>
      {rules.map((r, i) => (
        <RuleCard key={i} rule={r} i={i} set={(fn, key) => setRule(i, fn, key)} remove={() => set((pg) => {
          pg.showWhen = (pg.showWhen ?? []).filter((_, j) => j !== i);
          if (!pg.showWhen.length) {
            delete pg.showWhen;
            delete pg.inRotation;
          }
        })} />
      ))}
      <div class="ctx-add">
        {KINDS.map((k) => (
          <button type="button" class="btn ghost small" onClick={() => set((pg) => (pg.showWhen = [...(pg.showWhen ?? []), k.make()]))}>
            <Icon name="plus" size={13} /> <Icon name={k.icon} size={13} /> {tr(`ctx.kind.${k.kind}` as TKey)}
          </button>
        ))}
      </div>
      {rules.length > 0 && (
        <>
          <div class="field field-row">
            <Toggle checked={p.inRotation === true} onChange={(v) => set((pg) => (v ? (pg.inRotation = true) : delete pg.inRotation))} />
            <div>
              <span class="field-label inline">{tr('ctx.alsoRotate')}</span>
              <div class="field-help">{tr('ctx.alsoRotateHint')}</div>
            </div>
          </div>
          <details class="ctx-timing">
            <summary>{tr('ctx.timing')}</summary>
            <p class="muted small">{tr('ctx.timingHint')}</p>
            <label class="field-label">{tr('ctx.minMs')}</label>
            <DurationInput value={s.context?.minMs ?? CONTEXT_TIMING.minMs} min={0} onChange={(v) => setScreen((sc) => (sc.context = { ...sc.context, minMs: v }), 'ctx-min')} />
            <label class="field-label">{tr('ctx.holdMs')}</label>
            <DurationInput value={s.context?.holdMs ?? CONTEXT_TIMING.holdMs} min={0} onChange={(v) => setScreen((sc) => (sc.context = { ...sc.context, holdMs: v }), 'ctx-hold')} />
          </details>
        </>
      )}
    </section>
  );
}

function RuleCard({ rule: r, i, set, remove }: { rule: ShowWhenRule; i: number; set: (fn: (r: ShowWhenRule) => void, key?: string) => void; remove: () => void }) {
  const id = `ctx-${i}`;
  const kinds = KINDS.filter((k) => (k.kind === 'app' ? r.app !== undefined : k.kind === 'source' ? r.source !== undefined : k.kind === 'time' ? !!r.time : !!r.urgent));
  return (
    <div class="ctx-rule">
      <div class="ctx-rule-head">
        {kinds.map((k) => <Icon name={k.icon} size={14} />)}
        <input class="input ctx-label" value={r.label ?? ''} placeholder={tr('ctx.labelPh')} aria-label={tr('ctx.label')} {...typed((text) => set((x) => (text.trim() ? (x.label = text) : delete x.label), `${id}-label`))} />
        <label class="ctx-prio" title={tr('ctx.priorityHint')}>
          <Icon name="arrow-up-narrow-wide" size={13} />
          <input class="input" type="number" step={1} value={r.priority ?? 0} aria-label={tr('ctx.priority')} onInput={(e) => {
            const n = Math.round(Number((e.target as HTMLInputElement).value));
            set((x) => (Number.isFinite(n) && n !== 0 ? (x.priority = n) : delete x.priority), `${id}-prio`);
          }} />
        </label>
        <button type="button" class="icon-btn danger" title={tr('ctx.remove')} onClick={remove}>
          <Icon name="trash-2" size={14} />
        </button>
      </div>
      {r.app !== undefined && <AppField id={id} value={r.app} onChange={(v) => set((x) => (x.app = v), `${id}-app`)} />}
      {r.source !== undefined && <SourceField id={id} rule={r} set={set} />}
      {r.time && <TimeField id={id} time={r.time} set={set} />}
      {r.urgent && <p class="muted small">{tr('ctx.urgentHint')}</p>}
    </div>
  );
}

function AppField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <>
      <label class="field-label" for={`${id}-app`}>{tr('ctx.app')}</label>
      <input id={`${id}-app`} class="input mono" value={value} placeholder="steam*" list={`${id}-apps`} spellcheck={false} {...typed(onChange)} />
      <datalist id={`${id}-apps`}>{APP_EXAMPLES.map((x) => <option value={x} />)}</datalist>
      <div class="field-help">{tr('ctx.appHint')}</div>
      <div class="ctx-examples">
        {APP_EXAMPLES.slice(0, 3).map((x) => (
          <button type="button" class="pill" onClick={() => onChange(value.trim() ? `${value.trim()}, ${x}` : x)}>{x}</button>
        ))}
      </div>
    </>
  );
}

function SourceField({ id, rule: r, set }: { id: string; rule: ShowWhenRule; set: (fn: (r: ShowWhenRule) => void, key?: string) => void }) {
  const sources = (app.value?.catalog ?? []).filter((p) => p.enabled).flatMap((p) => p.sources.map((s) => ({ ...s, plugin: p.name })));
  const [paths, setPaths] = useState<{ path: string; value: string }[]>([]);
  useEffect(() => {
    if (!r.source) return setPaths([]);
    let alive = true;
    api.sourcePaths(r.source).then((x) => alive && setPaths(x.paths), () => alive && setPaths([]));
    return () => {
      alive = false;
    };
  }, [r.source]);
  const op = r.op ?? (r.value === undefined ? 'truthy' : 'eq');
  const here = paths.find((x) => x.path === (r.path ?? ''));
  return (
    <>
      <label class="field-label" for={`${id}-src`}>{tr('ctx.source')}</label>
      <select id={`${id}-src`} class="input" value={r.source} onChange={(e) => set((x) => {
        x.source = (e.target as HTMLSelectElement).value;
        delete x.path;
      })}>
        <option value="">{tr('ctx.sourceNone')}</option>
        {r.source && !sources.some((s) => s.type === r.source) && <option value={r.source}>{r.source}</option>}
        {sources.map((s) => (
          <option value={s.type}>{s.name} · {s.type}</option>
        ))}
      </select>
      <label class="field-label" for={`${id}-path`}>{tr('ctx.path')}</label>
      <input id={`${id}-path`} class="input mono" value={r.path ?? ''} placeholder={paths[0]?.path || 'active'} list={`${id}-paths`} spellcheck={false} {...typed((v) => set((x) => (v.trim() ? (x.path = v) : delete x.path), `${id}-path`))} />
      <datalist id={`${id}-paths`}>{paths.map((x) => <option value={x.path}>{x.value}</option>)}</datalist>
      <div class="field-help">{here ? t('ctx.pathNow', { value: here.value }) : tr('ctx.pathHint')}</div>
      <div class="row">
        <select class="input" value={op} aria-label={tr('ctx.op')} onChange={(e) => set((x) => {
          const v = (e.target as HTMLSelectElement).value as CompareOp;
          if (NO_VALUE.includes(v)) {
            delete x.value;
            if (v === 'truthy') delete x.op;
            else x.op = v;
          } else {
            x.op = v;
            x.value ??= v === 'eq' || v === 'ne' || v === 'contains' ? 'true' : 0;
          }
        })}>
          {COMPARE_OPS.map((o) => <option value={o}>{tr(`ctx.op.${o}` as TKey)}</option>)}
        </select>
        {!NO_VALUE.includes(op) && (
          <input class="input mono" value={r.value === undefined ? '' : String(r.value)} aria-label={tr('ctx.value')} placeholder={tr('ctx.value')} {...typed((v) => set((x) => (x.value = typedValue(v)), `${id}-value`))} />
        )}
      </div>
    </>
  );
}

/** What was typed, as the config keeps it: numbers and true/false as such. */
function typedValue(v: string): string | number | boolean {
  const s = v.trim();
  if (s === 'true' || s === 'false') return s === 'true';
  if (s !== '' && Number.isFinite(Number(s))) return Number(s);
  return v;
}

function TimeField({ id, time, set }: { id: string; time: NonNullable<ShowWhenRule['time']>; set: (fn: (r: ShowWhenRule) => void, key?: string) => void }) {
  const names = weekdays();
  // Monday first, as most of the editor's languages count the week.
  const order = [1, 2, 3, 4, 5, 6, 0];
  const days = time.days ?? [];
  return (
    <>
      <div class="ctx-times">
        <label>
          <span class="field-label">{tr('ctx.from')}</span>
          <input id={`${id}-from`} class="input" type="time" value={time.start} onInput={(e) => set((x) => x.time && (x.time.start = (e.target as HTMLInputElement).value || x.time.start), `${id}-from`)} />
        </label>
        <label>
          <span class="field-label">{tr('ctx.to')}</span>
          <input id={`${id}-to`} class="input" type="time" value={time.end} onInput={(e) => set((x) => x.time && (x.time.end = (e.target as HTMLInputElement).value || x.time.end), `${id}-to`)} />
        </label>
      </div>
      <div class="ctx-days" role="group" aria-label={tr('ctx.days')}>
        {order.map((d) => {
          const on = !days.length || days.includes(d);
          return (
            <button type="button" class={`pill ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => set((x) => {
              if (!x.time) return;
              const cur = x.time.days?.length ? x.time.days : [0, 1, 2, 3, 4, 5, 6];
              const next = on ? cur.filter((y) => y !== d) : [...cur, d].sort();
              if (!next.length || next.length === 7) delete x.time.days;
              else x.time.days = next;
            })}>{names[d]}</button>
          );
        })}
      </div>
      <div class="field-help">{tr('ctx.timeHint')}</div>
    </>
  );
}

/** Why a context page is on the panel, in a line: "game open (steam)". */
export function contextWhy(c: ContextInfo): string {
  const r = c.reason;
  const name = (type: string) => widgets.value.get(type)?.name ?? type;
  // With a name of its own ("game open"), the details alone: "game open (steam)".
  if (r.label) {
    const bare = [r.app, r.source && `${r.path ?? r.source} = ${r.value ?? ''}`, r.time, r.urgent && name(r.urgent)].filter(Boolean);
    return bare.length ? `${r.label} (${bare.join(', ')})` : r.label;
  }
  const parts = [
    r.app && t('ctx.why.app', { name: r.app }),
    r.source && t('ctx.why.source', { source: `${r.source}${r.path ? ` · ${r.path}` : ''}`, value: r.value ?? '' }),
    r.time && t('ctx.why.time', { time: r.time }),
    r.urgent && t('ctx.why.urgent', { widget: name(r.urgent) }),
  ].filter(Boolean) as string[];
  return parts.join(', ');
}
