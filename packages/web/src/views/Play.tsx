/**
 * Play: an interlude that takes buttons (`input: true`, kiosko-plugin-doom)
 * played on a panel from here. The keyboard, a game controller (Gamepad API)
 * or, on a phone, the pad on screen; only changes are sent, grouped while a
 * request is on its way. The panel's picture is shown live beside it.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api } from '../api.ts';
import { Icon } from '../icons.tsx';
import { tr } from '../i18n.ts';
import { app, config, status, toast } from '../store.ts';

type Key = 'up' | 'down' | 'left' | 'right' | 'a' | 'b' | 'x' | 'y' | 'l' | 'r' | 'start' | 'select';

/** The keyboard, as a game is played: arrows or WASD, fire, use, run. */
export const KEYBOARD: Record<string, Key> = {
  ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  KeyA: 'l', KeyD: 'r', KeyQ: 'l', KeyE: 'b',
  Space: 'a', ControlLeft: 'a', ControlRight: 'a', KeyJ: 'a', KeyF: 'b', KeyK: 'b',
  ShiftLeft: 'y', ShiftRight: 'y', KeyX: 'x', Enter: 'x', Escape: 'start', Tab: 'select', KeyM: 'select',
};

/** A controller in the standard mapping: its buttons, and the left stick as the arrows. */
const PAD_BUTTONS: [number, Key][] = [[0, 'a'], [1, 'b'], [2, 'x'], [3, 'y'], [4, 'l'], [5, 'r'], [8, 'select'], [9, 'start'], [12, 'up'], [13, 'down'], [14, 'left'], [15, 'right']];

/** What the gamepads hold down now. */
function gamepadKeys(): Set<Key> {
  const down = new Set<Key>();
  for (const gp of navigator.getGamepads?.() ?? []) {
    if (!gp) continue;
    for (const [i, k] of PAD_BUTTONS) if (gp.buttons[i]?.pressed) down.add(k);
    const [x = 0, y = 0] = gp.axes;
    if (x < -0.5) down.add('left');
    if (x > 0.5) down.add('right');
    if (y < -0.5) down.add('up');
    if (y > 0.5) down.add('down');
  }
  return down;
}

/** Sends button changes for a screen: at once, or together with others while one request is out. */
function sender(screenId: () => string | null) {
  let queue: { key: string; pressed: boolean }[] = [];
  let out = false;
  const flush = () => {
    const id = screenId();
    if (out || !queue.length || !id) return;
    const events = queue;
    queue = [];
    out = true;
    api.press(id, events)
      .catch(() => undefined)
      .finally(() => {
        out = false;
        flush();
      });
  };
  return (key: Key, pressed: boolean) => {
    queue.push({ key, pressed });
    flush();
  };
}

