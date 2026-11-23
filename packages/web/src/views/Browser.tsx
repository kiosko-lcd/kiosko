/**
 * Browser screens in the editor (docs/browser-screens.md): the network-screens
 * server (on/off, port, where it listens, what it exposes), pairing a browser
 * with the code it shows, and a paired one's card. The pairing key never
 * reaches these controls: the server writes it into the config.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { DEFAULT_NETWORK_SCREENS, type DeviceConfig, type Screen } from '@kiosko/core/model';
import { api, type BrowserLink, type BrowserState } from '../api.ts';
import { Toggle } from '../forms/SchemaForm.tsx';
import { Icon } from '../icons.tsx';
import { browserGuideUrl, clock, errorText, t, tr } from '../i18n.ts';
import { config, edit, followServerConfig, notify } from '../store.ts';
import { qrcodegen } from '../vendor/qrcodegen.ts';

type BrowserDevice = Extract<DeviceConfig, { driver: 'browser' }>;

/** A QR code of `text`, as SVG (one path; a quiet zone of 4 modules). */
export function QrCode({ text, size = 148 }: { text: string; size?: number }) {
  const qr = useMemo(() => qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM), [text]);
  const n = qr.size + 8;
  let d = '';
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) d += `M${x + 4} ${y + 4}h1v1h-1z`;
  return (
    <svg class="qr" width={size} height={size} viewBox={`0 0 ${n} ${n}`} shape-rendering="crispEdges" role="img" aria-label={text}>
      <rect width={n} height={n} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

/** The network-screens server's state, asked again every `ms` while shown. */
export function useBrowserState(ms = 1500): [BrowserState | null, () => void] {
  const [st, setSt] = useState<BrowserState | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    const ask = () => api.browserState().then((x) => live && setSt(x)).catch(() => undefined);
    void ask();
    const id = setInterval(ask, ms);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [ms, tick]);
  return [st, () => setTick((x) => x + 1)];
}

