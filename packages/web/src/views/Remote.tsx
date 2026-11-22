/**
 * Kiosko remote screens in the editor (docs/remote-screen.md): pairing with
 * the code the screen shows, and a paired screen's link (with its chip's
 * temperature), brightness, address, firmware update, log and unpairing. The pairing key never reaches these controls:
 * the server writes it into the config.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DeviceConfig, Screen } from '@kiosko/core/model';
import { api, type RemoteFound, type RemoteLink } from '../api.ts';
import { ApiError } from '../errors.ts';
import { Icon } from '../icons.tsx';
import { clock, errorText, remoteGuideUrl, t, tr } from '../i18n.ts';
import { followServerConfig, notify } from '../store.ts';

type RemoteDevice = Extract<DeviceConfig, { driver: 'remote' }>;

/**
 * Pairs a remote screen: asks it for a code (it shows one), takes the code
 * typed here. `screenId`: the screen the key goes to; none: a new screen.
 */
export function PairBox({ uid, name, host, screenId, onDone, onCancel }: { uid: string; name: string; host?: string; screenId?: string; onDone: (screenId: string) => void; onCancel: () => void }) {
  const [pairId, setPairId] = useState<string | null>(null);
  const [ttl, setTtl] = useState(0);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  const live = useRef<string | null>(null);
  const start = async () => {
    setBusy(true);
    setError(null);
    setCode('');
    try {
      const r = await api.pairStart(uid, host);
      live.current = r.pairId;
      setPairId(r.pairId);
      setTtl(r.ttl);
      setTimeout(() => input.current?.focus(), 0);
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'remote.pairingClosed' ? tr('remote.pairWindow') : errorText(err));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void start();
    // Closing the box gives the pairing up (the screen stops showing its code).
    return () => void (live.current && api.pairCancel(live.current).catch(() => undefined));
  }, []);
  useEffect(() => {
    if (!pairId || ttl <= 0) return;
    const id = setInterval(() => setTtl((x) => Math.max(0, x - 1)), 1000);
    return () => clearInterval(id);
  }, [pairId]);
  const finish = async () => {
    if (!pairId) return;
    setBusy(true);
    setError(null);
    const id = pairId;
    live.current = null;
    setPairId(null);
    try {
      const r = await api.pairFinish(id, code, screenId);
      notify(t('remote.pairedOk', { id: name }), 'ok');
      await followServerConfig().catch(() => undefined);
      onDone(r.screenId);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="pair-box" role="group" aria-label={t('remote.pairTitle', { id: name })}>
      <div class="pair-title">
        <Icon name="wifi" size={15} /> <b>{t('remote.pairTitle', { id: name })}</b>
      </div>
      {pairId && <p class="muted small">{t('remote.pairHint', { s: ttl })}</p>}
      {pairId && (
        <form class="row" onSubmit={(e) => (e.preventDefault(), void finish())}>
          <input ref={input} class="input mono pair-code" inputMode="numeric" autocomplete="one-time-code" maxLength={7} placeholder="000 000" value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value.replace(/[^\d ]/g, ''))} aria-label={tr('remote.code')} />
          <button class="btn primary small" disabled={busy || code.replace(/\D/g, '').length !== 6}>
            {tr('remote.pair')}
          </button>
        </form>
      )}
      {error && (
        <p class="small wiz-warn" role="alert">
          <Icon name="triangle-alert" size={13} /> {error} <a href={remoteGuideUrl()} target="_blank" rel="noreferrer">{tr('remote.guide')}</a>
        </p>
      )}
      <div class="row">
        {!pairId && !busy && (
          <button class="btn ghost small" onClick={() => void start()}>
            <Icon name="refresh-cw" size={13} /> {tr('remote.retry')}
          </button>
        )}
        <button class="btn ghost small" onClick={onCancel}>
          {tr('remote.cancel')}
        </button>
      </div>
    </div>
  );
}

/** A remote screen found on the LAN, in "Detect panels". */
export function RemoteFoundItem({ f, used, onPaired }: { f: RemoteFound; used?: Screen; onPaired: (screenId: string) => void }) {
  const [pairing, setPairing] = useState(false);
  const paired = used?.device.driver === 'remote' && !!used.device.key;
  return (
    <div class="remote-found">
      <button class="menu-item" disabled={paired} title={`${f.model} · ${f.address}`} onClick={() => setPairing(true)}>
        <Icon name="wifi" size={16} /> <span>{f.id}</span>
        <small>
          {f.width}×{f.height} · {paired ? t('remote.inUse', { name: used!.name }) : f.paired ? tr('remote.pairedElsewhere') : tr('remote.pair')}
        </small>
      </button>
      {pairing && <PairBox uid={f.uid} name={f.id} {...(used ? { screenId: used.id } : {})} onCancel={() => setPairing(false)} onDone={(id) => (setPairing(false), onPaired(id))} />}
    </div>
  );
}