export function Play() {
  const cfg = config.value!;
  const playable = useMemo(() => new Set((app.value?.catalog ?? []).flatMap((p) => (p.enabled ? p.interludes.filter((i) => i.input).map((i) => i.type) : []))), [app.value]);
  const choices = cfg.screens.flatMap((s) => s.interludes.filter((i) => playable.has(i.type)).map((slot) => ({ screen: s, slot })));
  const [pick, setPick] = useState(0);
  const chosen = choices[Math.min(pick, choices.length - 1)];
  const screenId = chosen?.screen.id ?? null;
  const st = status.value?.screens.find((s) => s.id === screenId);
  const playing = !!st?.playing;
  const idRef = useRef(screenId);
  idRef.current = screenId;
  const send = useMemo(() => sender(() => idRef.current), []);
  const held = useRef(new Set<Key>());
  const press = (k: Key, down: boolean) => {
    if (held.current.has(k) === down) return;
    if (down) held.current.add(k);
    else held.current.delete(k);
    send(k, down);
  };

  // The keyboard, while this page is on screen (not while typing in a field).
  useEffect(() => {
    const on = (down: boolean) => (e: KeyboardEvent) => {
      const k = KEYBOARD[e.code];
      if (!k || (e.target as HTMLElement)?.closest?.('input, select, textarea')) return;
      e.preventDefault();
      press(k, down);
    };
    const kd = on(true), ku = on(false);
    // Leaving the window lets go of everything: no key stays held in the game.
    const blur = () => [...held.current].forEach((k) => press(k, false));
    addEventListener('keydown', kd);
    addEventListener('keyup', ku);
    addEventListener('blur', blur);
    return () => {
      removeEventListener('keydown', kd);
      removeEventListener('keyup', ku);
      removeEventListener('blur', blur);
      blur();
    };
  }, []);

  // Game controllers: polled every frame, changes only.
  const [pads, setPads] = useState(0);
  useEffect(() => {
    let raf = 0;
    let prev = new Set<Key>();
    const poll = () => {
      const now = gamepadKeys();
      for (const k of now) if (!prev.has(k)) press(k, true);
      for (const k of prev) if (!now.has(k)) press(k, false);
      prev = now;
      raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);
    const count = () => setPads((navigator.getGamepads?.() ?? []).filter(Boolean).length);
    addEventListener('gamepadconnected', count);
    addEventListener('gamepaddisconnected', count);
    count();
    return () => {
      cancelAnimationFrame(raf);
      removeEventListener('gamepadconnected', count);
      removeEventListener('gamepaddisconnected', count);
    };
  }, []);

  // The panel's picture: often while playing, now and then otherwise.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), playing ? 120 : 2000);
    return () => clearInterval(t);
  }, [playing]);

  const start = () => chosen && api.playInterlude(chosen.screen.id, chosen.slot.id, true).catch((e: Error) => (toast.value = { kind: 'error', text: e.message, at: Date.now() }));
  const stop = () => chosen && api.stopInterlude(chosen.screen.id).catch(() => undefined);

  const btn = (k: Key, label: string, cls = '') => (
    <button
      type="button"
      class={`pad-btn ${cls}`}
      aria-label={label}
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        press(k, true);
      }}
      onPointerUp={() => press(k, false)}
      onPointerCancel={() => press(k, false)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {label}
    </button>
  );

  return (
    <div class="page-view play">
      {/* A page like the others: its title and what it is for, then what to do. */}
      <header class="view-head">
        <div>
          <h1>{tr('play.title')}</h1>
          <p class="muted">{tr('play.hint')}</p>
        </div>
      </header>
      <section class="card">
        {KIOSKO_DEMO ? (
          <p class="muted">{tr('play.demo')}</p>
        ) : !playable.size ? (
          <p class="muted">{tr('play.none')}</p>
        ) : !choices.length ? (
          <p class="muted">{tr('play.noSlot')}</p>
        ) : (
          <>
            <div class="row play-row">
              <select class="input" value={String(pick)} onChange={(e) => setPick(Number((e.target as HTMLSelectElement).value))} aria-label={tr('play.what')} disabled={playing}>
                {choices.map((c, i) => (
                  <option value={String(i)}>
                    {c.screen.name} · {(app.value?.catalog ?? []).flatMap((p) => p.interludes).find((d) => d.type === c.slot.type)?.name ?? c.slot.type}
                  </option>
                ))}
              </select>
              {playing ? (
                <button class="btn" onClick={stop}>
                  <Icon name="square" size={14} /> {tr('play.stop')}
                </button>
              ) : (
                <button class="btn primary" onClick={start}>
                  <Icon name="play" size={14} /> {tr('play.start')}
                </button>
              )}
            </div>
            {screenId && (
              <img class="play-screen" src={`/api/screens/${encodeURIComponent(screenId)}/frame.jpg?t=${tick}`} alt="" style={{ aspectRatio: `${chosen!.screen.width} / ${chosen!.screen.height}` }} />
            )}
            <p class="muted small">{playing ? tr('play.playing') : tr('play.idle')}</p>
          </>
        )}
      </section>
      {!KIOSKO_DEMO && choices.length > 0 && (
        <section class="card pad" aria-label={tr('play.pad')}>
          <div class="pad-dir">
            {btn('up', '▲', 'up')}
            {btn('left', '◀', 'left')}
            {btn('right', '▶', 'right')}
            {btn('down', '▼', 'down')}
          </div>
          <div class="pad-mid">
            {btn('select', tr('play.select'), 'small')}
            {btn('start', tr('play.menu'), 'small')}
            {btn('l', 'L', 'small')}
            {btn('r', 'R', 'small')}
          </div>
          <div class="pad-act">
            {btn('y', 'Y', 'y')}
            {btn('x', 'X', 'x')}
            {btn('b', 'B', 'b')}
            {btn('a', 'A', 'a')}
          </div>
          <p class="muted small pad-keys">
            {tr('play.keys')}
            {pads > 0 && <> · <Icon name="gamepad-2" size={12} /> {pads}</>}
          </p>
        </section>
      )}
    </div>
  );
}
