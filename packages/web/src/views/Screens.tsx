/** Screens (physical panels): connection, resolution, rotation, burn-in care and interludes. */
import { useState } from 'preact/hooks';
import { rescale, suggestGrid } from '@tessera/core/layout';
import { newId, newScreen, type DeviceConfig, type Screen } from '@tessera/core/model';
import { api } from '../api.ts';
import { DurationInput, SchemaForm, Toggle } from '../forms/SchemaForm.tsx';
import { Icon } from '../icons.tsx';
import { tr } from '../i18n.ts';
import { app, config, draftScreen, edit, go, lastFrame, notify, pageId, screenId, status } from '../store.ts';

export function Screens() {
  const cfg = config.value!;
  const add = (preset?: { width: number; height: number; name: string }) => {
    const s = newScreen(preset?.name ?? 'Panel', preset?.width ?? 1920, preset?.height ?? 462);
    edit((d) => d.screens.push(s));
    screenId.value = s.id;
    pageId.value = s.pages[0]!.id;
  };
  return (
    <div class="page-view">
      <header class="view-head">
        <div>
          <h1>{tr('screens.title')}</h1>
          <p class="muted">{tr('screens.subtitle')}</p>
        </div>
        <AddScreen onAdd={add} />
      </header>
      <div class="cards-col">
        {cfg.screens.map((s) => (
          <ScreenCard s={s} key={s.id} />
        ))}
      </div>
    </div>
  );
}