/** Where a browser opens the viewer: the address(es), and a QR code of the first. */
function Addresses({ st, qr = true }: { st: BrowserState; qr?: boolean }) {
  if (!st.urls.length) return null;
  return (
    <div class="browser-urls">
      {qr && <QrCode text={st.urls[0]!} />}
      <div>
        <p class="muted small">{st.host === '127.0.0.1' || st.host === 'localhost' ? tr('browser.openCable') : tr('browser.open')}</p>
        {st.urls.map((u) => (
          <div class="mono browser-url">
            <a href={u} target="_blank" rel="noreferrer">
              {u}
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}

const HOSTS = ['0.0.0.0', '127.0.0.1'];

/** The network-screens server: on/off, where it listens, what that exposes. */
export function NetworkScreensCard() {
  const net = config.value?.networkScreens ?? DEFAULT_NETWORK_SCREENS;
  const [st] = useBrowserState(3000);
  const set = (patch: Partial<typeof net>) => edit((d) => void (d.networkScreens = { ...DEFAULT_NETWORK_SCREENS, ...d.networkScreens, ...patch }));
  // "One address": typed below; picking it keeps the current one until something is typed.
  const [one, setOne] = useState(!HOSTS.includes(net.host));
  const custom = one || !HOSTS.includes(net.host);
  return (
    <section class="card net-screens">
      <div class="card-head">
        <Icon name="tablet-smartphone" size={18} />
        <b>{tr('browser.server')}</b>
        <div class="tb-spacer" />
        <span class={`status-pill ${st?.listening ? 'ok' : net.enabled ? 'bad' : ''}`}>
          <span class="dot" /> {st?.listening ? t('browser.listening', { port: String(st.port) }) : st?.error ? t('browser.serverError', { error: st.error }) : tr(net.enabled ? 'browser.starting' : 'browser.off')}
        </span>
        <Toggle checked={net.enabled} onChange={(v) => set({ enabled: v })} />
      </div>
      <p class="muted small">{tr('browser.serverHelp')}</p>
      <div class="grid-2">
        <div>
          <label class="field-label">{tr('browser.host')}</label>
          <select class="input" value={custom ? 'custom' : net.host} onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            setOne(v === 'custom');
            if (v !== 'custom') set({ host: v });
          }}>
            <option value="0.0.0.0">{tr('browser.hostAll')}</option>
            <option value="127.0.0.1">{tr('browser.hostLocal')}</option>
            <option value="custom">{tr('browser.hostOne')}</option>
          </select>
          {custom && <input class="input mono" value={HOSTS.includes(net.host) ? '' : net.host} placeholder="192.168.1.10" onChange={(e) => set({ host: (e.target as HTMLInputElement).value.trim() || DEFAULT_NETWORK_SCREENS.host })} aria-label={tr('browser.hostOne')} />}
          <label class="field-label">{tr('browser.port')}</label>
          <input class="input num" type="number" min={1} max={65535} value={net.port} onChange={(e) => {
            const p = Math.round(Number((e.target as HTMLInputElement).value));
            if (p >= 1 && p <= 65535 && p !== config.value?.server.port) set({ port: p });
          }} aria-label={tr('browser.port')} />
        </div>
        <div>
          <p class="small exposure">
            <Icon name="shield-check" size={14} /> {tr('browser.exposes')}
          </p>
          <p class="muted small">{net.host === '127.0.0.1' ? t('browser.cableHelp', { port: net.port }) : tr('browser.lanHelp')}</p>
        </div>
      </div>
      {st?.listening && <Addresses st={st} />}
      <a class="btn ghost small" href={browserGuideUrl()} target="_blank" rel="noreferrer">
        <Icon name="book-open" size={13} /> {tr('browser.guide')}
      </a>
    </section>
  );
}

/**
 * Pairs a browser: it shows a 6-digit code; pick it in the list (it is usually the only one)
 * and type its code. `screenId`: the screen the key goes to; none: a new screen.
 */
export function BrowserPairBox({ screenId, onDone, onCancel }: { screenId?: string; onDone: (screenId: string) => void; onCancel: () => void }) {
  const [st] = useBrowserState(1200);
  const [pick, setPick] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const enabled = config.value?.networkScreens?.enabled === true;
  const waiting = st?.waiting ?? [];
  const chosen = waiting.find((w) => w.uid === pick) ?? (waiting.length === 1 ? waiting[0] : undefined);
  useEffect(() => {
    if (chosen) input.current?.focus();
  }, [chosen?.uid]);
  const finish = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.browserPair(chosen.uid, code, screenId);
      notify(t('browser.pairedOk', { id: chosen.id }), 'ok');
      await followServerConfig().catch(() => undefined);
      onDone(r.screenId);
    } catch (err) {
      setError(errorText(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="pair-box browser-pair" role="group" aria-label={tr('browser.pairTitle')}>
      <div class="pair-title">
        <Icon name="tablet-smartphone" size={15} /> <b>{tr('browser.pairTitle')}</b>
      </div>
      {!enabled ? (
        <>
          <p class="muted small">{tr('browser.offHelp')}</p>
          <p class="small exposure">
            <Icon name="shield-check" size={14} /> {tr('browser.exposes')}
          </p>
          <button class="btn primary small" onClick={() => edit((d) => void (d.networkScreens = { ...DEFAULT_NETWORK_SCREENS, ...d.networkScreens, enabled: true }))}>
            <Icon name="power" size={13} /> {tr('browser.turnOn')}
          </button>
        </>
      ) : !st?.listening ? (
        <p class="muted small" role="status">
          {st?.error ? t('browser.serverError', { error: st.error }) : tr('browser.starting')}
        </p>
      ) : (
        <>
          <Addresses st={st} />
          {!waiting.length ? (
            <p class="muted small" role="status">
              <Icon name="loader" size={13} class="spin" /> {tr('browser.noneWaiting')}
            </p>
          ) : (
            <>
              <p class="muted small">{tr('browser.pairHint')}</p>
              <div class="browser-waiting" role="radiogroup" aria-label={tr('browser.waiting')}>
                {waiting.map((w) => (
                  <button role="radio" aria-checked={chosen?.uid === w.uid} class={`menu-item ${chosen?.uid === w.uid ? 'on' : ''}`} onClick={() => setPick(w.uid)}>
                    <Icon name={w.h > w.w ? 'smartphone' : 'tablet'} size={18} />
                    <span class="bw-text">
                      <span>
                        {w.id} · <b class="mono">{w.uid.slice(-4).toUpperCase()}</b>
                      </span>
                      <small>
                        {w.w}×{w.h} · {w.address}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
              <form class="row" onSubmit={(e) => (e.preventDefault(), void finish())}>
                <input ref={input} class="input mono pair-code" inputMode="numeric" autocomplete="one-time-code" maxLength={7} placeholder="000 000" value={code} onInput={(e) => (setError(null), setCode((e.target as HTMLInputElement).value.replace(/[^\d ]/g, '')))} aria-label={tr('browser.code')} />
                <button class="btn primary small" disabled={busy || !chosen || code.replace(/\D/g, '').length !== 6 || (st.waitSeconds ?? 0) > 0}>
                  {tr('remote.pair')}
                </button>
              </form>
              {st.waitSeconds > 0 && <p class="muted small">{t('err.browser.wait', { s: st.waitSeconds })}</p>}
            </>
          )}
        </>
      )}
      {error && (
        <p class="small wiz-warn" role="alert">
          <Icon name="triangle-alert" size={13} /> {error}
        </p>
      )}
      <div class="row">
        <button class="btn ghost small" onClick={onCancel}>
          {tr('remote.cancel')}
        </button>
        <a class="btn ghost small" href={browserGuideUrl()} target="_blank" rel="noreferrer">
          <Icon name="book-open" size={13} /> {tr('browser.guide')}
        </a>
      </div>
    </div>
  );
}

/** "Add screen → Browser": the pairing box in the menu. */
export function AddBrowserItem({ onPaired }: { onPaired: (screenId: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div class="remote-found">
      <button class="menu-item" onClick={() => setOpen(!open)}>
        <Icon name="tablet-smartphone" size={16} /> <span>{tr('browser.add')}</span>
        <small>{tr('browser.addHint')}</small>
      </button>
      {open && <BrowserPairBox onCancel={() => setOpen(false)} onDone={(id) => (setOpen(false), onPaired(id))} />}
    </div>
  );
}

/** A browser screen's part of its card: its viewer, following its size, pairing, revoking. */
export function BrowserSettings({ s, link, setDevice }: { s: Screen; link?: BrowserLink; setDevice: (d: DeviceConfig) => void }) {
  const dev = s.device as BrowserDevice;
  const [pairing, setPairing] = useState(false);
  const paired = !!dev.key;
  const name = dev.id || dev.uid;
  const revoke = async () => {
    if (!confirm(t('browser.revokeConfirm', { id: name }))) return;
    try {
      await api.unpairBrowser(s.id);
      notify(t('browser.revoked', { id: name }), 'ok');
    } catch (err) {
      notify(errorText(err), 'error');
    }
  };
  return (
    <div class="sub-form remote-form">
      <div class="muted small">
        <b>{name}</b> · id <span class="mono">{dev.uid.slice(-4).toUpperCase()}</span>
        {link?.online && link.address ? ` · ${link.address} · ${link.w}×${link.h}` : ''}
      </div>
      {link?.online && (
        <div class="muted small" role="status">
          {t('browser.status', { fps: link.fps, rtt: link.rttMs ?? '—', dec: link.decodeMs ?? '—' })}
          {link.lastFrameAt ? ` · ${clock(link.lastFrameAt, { seconds: true })}` : ''}
        </div>
      )}
      {link && !link.server && paired && <p class="small wiz-warn">{tr('device.browserServerOff')}</p>}
      <div class="field field-row">
        <Toggle checked={dev.follow !== false} onChange={(v) => setDevice(v ? (({ follow: _f, ...rest }) => rest)(dev) : { ...dev, follow: false })} />
        <span>{tr('browser.follow')}</span>
      </div>
      <span class="muted small">{tr('browser.followHelp')}</span>
      <div class="row wrap">
        <button class={`btn small ${paired ? 'ghost' : 'primary'}`} onClick={() => setPairing(true)} disabled={pairing}>
          <Icon name="link" size={13} /> {paired ? tr('remote.pairAgain') : tr('remote.pair')}
        </button>
        {paired && (
          <button class="btn ghost small" onClick={() => void revoke()}>
            <Icon name="unlink" size={13} /> {tr('browser.revoke')}
          </button>
        )}
        <a class="btn ghost small" href={browserGuideUrl()} target="_blank" rel="noreferrer">
          <Icon name="book-open" size={13} /> {tr('browser.guide')}
        </a>
      </div>
      {pairing && <BrowserPairBox screenId={s.id} onCancel={() => setPairing(false)} onDone={() => setPairing(false)} />}
    </div>
  );
}
