/**
 * `kiosko gallery --out dir`: every widget of every installed plugin,
 * painted with its demo data, plus an index.html. For GitHub Pages and for
 * plugin authors who want to see their widgets next to the others.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { composeWidget, normalize, type Registry } from '@kiosko/core';
import { localize, themeById } from '@kiosko/sdk';

/** The editor running in the browser with sample data (built by the Pages workflow next to the gallery). */
const DEMO_URL = 'https://kioskolcd.dev/demo/';
const RELEASES_URL = 'https://github.com/kiosko-lcd/kiosko/releases/latest';
const USB_URL = 'https://github.com/kiosko-lcd/kiosko/blob/main/docs/usb.md';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function buildGallery(registry: Registry, o: { out: string; locale?: string; theme?: string; now?: number }): number {
  const locale = o.locale ?? 'en';
  const theme = themeById(o.theme);
  const now = o.now ?? Date.now();
  const cfg = normalize({ locale, theme: theme.id, location: { latitude: 40.4168, longitude: -3.7038, name: 'Madrid' } });
  mkdirSync(join(o.out, 'img'), { recursive: true });
  const L = (x: Parameters<typeof localize>[0]) => localize(x, locale);
  const sections: string[] = [];
  let count = 0;
  for (const { def, enabled } of registry.list()) {
    if (!enabled || !def.widgets?.length) continue;
    const cards = def.widgets.map((w) => {
      const pref = w.size?.preferred ?? { w: 480, h: 300 };
      const width = Math.min(1920, pref.w);
      const height = Math.min(720, pref.h);
      const file = `img/${def.id}-${w.id}.png`;
      const r = composeWidget({ cfg, registry, theme, type: `${def.id}/${w.id}`, width, height, now, ...(w.chrome === 'bare' ? {} : { title: L(w.name) }) });
      writeFileSync(join(o.out, file), r.canvas.toBuffer('image/png'));
      count++;
      const wide = width >= 900;
      return `<figure class="${wide ? 'wide' : ''}"><div class="shot"><img src="${file}" width="${width}" height="${height}" loading="lazy" alt="${esc(L(w.name))}"></div><figcaption><b>${esc(L(w.name))}</b> <code>${def.id}/${w.id}</code><span>${esc(L(w.description))}</span></figcaption></figure>`;
    });
    sections.push(`<section><h2>${esc(L(def.name))} <small>${esc(def.id)} · v${esc(def.version)}</small></h2><p>${esc(L(def.description))}</p><div class="grid">${cards.join('')}</div></section>`);
  }
  writeFileSync(
    join(o.out, 'index.html'),
    `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kiosko widget gallery</title>
<style>
:root{color-scheme:dark;--bg:#0a0d13;--panel:#121722;--line:rgba(255,255,255,.08);--text:#e7ecf4;--dim:#a3adbf}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{padding:40px 24px 8px;max-width:1240px;margin:auto}h1{margin:0;font-size:32px;letter-spacing:-.02em}
header p{color:var(--dim);margin:6px 0 0}main{max-width:1240px;margin:auto;padding:0 24px 60px}
h2{margin:36px 0 4px;font-size:20px}h2 small{color:var(--dim);font-weight:500;font-size:13px;margin-left:8px}section>p{color:var(--dim);margin:0 0 14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;align-items:start}
figure{margin:0;background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden}figure.wide{grid-column:1/-1}
figure .shot{background:#000;display:grid;place-items:center;padding:8px}figure img{display:block;max-width:100%;height:auto}figcaption{padding:10px 12px;display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline}
figcaption code{color:#22d3ee;font-size:12px}figcaption span{flex-basis:100%;color:var(--dim);font-size:13px}
a{color:#22d3ee}
p.os{margin-top:14px}p.os b{color:var(--text)}
a.try{display:inline-block;margin-top:10px;padding:8px 14px;border-radius:10px;background:linear-gradient(135deg,#8b5cf6,#22d3ee);color:#fff;font-weight:600;text-decoration:none}
</style></head><body><header><h1>Kiosko widget gallery</h1><p>${count} widgets, painted with their demo data by the same code that drives the panels. <a href="https://github.com/kiosko-lcd/kiosko">Kiosko on GitHub</a></p><p><a class="try" href="${DEMO_URL}">Try the editor in your browser →</a> &nbsp; <a class="try" href="${DEMO_URL}3d/">See a panel in 3D →</a></p><p class="os"><b>Now on Linux, macOS and Windows.</b> Windows has an installer, no Node.js needed: <a href="${RELEASES_URL}">download Kiosko for Windows</a>. USB panels talk to Kiosko directly, with no Python: <a href="${USB_URL}">how to connect one</a>.</p></header><main>${sections.join('')}</main></body></html>`,
  );
  return count;
}
