/**
 * A form generated from a plugin's options schema (JSON Schema + `x-ui`
 * hints from @kiosko/sdk's `t` builder). Plugins get a good editor for free.
 */
import { useEffect, useState } from 'preact/hooks';
import type { JsonSchema } from '../api.ts';
import { Icon } from '../icons.tsx';
import { loc, tr } from '../i18n.ts';

type Value = unknown;

export function SchemaForm({ schema, value, onChange, idPrefix = 'f' }: { schema: JsonSchema; value: Record<string, unknown>; onChange: (v: Record<string, unknown>, key?: string) => void; idPrefix?: string }) {
  const [advanced, setAdvanced] = useState(false);
  const props = Object.entries(schema.properties ?? {});
  const hasAdvanced = props.some(([, s]) => s['x-ui']?.advanced);
  return (
    <div class="form">
      {props
        .filter(([, s]) => advanced || !s['x-ui']?.advanced)
        .map(([key, s]) => (
          <Field key={key} id={`${idPrefix}-${key}`} name={key} schema={s} value={value?.[key] ?? s.default} onChange={(v) => onChange({ ...value, [key]: v }, key)} />
        ))}
      {hasAdvanced && (
        <button type="button" class="link-btn" onClick={() => setAdvanced(!advanced)}>
          <Icon name={advanced ? 'chevron-up' : 'chevron-down'} size={14} /> {tr('inspector.advanced')}
        </button>
      )}
    </div>
  );
}

function Label({ id, schema, name }: { id: string; schema: JsonSchema; name: string }) {
  const ui = schema['x-ui'] ?? {};
  return (
    <label class="field-label" for={id}>
      {loc(ui.label) || humanize(name)}
    </label>
  );
}

function Help({ schema }: { schema: JsonSchema }) {
  const h = loc(schema['x-ui']?.help);
  return h ? <div class="field-help">{h}</div> : null;
}

const humanize = (s: string) => s.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

export function Field({ id, name, schema, value, onChange }: { id: string; name: string; schema: JsonSchema; value: Value; onChange: (v: Value) => void }) {
  const ui = schema['x-ui'] ?? {};
  // Boolean: a switch on one line.
  if (schema.type === 'boolean') {
    return (
      <div class="field field-row">
        <Toggle id={id} checked={!!value} onChange={onChange} />
        <div>
          <label class="field-label inline" for={id}>
            {loc(ui.label) || humanize(name)}
          </label>
          <Help schema={schema} />
        </div>
      </div>
    );
  }
  return (
    <div class="field">
      {schema.type !== 'object' && <Label id={id} schema={schema} name={name} />}
      <Control id={id} name={name} schema={schema} value={value} onChange={onChange} />
      {schema.type !== 'object' && <Help schema={schema} />}
    </div>
  );
}

