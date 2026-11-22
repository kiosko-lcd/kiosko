/**
 * What the store's parts (render.ts) do in a browser, the same on the site (landing/store.ts)
 * and in the editor (views/Store.tsx): a thumbnail brings its picture onto the big panel, the
 * pictures switch to another language, the install command is copied, interludes' clips play
 * while they are on screen (never with reduced motion: their still stays), and a picture that
 * cannot be loaded (offline) gives way to the plugin's drawing. Nothing is sent anywhere.
 */

/** Wires the store's parts under `root`; returns what undoes it (the editor re-renders). */
export function wireStore(root: HTMLElement, texts: { copied: string }): () => void {
  const off: (() => void)[] = [];
  const on = <K extends keyof HTMLElementEventMap>(el: EventTarget, type: K, fn: (e: HTMLElementEventMap[K]) => void, capture = false) => {
    el.addEventListener(type, fn as EventListener, capture);
    off.push(() => el.removeEventListener(type, fn as EventListener, capture));
  };

  // A picture that does not come (offline, the site unreachable): the drawing under it shows instead.
  on(root, 'error', (e) => failed(e.target), true);
  // Some may have failed before this ran (the site's pictures load as the page is parsed).
  for (const img of root.querySelectorAll<HTMLImageElement>('img')) if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) failed(img);

  on(root, 'click', (e) => {
    const t = e.target as HTMLElement;
    // A thumbnail brings its picture onto the big panel.
    const thumb = t.closest<HTMLButtonElement>('.ks-thumbs button[data-shot]');
    if (thumb) {
      const box = thumb.closest('.ks-shots') ?? root;
      for (const x of box.querySelectorAll('.ks-thumbs button[data-shot]')) x.setAttribute('aria-pressed', String(x === thumb));
      for (const f of box.querySelectorAll<HTMLElement>('.ks-stage-panel figure')) {
        const shown = f.id === `shot-${thumb.dataset.shot}`;
        f.classList.toggle('on', shown);
        const v = f.querySelector('video');
        if (v && !shown) v.pause();
      }
      watchClips();
      return;
    }
    // The install command, copied.
    const copy = t.closest<HTMLButtonElement>('button.ks-copy[data-copy]');
    if (copy) void copyCommand(copy, texts.copied);
  });

  // Its pictures in another language.
  on(root, 'change', (e) => {
    const pick = e.target as HTMLSelectElement;
    if (!pick.matches('select.ks-shot-lang')) return;
    for (const img of root.querySelectorAll<HTMLImageElement>('img[data-shots]')) {
      const shots = JSON.parse(img.dataset.shots ?? '{}') as Record<string, string>;
      img.src = shots[pick.value] ?? shots.en ?? img.src;
    }
  });

  // Interludes' clips: played while on screen, paused when not, never with reduced motion (the still stays).
  let seen: IntersectionObserver | null = null;
  const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  function watchClips(): void {
    if (still || !('IntersectionObserver' in window)) return;
    seen ??= new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const v = e.target as HTMLVideoElement;
          if (e.isIntersecting && v.closest('figure')?.classList.contains('on') !== false) void v.play().catch(() => undefined);
          else v.pause();
        }
      },
      { threshold: 0.4 },
    );
    for (const v of root.querySelectorAll<HTMLVideoElement>('video.ks-clip')) {
      seen.unobserve(v);
      seen.observe(v);
    }
  }
  watchClips();
  off.push(() => seen?.disconnect());
  return () => {
    for (const f of off) f();
  };
}

/** A picture that failed: its screen shows the plugin's drawing; a thumbnail, its dark glass; the gallery, nothing if none came. */
function failed(target: EventTarget | null): void {
  const img = target instanceof HTMLImageElement ? target : target instanceof HTMLVideoElement ? target : null;
  if (!img) return;
  const holder = img.closest('.ks-bezel, .ks-thumb, .ks-glass');
  holder?.classList.add('ks-failed');
  // A panel of pictures none of which came says nothing: it goes.
  const shots = img.closest<HTMLElement>('.ks-shots');
  if (shots && [...shots.querySelectorAll('.ks-glass')].every((g) => g.classList.contains('ks-failed'))) shots.hidden = true;
}

async function copyCommand(b: HTMLButtonElement, copied: string): Promise<void> {
  const label = b.querySelector('span');
  const idle = b.dataset.idle ?? label?.textContent ?? '';
  b.dataset.idle = idle;
  try {
    await navigator.clipboard.writeText(b.dataset.copy ?? '');
  } catch {
    // No clipboard (an old browser, a page not served over HTTPS): select the command instead.
    const code = b.parentElement?.querySelector('code');
    if (code) getSelection()?.selectAllChildren(code);
    return;
  }
  b.classList.add('done');
  if (label) label.textContent = copied || idle;
  setTimeout(() => {
    b.classList.remove('done');
    if (label) label.textContent = idle;
  }, 1800);
}