/** A remote screen's part of its card: the link, its address, pairing, firmware, log. */
export function RemoteSettings({ s, link, setDevice }: { s: Screen; link?: RemoteLink; setDevice: (d: DeviceConfig) => void }) {
  const dev = s.device as RemoteDevice;
  const [pairing, setPairing] = useState(false);
  const [logs, setLogs] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  // The slider's value while it is dragged: the config (and the screen) change on release.
  const [dragging, setDragging] = useState<number | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const paired = !!dev.key;
  const name = link?.id || dev.id || dev.uid;
  const unpair = async () => {
    if (!confirm(t('remote.unpairConfirm', { id: name }))) return;
    try {
      await api.unpairRemote(s.id);
    } catch (err) {
      notify(errorText(err), 'error');
    }
  };
  const update = async (f: File) => {
    setUpdating(true);
    notify(tr('remote.updating'), 'info');
    try {
      await api.remoteOta(s.id, f);
      notify(tr('remote.updated'), 'ok');
    } catch (err) {
      notify(errorText(err), 'error');
    } finally {
      setUpdating(false);
    }
  };
  return (
    <div class="sub-form remote-form">
      <div class="muted small">
        <b>{name}</b> · uid <span class="mono">{dev.uid}</span>
        {link?.model ? ` · ${t('remote.info', { model: link.model, fw: link.fw, host: link.host ?? '—' })}` : ''}
      </div>
      {link?.online && (
        <div class="muted small" role="status">
          {t('remote.status', { fps: link.fps, rtt: link.rttMs ?? '—', dec: link.decodeMs ?? '—' })}
          {typeof link.tempC === 'number' ? ` · ${t('remote.temp', { t: Math.round(link.tempC) })}` : ''}
          {link.lastFrameAt ? ` · ${clock(link.lastFrameAt, { seconds: true })}` : ''}
        </div>
      )}
      <p class="muted small">{tr('remote.rotateHelp')}</p>
      {typeof link?.bright === 'number' || dev.brightness !== undefined ? (
        <>
          <label class="field-label">{tr('remote.brightness')}</label>
          <div class="slider-row">
            <input type="range" min={0} max={100} step={5} value={dragging ?? dev.brightness ?? link?.bright ?? 70} aria-label={tr('remote.brightness')}
              onInput={(e) => setDragging(Number((e.target as HTMLInputElement).value))}
              onChange={(e) => {
                setDragging(null);
                setDevice({ ...dev, brightness: Number((e.target as HTMLInputElement).value) });
              }} />
            <span class="slider-value">{t('remote.brightnessValue', { v: dragging ?? dev.brightness ?? link?.bright ?? 70 })}</span>
          </div>
          <span class="muted small">{tr('remote.brightnessHelp')}</span>
        </>
      ) : (
        link?.online && <p class="muted small">{tr('remote.brightnessOld')}</p>
      )}
      <label class="field-label">{tr('remote.host')}</label>
      <input class="input mono" value={dev.host ?? ''} placeholder={link?.host ?? 'kiosko-…local'} onChange={(e) => {
        const host = (e.target as HTMLInputElement).value.trim();
        const { host: _h, ...rest } = dev;
        setDevice(host ? { ...rest, host } : rest);
      }} />
      <span class="muted small">{tr('remote.hostHelp')}</span>
      <div class="row wrap">
        <button class={`btn small ${paired ? 'ghost' : 'primary'}`} onClick={() => setPairing(true)} disabled={pairing}>
          <Icon name="link" size={13} /> {paired ? tr('remote.pairAgain') : tr('remote.pair')}
        </button>
        {paired && (
          <button class="btn ghost small" onClick={() => void unpair()}>
            <Icon name="unlink" size={13} /> {tr('remote.unpair')}
          </button>
        )}
        {paired && (
          <button class="btn ghost small" disabled={updating || !link?.online} onClick={() => file.current?.click()}>
            <Icon name={updating ? 'loader' : 'cpu'} size={13} class={updating ? 'spin' : ''} /> {tr('remote.firmware')}
          </button>
        )}
        {paired && (
          <button class="btn ghost small" disabled={!link?.online} onClick={async () => {
            try {
              setLogs((await api.remoteLogs(s.id)).text);
            } catch (err) {
              notify(errorText(err), 'error');
            }
          }}>
            <Icon name="scroll-text" size={13} /> {tr('remote.logs')}
          </button>
        )}
        <a class="btn ghost small" href={remoteGuideUrl()} target="_blank" rel="noreferrer">
          <Icon name="book-open" size={13} /> {tr('remote.guide')}
        </a>
        <input ref={file} type="file" accept=".bin" hidden onChange={(e) => {
          const f = (e.target as HTMLInputElement).files?.[0];
          (e.target as HTMLInputElement).value = '';
          if (f) void update(f);
        }} />
      </div>
      {pairing && <PairBox uid={dev.uid} name={name} {...(dev.host ? { host: dev.host } : {})} screenId={s.id} onCancel={() => setPairing(false)} onDone={() => setPairing(false)} />}
      {logs !== null && (
        <details open class="remote-logs">
          <summary>{tr('remote.logs')}</summary>
          <pre class="mono small">{logs}</pre>
        </details>
      )}
    </div>
  );
}
