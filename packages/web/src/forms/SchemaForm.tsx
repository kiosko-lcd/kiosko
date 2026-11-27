/**
 * A form generated from a plugin's options schema (JSON Schema + `x-ui`
 * hints from @kiosko/sdk's `t` builder). Plugins get a good editor for free.
 */
import { typed } from './ime.ts';
import { createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import { api, type JsonSchema } from '../api.ts';
import { Icon } from '../icons.tsx';
import { loc, t, tr } from '../i18n.ts';

type Value = unknown;

type Choice = { value: string; label?: string; group?: string };
const choiceCache = new Map<string, { at: number; list: Choice[] }>();

/**
 * The source profile the form's choices come from (a widget's `profile`, or the profile being
 * edited in Settings → Data sources): its values, not the default one's. Undefined: the default.
 */
export const ChoicesProfile = createContext<string | undefined>(undefined);

/** The values a source offers for a field (`x-ui.choices`), fetched once and kept for half a minute. */
function useChoices(ref: { source: string; list: string } | undefined): Choice[] {
  const profile = useContext(ChoicesProfile);
  const key = ref ? `${ref.source}|${ref.list}|${profile ?? ''}` : '';
  const [list, setList] = useState<Choice[]>(() => choiceCache.get(key)?.list ?? []);
  useEffect(() => {
    if (!ref) return;
    const hit = choiceCache.get(key);
    if (hit && Date.now() - hit.at < 30_000) return void setList(hit.list);
    let alive = true;
    api
      .choices(ref.source, ref.list, profile)
      .then((r) => {
        choiceCache.set(key, { at: Date.now(), list: r.choices });
        if (alive) setList(r.choices);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [key]);
  return list;
}

/** A text input that offers a source's values in a searchable list, and still takes any text. */
function ChoiceInput({ id, value, placeholder, choices, onChange }: { id: string; value: string; placeholder?: string | undefined; choices: { source: string; list: string }; onChange: (v: string) => void }) {
  const list = useChoices(choices);
  const listId = `${id}-choices`;
  const known = list.find((c) => c.value === value);
  return (
    <>
      <input id={id} class="input mono" list={listId} placeholder={placeholder} value={value} spellcheck={false} onInput={(e) => onChange((e.target as HTMLInputElement).value)} />
      <datalist id={listId}>
        {list.map((c) => (
          <option value={c.value}>{[c.label, c.group].filter(Boolean).join(' · ')}</option>
        ))}
      </datalist>
      {known?.label && <div class="muted small choice-label">{known.label}</div>}
      {!!value && !known && list.length > 0 && <div class="muted small choice-label warn">{tr('choices.unknown')}</div>}
    </>
  );
}

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
      if (ui.multiline) return <textarea id={id} class="input" rows={4} placeholder={ui.placeholder} value={String(value ?? '')} {...typed((text) => onChange(text))} />;
      if (ui.secret) return <SecretInput id={id} value={String(value ?? '')} placeholder={ui.placeholder} onChange={onChange} />;
      if (ui.choices) return <ChoiceInput id={id} value={String(value ?? '')} placeholder={ui.placeholder} choices={ui.choices} onChange={onChange} />;
      return <input id={id} class="input" type={ui.format === 'time' ? 'time' : ui.format === 'date' ? 'date' : 'text'} placeholder={ui.placeholder} value={String(value ?? '')} {...typed((text) => onChange(text))} spellcheck={false} />;
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
      if (ui.widget === 'filter' || schema['x-filter']) return <FilterInput id={id} value={Array.isArray(value) ? value.map(String) : []} placeholder={schema.items?.['x-ui']?.placeholder} choices={ui.choices ?? schema.items?.['x-ui']?.choices} onChange={onChange} />;
      if (isTagList(schema)) return <TagInput id={id} value={Array.isArray(value) ? value.map(String) : []} placeholder={schema.items?.['x-ui']?.placeholder} onChange={onChange} />;
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
      return <MapInput id={id} value={(value as Record<string, string>) ?? {}} keyChoices={ui.keyChoices} onChange={onChange} />;
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
      <input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'} onInput={(e) => onChange((e.target as HTMLInputElement).value)} aria-label={tr('form.colour')} />
      <input id={id} class="input mono" value={value} placeholder="#rrggbb" onInput={(e) => onChange((e.target as HTMLInputElement).value)} spellcheck={false} />
      {value && (
        <button type="button" class="icon-btn" title={tr('form.reset')} onClick={() => onChange('')}>
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
  { u: 's', ms: 1000, label: 'common.seconds' },
  { u: 'min', ms: 60_000, label: 'common.minutes' },
  { u: 'h', ms: 3_600_000, label: 'common.hours' },
] as const;

export function DurationInput({ id, value, min, onChange }: { id?: string; value: number; min?: number; onChange: (v: number) => void }) {
  const best = [...UNITS].reverse().find((x) => value >= x.ms && value % x.ms === 0) ?? (value >= 60_000 ? UNITS[1]! : UNITS[0]!);
  const [unit, setUnit] = useState<string>(best.u);
  const u = UNITS.find((x) => x.u === unit)!;
  return (
    <div class="duration">
      <input id={id} class="input" type="number" min={0} step="any" value={+(value / u.ms).toFixed(3)} onInput={(e) => {
        const n = Number((e.target as HTMLInputElement).value);
        if (Number.isFinite(n)) onChange(Math.max(min ?? 0, Math.round(n * u.ms)));
      }} />
      <select class="input" value={unit} onChange={(e) => setUnit((e.target as HTMLSelectElement).value)}>
        {UNITS.map((x) => (
          <option value={x.u}>{tr(x.label)}</option>
        ))}
      </select>
    </div>
  );
}

const splitPatterns = (text: string) => text.split(/[,\n]/).map((p) => p.trim()).filter(Boolean);

/** A `t.filter()` list, edited as one line of comma-separated patterns ("web, acme/*, !*-old"). */
function FilterInput({ id, value, placeholder, choices, onChange }: { id: string; value: string[]; placeholder?: string | undefined; choices?: { source: string; list: string } | undefined; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(value.join(', '));
  const [open, setOpen] = useState(false);
  const list = useChoices(choices);
  // Undo, or another tab: take the new value unless it is what is being typed.
  useEffect(() => {
    if (splitPatterns(text).join('\n') !== value.join('\n')) setText(value.join(', '));
  }, [value.join('\n')]);
  const set = (next: string[]) => {
    setText(next.join(', '));
    onChange(next);
  };
  const shown = open ? list : list.slice(0, 12);
  return (
    <>
      <input id={id} class="input mono" value={text} placeholder={placeholder} spellcheck={false} onInput={(e) => {
        const v = (e.target as HTMLInputElement).value;
        setText(v);
        onChange(splitPatterns(v));
      }} />
      {list.length > 0 && (
        <div class="choice-chips">
          {shown.map((c) => {
            const on = value.includes(c.value);
            return (
              <button type="button" class={`choice-chip ${on ? 'on' : ''}`} title={[c.value, c.group].filter(Boolean).join(' · ')} onClick={() => set(on ? value.filter((v) => v !== c.value) : [...value, c.value])}>
                {on && <Icon name="check" size={11} />} {c.label ?? c.value}
              </button>
            );
          })}
          {list.length > shown.length && (
            <button type="button" class="choice-chip more" onClick={() => setOpen(true)}>
              {tr('choices.more').replace('{n}', String(list.length - shown.length))}
            </button>
          )}
        </div>
      )}
    </>
  );
}

/**
 * A list of short words (process names, titles to skip): chips that wrap, an × on each, and a
 * box to add more. Not for secrets (they would show), choices, or a list whose order matters,
 * which a plugin asks for with `x-ui: { widget: 'list' }`.
 */
const isTagList = (schema: JsonSchema) => {
  const it = schema.items;
  return !!it && it.type === 'string' && !it.enum && !it['x-ui']?.secret && !it['x-ui']?.choices && !schema['x-ui']?.choices && schema['x-ui']?.widget !== 'list';
};

/** What ends a word: a comma (also the Chinese ，、 and ；) or a new line. */
const SEPARATORS = /[,\n，、；;]/;

function TagInput({ id, value, placeholder, onChange }: { id: string; value: string[]; placeholder?: string | undefined; onChange: (v: string[]) => void }) {
  const [text, setText] = useState('');
  const add = (raw: string) => {
    const words = raw.split(SEPARATORS).map((w) => w.trim()).filter((w) => w && !value.includes(w));
    if (words.length) onChange([...value, ...words]);
    setText('');
  };
  return (
    <div class="tags" id={id} onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}>
      {value.map((w, i) => (
        <span class="tag">
          {w}
          <button type="button" class="tag-x" title={tr('common.delete')} aria-label={t('common.deleteItem', { name: w })} onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <Icon name="x" size={12} />
          </button>
        </span>
      ))}
      <input class="tag-new" value={text} placeholder={value.length ? tr('common.addMore') : placeholder ?? tr('common.addMore')} spellcheck={false}
        onInput={(e) => {
          const v = (e.target as HTMLInputElement).value;
          // While an input method composes (pinyin, zhuyin, kana), the text isn't final yet.
          if (!(e as InputEvent).isComposing && SEPARATORS.test(v)) add(v);
          else setText(v);
        }}
        onCompositionEnd={(e) => {
          const v = (e.target as HTMLInputElement).value;
          if (SEPARATORS.test(v)) add(v);
        }}
        onKeyDown={(e) => {
          // Enter or Backspace inside an input method's composition belongs to it, not to the list.
          if (e.isComposing || e.keyCode === 229) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            add(text);
          } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => text.trim() && add(text)} />
    </div>
  );
}

/** What a list item shows while folded: its first two short texts (never a secret), or its number. */
function itemSummary(item: JsonSchema, v: unknown, i: number): string {
  const o = (v ?? {}) as Record<string, unknown>;
  const texts = Object.entries(item.properties ?? {})
    .filter(([, s]) => (s.type === 'string' || s.enum) && !s['x-ui']?.secret && !s['x-ui']?.advanced)
    .map(([k]) => o[k])
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .map((x) => x.replace(/^https?:\/\//, ''));
  return texts.slice(0, 2).join(' · ') || `#${i + 1}`;
}

/**
 * A list, one line per item: a plain value is edited in place, with its buttons beside it; an
 * item with fields of its own (a feed, a server) folds to a summary line and opens to be edited,
 * so a long list doesn't repeat every field and every hint.
 */
function ListInput({ id, schema, value, onChange }: { id: string; schema: JsonSchema; value: unknown[]; onChange: (v: unknown[]) => void }) {
  const item = schema.items ?? { type: 'string' };
  const folds = item.type === 'object' && !!item.properties;
  const [open, setOpen] = useState<number | null>(null);
  const blank = () => (item.type === 'object' ? JSON.parse(JSON.stringify(item.default ?? Object.fromEntries(Object.entries(item.properties ?? {}).map(([k, s]) => [k, s.default])))) : item.default ?? (item.type === 'number' || item.type === 'integer' ? 0 : ''));
  const set = (i: number, v: unknown) => onChange(value.map((x, j) => (j === i ? v : x)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    if (open === i) setOpen(j);
    else if (open === j) setOpen(i);
    onChange(next);
  };
  const remove = (i: number) => {
    if (open === i) setOpen(null);
    else if (open !== null && open > i) setOpen(open - 1);
    onChange(value.filter((_, j) => j !== i));
  };
  const actions = (i: number) => (
    <div class="list-actions">
      <button type="button" class="icon-btn" onClick={() => move(i, -1)} disabled={i === 0} title={tr('common.moveUp')} aria-label={tr('common.moveUp')}>
        <Icon name="arrow-up" size={14} />
      </button>
      <button type="button" class="icon-btn" onClick={() => move(i, 1)} disabled={i === value.length - 1} title={tr('common.moveDown')} aria-label={tr('common.moveDown')}>
        <Icon name="arrow-down" size={14} />
      </button>
      <button type="button" class="icon-btn danger" onClick={() => remove(i)} title={tr('common.delete')} aria-label={tr('common.delete')}>
        <Icon name="trash-2" size={14} />
      </button>
    </div>
  );
  return (
    <div class="list" id={id}>
      {value.map((v, i) =>
        folds ? (
          <div class={`list-item folds ${open === i ? 'open' : ''}`}>
            <div class="list-line">
              <button type="button" class="list-sum" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
                <Icon name={open === i ? 'chevron-down' : 'chevron-right'} size={14} />
                <span>{itemSummary(item, v, i)}</span>
              </button>
              {actions(i)}
            </div>
            {open === i && (
              <div class="list-body">
                <SchemaForm schema={item} value={(v as Record<string, unknown>) ?? {}} onChange={(nv) => set(i, nv)} idPrefix={`${id}-${i}`} />
              </div>
            )}
          </div>
        ) : (
          <div class="list-item line">
            <div class="list-body">
              <Control id={`${id}-${i}`} name="" schema={item} value={v} onChange={(nv) => set(i, nv)} />
            </div>
            {actions(i)}
          </div>
        ),
      )}
      {(schema.maxItems === undefined || value.length < schema.maxItems) && (
        <button type="button" class="btn ghost small" onClick={() => {
          if (folds) setOpen(value.length);
          onChange([...value, blank()]);
        }}>
          <Icon name="plus" size={14} /> {tr('common.add')}
        </button>
      )}
    </div>
  );
}

/**
 * A string → string map. With `keyChoices` (a source's live list), each key
 * shows its label under it (a device's last reading, say), and the keys not in
 * the map yet are offered below, one click each.
 */
function MapInput({ id, value, keyChoices, onChange }: { id: string; value: Record<string, string>; keyChoices?: { source: string; list: string } | undefined; onChange: (v: Record<string, string>) => void }) {
  const rows = Object.entries(value);
  const setRow = (i: number, k: string, v: string) => onChange(Object.fromEntries(rows.map((r, j) => (j === i ? [k, v] : r))));
  const choices = useChoices(keyChoices);
  const norm = (k: string) => k.trim().toUpperCase();
  const labelOf = (k: string) => choices.find((c) => norm(c.value) === norm(k));
  const unnamed = choices.filter((c) => !rows.some(([k]) => norm(k) === norm(c.value)));
  const listId = `${id}-keys`;
  // A key added from the offers: straight to its name.
  const [focusKey, setFocusKey] = useState<string | null>(null);
  useEffect(() => {
    if (focusKey === null) return;
    const el = document.getElementById(id)?.querySelector<HTMLInputElement>(`input[data-map-value="${CSS.escape(focusKey)}"]`);
    if (el) {
      el.focus();
      setFocusKey(null);
    }
  }, [focusKey, value]);
  return (
    <div class="list" id={id}>
      {keyChoices && (
        <datalist id={listId}>
          {choices.map((c) => (
            <option value={c.value}>{[c.label, c.group].filter(Boolean).join(' · ')}</option>
          ))}
        </datalist>
      )}
      {rows.map(([k, v], i) => (
        <div class="map-entry">
          <div class="map-row">
            <input class="input mono" value={k} list={keyChoices ? listId : undefined} spellcheck={false} onInput={(e) => setRow(i, (e.target as HTMLInputElement).value, v)} />
            <Icon name="arrow-right" size={14} />
            <input class="input" value={v} data-map-value={k} {...typed((text) => setRow(i, k, text))} />
            <button type="button" class="icon-btn danger" onClick={() => onChange(Object.fromEntries(rows.filter((_, j) => j !== i)))}>
              <Icon name="x" size={14} />
            </button>
          </div>
          {labelOf(k)?.label && <div class="muted small choice-label">{labelOf(k)!.label}</div>}
        </div>
      ))}
      {unnamed.map((c) => (
        <button type="button" class="btn ghost small map-offer" onClick={() => {
            onChange({ ...value, [c.value]: '' });
            setFocusKey(c.value);
          }}>
          <Icon name="plus" size={14} /> <span class="mono">{c.value}</span>
          {c.label && <span class="muted">{c.label}</span>}
        </button>
      ))}
      <button type="button" class="btn ghost small" onClick={() => onChange({ ...value, [`key${rows.length + 1}`]: '' })}>
        <Icon name="plus" size={14} /> {tr('common.add')}
      </button>
    </div>
  );
}