function Control({ id, name, schema, value, onChange }: { id: string; name: string; schema: JsonSchema; value: Value; onChange: (v: Value) => void }) {
  const ui = schema['x-ui'] ?? {};
  if (schema.enum) {
    const labels = ui.labels ?? {};
    if (schema.enum.length <= 4) {
      return (
        <div class="segmented" role="radiogroup" id={id}>
          {schema.enum.map((v) => (
            <button type="button" role="radio" aria-checked={value === v} class={value === v ? 'on' : ''} onClick={() => onChange(v)}>
              {loc(labels[v]) || humanize(v)}
            </button>
          ))}
        </div>
      );
    }
    return (
      <select id={id} class="input" value={String(value ?? '')} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
        {schema.enum.map((v) => (
          <option value={v}>{loc(labels[v]) || humanize(v)}</option>
        ))}
      </select>
    );
  }
  switch (schema.type) {
    case 'string':
      if (ui.widget === 'color') return <ColorInput id={id} value={String(value ?? '')} onChange={onChange} />;
      if (ui.multiline) return <textarea id={id} class="input" rows={4} placeholder={ui.placeholder} value={String(value ?? '')} onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)} />;
      if (ui.secret) return <SecretInput id={id} value={String(value ?? '')} placeholder={ui.placeholder} onChange={onChange} />;
      return <input id={id} class="input" type={ui.format === 'time' ? 'time' : ui.format === 'date' ? 'date' : 'text'} placeholder={ui.placeholder} value={String(value ?? '')} onInput={(e) => onChange((e.target as HTMLInputElement).value)} spellcheck={false} />;
    case 'integer':
    case 'number': {
      if (ui.unit === 'ms') return <DurationInput id={id} value={Number(value ?? 0)} min={schema.minimum} onChange={onChange} />;
      const num = Number(value ?? 0);
      const set = (s: string) => {
        if (s.trim() === '') return;
        const n = Number(s);
        if (Number.isFinite(n)) onChange(schema.type === 'integer' ? Math.round(n) : n);
      };
      if (ui.slider && schema.minimum !== undefined && schema.maximum !== undefined) {
        return (
          <div class="slider-row">
            <input id={id} type="range" min={schema.minimum} max={schema.maximum} step={ui.step ?? (schema.type === 'integer' ? 1 : (schema.maximum - schema.minimum) / 100)} value={num} onInput={(e) => set((e.target as HTMLInputElement).value)} />
            <span class="slider-value">
              {+num.toFixed(2)}
              {ui.unit ? ` ${ui.unit}` : ''}
            </span>
          </div>
        );
      }
      return (
        <div class="with-unit">
          <input id={id} class="input" type="number" min={schema.minimum} max={schema.maximum} step={ui.step ?? (schema.type === 'integer' ? 1 : 'any')} value={num} onInput={(e) => set((e.target as HTMLInputElement).value)} />
          {ui.unit && <span class="unit">{ui.unit}</span>}
        </div>
      );
    }
    case 'array':
      if (ui.widget === 'filter' || schema['x-filter']) return <FilterInput id={id} value={Array.isArray(value) ? value.map(String) : []} placeholder={schema.items?.['x-ui']?.placeholder} onChange={onChange} />;
      return <ListInput id={id} schema={schema} value={Array.isArray(value) ? value : []} onChange={onChange} />;
    case 'object':
      if (schema.properties) {
        return (
          <fieldset class="fieldset">
            <legend>{loc(ui.label) || humanize(name)}</legend>
            <SchemaForm schema={schema} value={(value as Record<string, unknown>) ?? {}} onChange={onChange} idPrefix={id} />
          </fieldset>
        );
      }
      return <MapInput id={id} value={(value as Record<string, string>) ?? {}} onChange={onChange} />;
    default:
      return <input id={id} class="input" value={JSON.stringify(value)} onChange={(e) => {
        try {
          onChange(JSON.parse((e.target as HTMLInputElement).value));
        } catch {
          /* ignore until valid */
        }
      }} />;
  }
}

export function Toggle({ id, checked, onChange }: { id?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" id={id} role="switch" aria-checked={checked} class={`switch ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}>
      <span class="knob" />
    </button>
  );
}

function ColorInput({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <div class="color-row">
      <input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'} onInput={(e) => onChange((e.target as HTMLInputElement).value)} aria-label="colour" />
      <input id={id} class="input mono" value={value} placeholder="#rrggbb" onInput={(e) => onChange((e.target as HTMLInputElement).value)} spellcheck={false} />
      {value && (
        <button type="button" class="icon-btn" title="Reset" onClick={() => onChange('')}>
          <Icon name="x" size={14} />
        </button>
      )}
    </div>
  );
}

function SecretInput({ id, value, placeholder, onChange }: { id: string; value: string; placeholder?: string; onChange: (v: string) => void }) {
  const [show, setShow] = useState(false);
  return (
    <div class="with-unit">
      <input id={id} class="input mono" type={show ? 'text' : 'password'} autocomplete="off" placeholder={placeholder} value={value} onInput={(e) => onChange((e.target as HTMLInputElement).value)} />
      <button type="button" class="icon-btn" onClick={() => setShow(!show)} title={show ? 'Hide' : 'Show'}>
        <Icon name={show ? 'eye-off' : 'eye'} size={15} />
      </button>
    </div>
  );
}

const UNITS = [
  { u: 's', ms: 1000 },
  { u: 'min', ms: 60_000 },
  { u: 'h', ms: 3_600_000 },
];