function AddScreen({ onAdd }: { onAdd: (p?: { width: number; height: number; name: string }) => void }) {
  const [open, setOpen] = useState(false);
  const [found, setFound] = useState<{ key: string; width: number; height: number }[] | null>(null);
  return (
    <div class="add-screen">
      <button class="btn primary" onClick={() => setOpen(!open)}>
        <Icon name="plus" size={16} /> {tr('screens.add')}
      </button>
      {open && (
        <div class="popover">
          <div class="popover-title">{tr('screens.model')}</div>
          {app.value?.presets.map((p) => (
            <button class="menu-item" onClick={() => {
              onAdd(p);
              setOpen(false);
            }}>
              <PanelGlyph w={p.width} h={p.height} />
              <span>{p.name}</span>
              <small>
                {p.width}×{p.height}
              </small>
            </button>
          ))}
          <div class="popover-sep" />
          <button class="menu-item" onClick={async () => setFound((await api.discover()).trcc)}>
            <Icon name="radar" size={16} /> <span>{tr('screens.detect')}</span> <small>trcc</small>
          </button>
          {found && !found.length && <div class="muted small pad">{tr('screens.noneDetected')}</div>}
          {found?.map((f) => (
            <button class="menu-item" onClick={() => {
              onAdd({ width: f.width, height: f.height, name: f.key });
              setOpen(false);
            }}>
              <Icon name="usb" size={16} /> <span>{f.key}</span>
              <small>
                {f.width}×{f.height}
              </small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PanelGlyph({ w, h }: { w: number; h: number }) {
  const s = 26 / Math.max(w, h);
  return (
    <span class="panel-glyph">
      <span style={{ width: Math.max(4, w * s), height: Math.max(4, h * s) }} />
    </span>
  );
}

function ScreenCard({ s }: { s: Screen }) {
  const st = status.value?.screens.find((x) => x.id === s.id);
  const set = (fn: (x: Screen) => void, key?: string) => edit((d) => {
    const x = draftScreen(d, s.id);
    if (x) fn(x);
  }, key);
  const setDevice = (dev: DeviceConfig) => set((x) => (x.device = dev));
  const resize = (width: number, height: number) => set((x) => {
    x.width = width;
    x.height = height;
    for (const p of x.pages) {
      const g = suggestGrid(width, height);
      p.tiles = rescale(p.tiles, p.grid, g);
      p.grid = g;
    }
  });
  const interludes = (app.value?.catalog ?? []).flatMap((p) => (p.enabled ? p.interludes : []));
  const dev = s.device;
  return (
    <section class="card screen-card">
      <div class="card-head">
        <PanelGlyph w={s.width} h={s.height} />
        <input class="title-input" value={s.name} onInput={(e) => set((x) => (x.name = (e.target as HTMLInputElement).value), `sname-${s.id}`)} aria-label={tr('screens.name')} />
        <span class={`status-pill ${st?.device.ok ? 'ok' : 'bad'}`}>
          <span class="dot" /> {st?.device.message ?? '—'}
        </span>
        <div class="tb-spacer" />
        <button class="btn ghost small" onClick={() => {
          screenId.value = s.id;
          pageId.value = s.pages[0]?.id ?? null;
          go('editor');
        }}>
          <Icon name="pencil-ruler" size={14} /> {tr('nav.editor')}
        </button>
        <a class="btn ghost small" href={`/api/screens/export?id=${encodeURIComponent(s.id)}`} download>
          <Icon name="download" size={14} /> {tr('screens.export')}
        </a>
        <Toggle checked={s.enabled} onChange={(v) => set((x) => (x.enabled = v))} />
      </div>
      <LiveThumb s={s} />
      <div class="grid-2">
        <div>
          <label class="field-label">{tr('screens.resolution')}</label>
          <div class="row">
            <select class="input" value={app.value?.presets.find((p) => p.width === s.width && p.height === s.height)?.id ?? ''} onChange={(e) => {
              const p = app.value?.presets.find((x) => x.id === (e.target as HTMLSelectElement).value);
              if (p) resize(p.width, p.height);
            }}>
              <option value="">—</option>
              {app.value?.presets.map((p) => (
                <option value={p.id}>{p.name}</option>
              ))}
            </select>
            <input class="input num" type="number" value={s.width} onChange={(e) => resize(Number((e.target as HTMLInputElement).value) || s.width, s.height)} aria-label="width" />
            <span class="muted">×</span>
            <input class="input num" type="number" value={s.height} onChange={(e) => resize(s.width, Number((e.target as HTMLInputElement).value) || s.height)} aria-label="height" />
          </div>
          {st?.device.detected && (st.device.detected.width !== s.width || st.device.detected.height !== s.height) && (
            <button class="btn ghost small warn" onClick={() => resize(st.device.detected!.width, st.device.detected!.height)}>
              <Icon name="triangle-alert" size={14} /> {tr('screens.detected')}: {st.device.detected.width}×{st.device.detected.height}
            </button>
          )}
          <label class="field-label">{tr('screens.rotation')}</label>
          <div class="segmented">
            {([0, 90, 180, 270] as const).map((r) => (
              <button class={s.rotate === r ? 'on' : ''} onClick={() => set((x) => (x.rotate = r))}>
                {r}°
              </button>
            ))}
          </div>
          <label class="field-label">{tr('screens.driver')}</label>
          <div class="segmented">
            {(['virtual', 'trcc', 'file'] as const).map((d) => (
              <button class={dev.driver === d ? 'on' : ''} onClick={() => setDevice(d === 'trcc' ? { driver: 'trcc', url: 'http://127.0.0.1:8099' } : d === 'file' ? { driver: 'file', dir: '~/.config/tessera/frames/' + s.id } : { driver: 'virtual' })}>
                <Icon name={d === 'virtual' ? 'monitor' : d === 'trcc' ? 'usb' : 'file-image'} size={13} /> {tr(`driver.${d}`)}
              </button>
            ))}
          </div>
          {dev.driver === 'trcc' && (
            <div class="sub-form">
              <label class="field-label">{tr('screens.trccUrl')}</label>
              <input class="input mono" value={dev.url} onInput={(e) => setDevice({ ...dev, url: (e.target as HTMLInputElement).value })} />
              <label class="field-label">{tr('screens.tokenFile')}</label>
              <input class="input mono" value={dev.tokenFile ?? ''} placeholder="~/.aimonitor/trcc-token" onInput={(e) => setDevice({ ...dev, tokenFile: (e.target as HTMLInputElement).value || undefined })} />
              <label class="field-label">{tr('screens.serial')}</label>
              <input class="input mono" value={dev.serial ?? ''} onInput={(e) => setDevice({ ...dev, serial: (e.target as HTMLInputElement).value || undefined })} />
            </div>
          )}
          {dev.driver === 'file' && (
            <div class="sub-form">
              <label class="field-label">{tr('screens.dir')}</label>
              <input class="input mono" value={dev.dir} onInput={(e) => setDevice({ ...dev, dir: (e.target as HTMLInputElement).value })} />
            </div>
          )}
        </div>
        <div>
          <div class="field field-row">
            <Toggle checked={s.pixelShift.enabled} onChange={(v) => set((x) => (x.pixelShift.enabled = v))} />
            <span>{tr('screens.pixelShift')}</span>
          </div>
          <div class="field field-row">
            <Toggle checked={s.sleepWhenIdle} onChange={(v) => set((x) => (x.sleepWhenIdle = v))} />
            <span>{tr('screens.sleep')}</span>
          </div>
          <label class="field-label">{tr('screens.quality')}</label>
          <div class="slider-row">
            <input type="range" min={0} max={100} value={s.jpegQuality} onInput={(e) => set((x) => (x.jpegQuality = Number((e.target as HTMLInputElement).value)), 'q')} />
            <span class="slider-value">{s.jpegQuality || 'PNG'}</span>
          </div>
          <label class="field-label">{tr('screens.fps')}</label>
          <div class="slider-row">
            <input type="range" min={1} max={30} value={s.maxFps} onInput={(e) => set((x) => (x.maxFps = Number((e.target as HTMLInputElement).value)), 'fps')} />
            <span class="slider-value">{s.maxFps}</span>
          </div>
          {st && (
            <div class="muted small">
              {st.device.framesSent} {tr('screens.frames')}
              {st.lastFrameAt ? ` · ${new Date(st.lastFrameAt).toLocaleTimeString()}` : ''}
            </div>
          )}
        </div>
      </div>
      <h3>
        <Icon name="clapperboard" size={15} /> {tr('screens.interludes')}
      </h3>
      <p class="muted small">{tr('screens.interludesHint')}</p>
      {s.interludes.map((slot) => {
        const def = interludes.find((i) => i.type === slot.type);
        const setSlot = (fn: (x: Screen['interludes'][number]) => void, key?: string) => set((x) => {
          const sl = x.interludes.find((y) => y.id === slot.id);
          if (sl) fn(sl);
        }, key);
        return (
          <div class="interlude-row">
            <Toggle checked={slot.enabled} onChange={(v) => setSlot((x) => (x.enabled = v))} />
            <div class="interlude-name">
              <Icon name={def?.icon ?? 'film'} size={15} /> {def?.name ?? slot.type}
            </div>
            <span class="muted small">{tr('screens.every')}</span>
            <DurationInput value={slot.everyMs} min={60_000} onChange={(v) => setSlot((x) => (x.everyMs = v), `ev-${slot.id}`)} />
            <span class="muted small">{tr('screens.maxSeconds')}</span>
            <input class="input num" type="number" min={1} max={600} value={slot.maxSeconds} onChange={(e) => setSlot((x) => (x.maxSeconds = Number((e.target as HTMLInputElement).value) || 30))} />
            <button class="btn ghost small" onClick={() => {
              void api.playInterlude(s.id, slot.id);
              notify(tr('stage.interlude'));
            }}>
              <Icon name="play" size={14} /> {tr('screens.play')}
            </button>
            <button class="icon-btn danger" onClick={() => set((x) => (x.interludes = x.interludes.filter((y) => y.id !== slot.id)))}>
              <Icon name="trash-2" size={14} />
            </button>
            {def?.options && Object.keys(def.options.properties ?? {}).length > 0 && (
              <div class="interlude-options">
                <SchemaForm schema={def.options} value={slot.options} onChange={(v) => setSlot((x) => (x.options = v), `io-${slot.id}`)} />
              </div>
            )}
          </div>
        );
      })}
      {interludes.length > 0 && (
        <select class="input inline-select" value="" onChange={(e) => {
          const type = (e.target as HTMLSelectElement).value;
          if (type) set((x) => x.interludes.push({ id: newId('interlude'), type, enabled: true, everyMs: 15 * 60_000, maxSeconds: 30, options: {} }));
        }}>
          <option value="">+ {tr('screens.addInterlude')}</option>
          {interludes.map((i) => (
            <option value={i.type}>{i.name}</option>
          ))}
        </select>
      )}
      <div class="card-foot">
        <button class="btn ghost small danger" onClick={() => {
          if (!confirm(tr('confirm.deleteScreen'))) return;
          edit((d) => (d.screens = d.screens.filter((x) => x.id !== s.id)));
          if (screenId.value === s.id) screenId.value = null;
        }}>
          <Icon name="trash-2" size={14} /> {tr('screens.delete')}
        </button>
      </div>
    </section>
  );
}

/** What the panel is showing right now, refreshed with every new frame. */
function LiveThumb({ s }: { s: Screen }) {
  const f = lastFrame.value[s.id];
  const at = f?.at ?? status.value?.screens.find((x) => x.id === s.id)?.lastFrameAt ?? null;
  return (
    <div class="live-thumb" style={{ aspectRatio: `${s.width} / ${s.height}`, maxWidth: s.width >= s.height ? '100%' : '320px' }}>
      {at ? <img src={api.liveFrameUrl(s.id, at)} alt="" /> : <div class="panel-loading" />}
      {f?.interlude && <span class="live-badge"><Icon name="clapperboard" size={13} /> {tr('stage.interlude')}</span>}
      {f?.sleeping && <span class="live-badge"><Icon name="moon" size={13} /> {tr('stage.sleeping')}</span>}
    </div>
  );
}
