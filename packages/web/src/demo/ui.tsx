/**
 * Browser demo only: the banner, and the stand-ins for what needs a
 * server (thumbnails painted on request, live frames, disabled actions
 * with a word of why). Components use these only under `KIOSKO_DEMO`, so
 * the normal build drops this module; keep its top level free of side
 * effects.
 */
import { pickLocale } from '@kiosko/sdk/i18n';
import { TEXTS, type DemoKey } from './texts.ts';

export type { DemoKey };
import type { Screen } from '@kiosko/core/model';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api.ts';
import { Icon } from '../icons.tsx';
import { locale } from '../store.ts';
import { exportScreen, resetDemo, thumbnail } from './transport.ts';

const README = 'https://github.com/kiosko-lcd/kiosko#readme';
const REPO = 'https://github.com/kiosko-lcd/kiosko';



/** Demo texts in the editor's language. */
export function dt(key: DemoKey): string {
  const lang = pickLocale(Object.keys(TEXTS), locale.value) as keyof typeof TEXTS | undefined;
  return (lang ? TEXTS[lang] : TEXTS.en)[key] ?? TEXTS.en[key];
}

export function DemoBanner() {
  return (
    <div class="demo-banner" role="note">
      <span class="demo-kicker">
        <Icon name="flask-conical" size={13} /> {dt('kicker')}
      </span>
      <span class="demo-text">{dt('banner')}</span>
      <span class="demo-links">
        {/* The layout being edited here, on a panel in 3D (panel3d/, built next to the demo). */}
        <a href="./3d/?mine=1" target="_blank" rel="noreferrer">
          <Icon name="box" size={13} /> {dt('in3d')}
        </a>
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
