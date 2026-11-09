/**
 * Browser demo only: the banner, and the stand-ins for what needs a
 * server (thumbnails painted on request, live frames, disabled actions
 * with a word of why). Components use these only under `KIOSKO_DEMO`, so
 * the normal build drops this module; keep its top level free of side
 * effects.
 */
import type { Screen } from '@kiosko/core/model';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api.ts';
import { Icon } from '../icons.tsx';
import { locale } from '../store.ts';
import { exportScreen, resetDemo, thumbnail } from './transport.ts';

const README = 'https://github.com/kiosko-lcd/kiosko#readme';
const REPO = 'https://github.com/kiosko-lcd/kiosko';

const TEXTS = {
  en: {
    kicker: 'Demo',
    banner: 'The Kiosko editor, running in your browser with sample data. Your changes stay in this browser.',
    install: 'Install Kiosko',
    reset: 'Reset demo',
    resetConfirm: 'Forget your changes and start again from the sample screens?',
    live: 'The live panel shows what a real panel is showing: it needs Kiosko running on the computer the panel is plugged into.',
    discover: 'Detecting panels needs Kiosko running on the computer the panel is plugged into.',
    installHint: 'Installing plugins needs Kiosko running on your computer. Every official plugin is already in this demo.',
    sources: 'In this demo, data sources read nothing: every widget shows sample data. These settings are kept but not used.',
    interlude: 'Interludes play on a real panel.',
    refresh: 'Widgets show sample data in this demo.',
    bootError: 'The demo could not start in this browser',
  },
  es: {
    kicker: 'Demo',
    banner: 'El editor de Kiosko, funcionando en tu navegador con datos de muestra. Tus cambios se quedan en este navegador.',
    install: 'Instalar Kiosko',
    reset: 'Restablecer la demo',
    resetConfirm: '¿Olvidar tus cambios y volver a empezar con las pantallas de muestra?',
    live: 'El panel en vivo enseña lo que muestra un panel de verdad: necesita Kiosko en el ordenador donde está enchufado el panel.',
    discover: 'Detectar paneles necesita Kiosko en el ordenador donde está enchufado el panel.',
    installHint: 'Instalar plugins necesita Kiosko en tu ordenador. Todos los plugins oficiales ya están en esta demo.',
    sources: 'En esta demo las fuentes de datos no leen nada: cada widget muestra datos de muestra. Estos ajustes se guardan pero no se usan.',
    interlude: 'Los interludios se reproducen en un panel de verdad.',
    refresh: 'En esta demo los widgets muestran datos de muestra.',
    bootError: 'La demo no ha podido arrancar en este navegador',
  },
};

export type DemoKey = keyof (typeof TEXTS)['en'];

/** Demo texts in the editor's language. */
export function dt(key: DemoKey): string {
  return (locale.value.toLowerCase().startsWith('es') ? TEXTS.es : TEXTS.en)[key];
}

export function DemoBanner() {
  return (
    <div class="demo-banner" role="note">
      <span class="demo-kicker">
        <Icon name="flask-conical" size={13} /> {dt('kicker')}
      </span>
      <span class="demo-text">{dt('banner')}</span>
      <span class="demo-links">
        <a href={README} target="_blank" rel="noreferrer">
          <Icon name="download" size={13} /> {dt('install')}
        </a>
        <a href={REPO} target="_blank" rel="noreferrer">
          <Icon name="code-xml" size={13} /> GitHub
        </a>
        <button class="link-btn demo-reset" onClick={() => confirm(dt('resetConfirm')) && resetDemo()}>
          <Icon name="rotate-ccw" size={13} /> {dt('reset')}
        </button>
      </span>
    </div>
  );
}

/** A note under something the demo can't do. */
export function DemoNote({ k }: { k: DemoKey }) {
  return (
    <p class="demo-note muted small">
      <Icon name="info" size={13} /> {dt(k)}
    </p>
  );
}

/** Library thumbnail: painted by the in-browser runtime when it scrolls into view. */
export function DemoThumb({ type, w, h, look }: { type: string; w: number; h: number; look: { theme?: string; locale?: string } }) {
  const ref = useRef<HTMLImageElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let alive = true;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        thumbnail(type, w, h, look)
          .then((url) => alive && setSrc(url))
          .catch(() => undefined);
      },
      // Relative to the library's own scroller, so the margin preloads the next few.
      { root: el.closest('.lib-list'), rootMargin: '300px' },
    );
    io.observe(el);
    return () => {
      alive = false;
      io.disconnect();
    };
  }, [type, w, h, look.theme, look.locale]);
  return <img ref={ref} src={src ?? undefined} alt="" draggable={false} />;
}

/**
 * What the panel would show now (Screens view): the page the rotation is
 * on, painted like the editor's preview. Repainted on every frame tick.
 */
export function DemoFrame({ screen, pageId, at }: { screen: Screen; pageId: string | null | undefined; at: number | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const page = screen.pages.find((p) => p.id === pageId) ?? screen.pages[0];
  const key = JSON.stringify([screen.width, screen.height, page, at]);
  useEffect(() => {
    if (!page) return;
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const r = await api.preview(screen, page.id);
        if (!alive) return URL.revokeObjectURL(r.url);
        setUrl((old) => {
          if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
          return r.url;
        });
      } catch {
        /* the next tick retries */
      }
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [key]);
  return url ? <img src={url} alt="" /> : <div class="panel-loading" />;
}

/** The Live/Editing switch, off: there's no panel to watch. */
export function DemoLiveOff({ label }: { label: string }) {
  return (
    <button class="btn small ghost" disabled title={dt('live')} aria-disabled="true">
      <span class="dot" /> {label}
    </button>
  );
}

export { exportScreen };

/** The boot error, in the demo's words. */
export function demoBootError(err: unknown): string {
  const msg = String(err instanceof Error ? err.message : err).replace(/[<>&]/g, '');
  return `<div class="boot-error"><h1>Kiosko</h1><p>${dt('bootError')}: ${msg}</p><p><a href="${README}">${dt('install')}</a></p></div>`;
}