export function DurationInput({ id, value, min, onChange }: { id?: string; value: number; min?: number; onChange: (v: number) => void }) {
  const best = [...UNITS].reverse().find((x) => value >= x.ms && value % x.ms === 0) ?? (value >= 60_000 ? UNITS[1]! : UNITS[0]!);
  const [unit, setUnit] = useState(best.u);
  const u = UNITS.find((x) => x.u === unit)!;
  return (
    <div class="duration">
      <input id={id} class="input" type="number" min={0} step="any" value={+(value / u.ms).toFixed(3)} onInput={(e) => {
        const n = Number((e.target as HTMLInputElement).value);
        if (Number.isFinite(n)) onChange(Math.max(min ?? 0, Math.round(n * u.ms)));
      }} />
      <select class="input" value={unit} onChange={(e) => setUnit((e.target as HTMLSelectElement).value)}>
        {UNITS.map((x) => (
          <option value={x.u}>{x.u}</option>
        ))}
      </select>
    </div>
  );
}

const splitPatterns = (text: string) => text.split(/[,\n]/).map((p) => p.trim()).filter(Boolean);

/** A `t.filter()` list, edited as one line of comma-separated patterns ("web, acme/*, !*-old"). */
function FilterInput({ id, value, placeholder, onChange }: { id: string; value: string[]; placeholder?: string; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(value.join(', '));
  // Undo, or another tab: take the new value unless it is what is being typed.
  useEffect(() => {
    if (splitPatterns(text).join('\n') !== value.join('\n')) setText(value.join(', '));
  }, [value.join('\n')]);
  return (
    <input id={id} class="input mono" value={text} placeholder={placeholder} spellcheck={false} onInput={(e) => {
      const v = (e.target as HTMLInputElement).value;
      setText(v);
      onChange(splitPatterns(v));
    }} />
  );
}

function ListInput({ id, schema, value, onChange }: { id: string; schema: JsonSchema; value: unknown[]; onChange: (v: unknown[]) => void }) {
  const item = schema.items ?? { type: 'string' };
  const blank = () => (item.type === 'object' ? JSON.parse(JSON.stringify(item.default ?? Object.fromEntries(Object.entries(item.properties ?? {}).map(([k, s]) => [k, s.default])))) : item.default ?? (item.type === 'number' || item.type === 'integer' ? 0 : ''));
  const set = (i: number, v: unknown) => onChange(value.map((x, j) => (j === i ? v : x)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div class="list" id={id}>
      {value.map((v, i) => (
        <div class="list-item">
          <div class="list-body">
            {item.type === 'object' && item.properties ? (
              <SchemaForm schema={item} value={(v as Record<string, unknown>) ?? {}} onChange={(nv) => set(i, nv)} idPrefix={`${id}-${i}`} />
            ) : (
              <Control id={`${id}-${i}`} name="" schema={item} value={v} onChange={(nv) => set(i, nv)} />
            )}
          </div>
          <div class="list-actions">
            <button type="button" class="icon-btn" onClick={() => move(i, -1)} disabled={i === 0} title="↑">
              <Icon name="arrow-up" size={14} />
            </button>
            <button type="button" class="icon-btn" onClick={() => move(i, 1)} disabled={i === value.length - 1} title="↓">
              <Icon name="arrow-down" size={14} />
            </button>
            <button type="button" class="icon-btn danger" onClick={() => onChange(value.filter((_, j) => j !== i))} title={tr('common.delete')}>
              <Icon name="trash-2" size={14} />
            </button>
          </div>
        </div>
      ))}
      {(schema.maxItems === undefined || value.length < schema.maxItems) && (
        <button type="button" class="btn ghost small" onClick={() => onChange([...value, blank()])}>
          <Icon name="plus" size={14} /> {tr('common.add')}
        </button>
      )}
    </div>
  );
}

function MapInput({ id, value, onChange }: { id: string; value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const rows = Object.entries(value);
  const setRow = (i: number, k: string, v: string) => onChange(Object.fromEntries(rows.map((r, j) => (j === i ? [k, v] : r))));
  return (
    <div class="list" id={id}>
      {rows.map(([k, v], i) => (
        <div class="map-row">
          <input class="input mono" value={k} onInput={(e) => setRow(i, (e.target as HTMLInputElement).value, v)} />
          <Icon name="arrow-right" size={14} />
          <input class="input" value={v} onInput={(e) => setRow(i, k, (e.target as HTMLInputElement).value)} />
          <button type="button" class="icon-btn danger" onClick={() => onChange(Object.fromEntries(rows.filter((_, j) => j !== i)))}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
      <button type="button" class="btn ghost small" onClick={() => onChange({ ...value, [`key${rows.length + 1}`]: '' })}>
        <Icon name="plus" size={14} /> {tr('common.add')}
      </button>
    </div>
  );
}
