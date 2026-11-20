/**
 * `kiosko gallery --out dir`: every widget of every installed plugin,
 * painted with its demo data, plus an index.html. For GitHub Pages and for
 * plugin authors who want to see their widgets next to the others.
 *
 * It also writes gallery.json, the same catalogue as data (in each language
 * the site speaks), which the site's front page is built from; with `pages`,
 * the pages of that config's bar-shaped screen too, painted with demo data.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Runtime, SAMPLE_PLACES, composeWidget, localizeSample, normalize, type Config, type Registry } from '@kiosko/core';
import { LANGUAGES, languageById, localize, themeById } from '@kiosko/sdk';

/** A text in each language the gallery is painted in, by language id. */
type Both = Record<string, string>;

/** gallery.json: what the front page (packages/web/landing) needs to know. */
export interface GalleryData {
  count: number;
  /** The language ids it was painted in; the first is the default (`img/…`). */
  languages: string[];
  plugins: { id: string; version: string; name: Both; description: Both; widgets: { type: string; name: Both; description: Both; file: Both; width: number; height: number }[] }[];
  /** Pages of a sample screen, as pictures in each language (`pages` option). */
  pages: { id: string; name: string; file: Both; width: number; height: number }[];
}

/** The editor running in the browser with sample data (built by the Pages workflow next to the gallery). */
const HOME_URL = 'https://kioskolcd.dev/';
const RELEASES_URL = 'https://github.com/kiosko-lcd/kiosko/releases/latest';

const MADRID = { latitude: 40.4168, longitude: -3.7038, name: 'Madrid' };

/** The gallery page's own words. */
const T = {
  title: { en: 'Kiosko widget gallery', es: 'Galería de widgets de Kiosko', de: 'Kiosko-Widget-Galerie', 'zh-Hant': 'Kiosko 小工具展示', 'zh-Hans': 'Kiosko 小组件展示' },
  lede: { en: '{n} widgets, painted with their demo data by the same code that drives the panels.', es: '{n} widgets, pintados con sus datos de muestra por el mismo código que mueve los paneles.', de: '{n} Widgets, mit ihren Demodaten gezeichnet, vom selben Code, der die Panels steuert.', 'zh-Hant': '{n} 個小工具，以範例資料繪製，用的正是驅動面板的同一套程式碼。', 'zh-Hans': '{n} 个小组件，用示例数据绘制，用的正是驱动副屏的同一套代码。' },
  github: { en: 'Kiosko on GitHub', es: 'Kiosko en GitHub', de: 'Kiosko auf GitHub', 'zh-Hant': 'GitHub 上的 Kiosko', 'zh-Hans': 'GitHub 上的 Kiosko' },
  editor: { en: 'Try the editor in your browser →', es: 'Prueba el editor en tu navegador →', de: 'Den Editor im Browser ausprobieren →', 'zh-Hant': '在瀏覽器中試用編輯器 →', 'zh-Hans': '在浏览器中试用编辑器 →' },
  in3d: { en: 'See a panel in 3D →', es: 'Ver un panel en 3D →', de: 'Ein Panel in 3D ansehen →', 'zh-Hant': '以 3D 檢視面板 →', 'zh-Hans': '查看 3D 副屏 →' },
  os: {
    en: '<b>On Linux, macOS and Windows.</b> Windows has an installer, no Node.js needed: <a href="{releases}">download Kiosko for Windows</a>. USB panels talk to Kiosko directly: <a href="{usb}">how to connect one</a>.',
    es: '<b>En Linux, macOS y Windows.</b> Windows tiene instalador, sin necesidad de Node.js: <a href="{releases}">descarga Kiosko para Windows</a>. Los paneles USB hablan directamente con Kiosko: <a href="{usb}">cómo conectar uno</a>.',
    de: '<b>Unter Linux, macOS und Windows.</b> Für Windows gibt es einen Installer, kein Node.js nötig: <a href="{releases}">Kiosko für Windows herunterladen</a>. USB-Panels sprechen direkt mit Kiosko: <a href="{usb}">so schließt du eins an</a>.',
    'zh-Hant': '<b>支援 Linux、macOS 與 Windows。</b>Windows 有安裝程式，不需要 Node.js：<a href="{releases}">下載 Windows 版 Kiosko</a>。USB 面板直接與 Kiosko 溝通：<a href="{usb}">如何連接面板</a>。',
    'zh-Hans': '<b>支持 Linux、macOS 和 Windows。</b>Windows 有安装程序，无需 Node.js：<a href="{releases}">下载 Windows 版 Kiosko</a>。USB 副屏直接与 Kiosko 通信：<a href="{usb}">如何连接副屏</a>。',
  },
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'page';

/**
 * `languages: true`: in every language Kiosko speaks (the site): pictures in
 * `img/` (English) and `img/<id>/`, a page in `index.html` and `<id>/index.html`.
 * Otherwise in `locale` only.
 */
export function buildGallery(registry: Registry, o: { out: string; locale?: string; languages?: boolean; theme?: string; now?: number; pages?: Config }): number {
  const theme = themeById(o.theme);
  const now = o.now ?? Date.now();
  const langs = o.languages ? LANGUAGES.map((l) => ({ id: l.id, locale: l.panel, dir: l.dir })) : [{ id: o.locale ?? 'en', locale: o.locale ?? 'en', dir: 'ltr' as const }];
  const first = langs[0]!.id;
  const folder = (id: string) => (id === first ? '' : `${id}/`);
  const both = (x: Parameters<typeof localize>[0]): Both => Object.fromEntries(langs.map((l) => [l.id, localize(x, l.locale)]));
  const data: GalleryData = { count: 0, languages: langs.map((l) => l.id), plugins: [], pages: [] };
  let count = 0;
  const pluginsOf = registry.list().filter(({ def, enabled }) => enabled && def.widgets?.length);
  for (const lang of langs) {
    mkdirSync(join(o.out, 'img', folder(lang.id)), { recursive: true });
    const cfg = normalize({ locale: lang.locale, theme: theme.id, location: SAMPLE_PLACES[lang.id] ?? MADRID });
    const L = (x: Parameters<typeof localize>[0]) => localize(x, lang.locale);
    const up = folder(lang.id) ? '../' : '';
    const sections: string[] = [];
    // Plugins whose service is not offered where the language is read (languages.ts) are painted, not listed.
    const without = languageById(lang.id)?.plugins?.without ?? [];
    const listedHere = pluginsOf.filter(({ def }) => !without.includes(def.id));
    for (const { def } of pluginsOf) {
      let listed = data.plugins.find((p) => p.id === def.id);
      if (!listed) data.plugins.push((listed = { id: def.id, version: def.version, name: both(def.name), description: both(def.description), widgets: [] }));
      const cards = def.widgets!.map((w) => {
        const pref = w.size?.preferred ?? { w: 480, h: 300 };
        const width = Math.min(1920, pref.w);
        const height = Math.min(720, pref.h);
        const file = `img/${folder(lang.id)}${def.id}-${w.id}.png`;
        const r = composeWidget({ cfg, registry, theme, type: `${def.id}/${w.id}`, width, height, now, ...(w.chrome === 'bare' ? {} : { title: L(w.name) }) });
        writeFileSync(join(o.out, file), r.canvas.toBuffer('image/png'));
        let shot = listed!.widgets.find((x) => x.type === `${def.id}/${w.id}`);
        if (!shot) {
          count++;
          listed!.widgets.push((shot = { type: `${def.id}/${w.id}`, name: both(w.name), description: both(w.description), file: {}, width, height }));
        }
        shot.file[lang.id] = file;
        const wide = width >= 900;
        return `<figure class="${wide ? 'wide' : ''}"><div class="shot"><img src="${up}${file}" width="${width}" height="${height}" loading="lazy" alt="${esc(L(w.name))}"></div><figcaption><b>${esc(L(w.name))}</b> <code>${def.id}/${w.id}</code><span>${esc(L(w.description))}</span></figcaption></figure>`;
      });
      if (!without.includes(def.id)) sections.push(`<section><h2>${esc(L(def.name))} <small>${esc(def.id)} · v${esc(def.version)}</small></h2><p>${esc(L(def.description))}</p><div class="grid">${cards.join('')}</div></section>`);
    }
    const home = `${HOME_URL}${folder(lang.id)}`;
    const usb = `https://github.com/kiosko-lcd/kiosko/blob/main/docs/${lang.id.startsWith('zh') ? `${lang.id}/` : ''}usb.md`;
    mkdirSync(join(o.out, folder(lang.id)), { recursive: true });
    writeFileSync(
      join(o.out, folder(lang.id), 'index.html'),
      `<!doctype html><html lang="${lang.id}" dir="${lang.dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(L(T.title))}</title>
<style>
:root{color-scheme:dark;--bg:#0a0d13;--panel:#121722;--line:rgba(255,255,255,.08);--text:#e7ecf4;--dim:#a3adbf}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
html:lang(zh-Hant) body{font-family:"PingFang TC","Microsoft JhengHei","Noto Sans TC","Noto Sans CJK TC",ui-sans-serif,system-ui,sans-serif}
html:lang(zh-Hans) body{font-family:"PingFang SC","Microsoft YaHei","Noto Sans SC","Noto Sans CJK SC",ui-sans-serif,system-ui,sans-serif}
header{padding:40px 24px 8px;max-width:1240px;margin:auto}h1{margin:0;font-size:32px;letter-spacing:-.02em}
html:lang(zh) h1{letter-spacing:0}
header p{color:var(--dim);margin:6px 0 0}main{max-width:1240px;margin:auto;padding:0 24px 60px}
h2{margin:36px 0 4px;font-size:20px}h2 small{color:var(--dim);font-weight:500;font-size:13px;margin-left:8px}section>p{color:var(--dim);margin:0 0 14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;align-items:start}
figure{margin:0;background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden}figure.wide{grid-column:1/-1}
figure .shot{background:#000;display:grid;place-items:center;padding:8px}figure img{display:block;max-width:100%;height:auto}figcaption{padding:10px 12px;display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline}
figcaption code{color:#22d3ee;font-size:12px}figcaption span{flex-basis:100%;color:var(--dim);font-size:13px}
a{color:#22d3ee}
p.os{margin-top:14px}p.os b{color:var(--text)}
a.try{display:inline-block;margin-top:10px;padding:8px 14px;border-radius:10px;background:linear-gradient(135deg,#8b5cf6,#22d3ee);color:#fff;font-weight:600;text-decoration:none}
</style></head><body><header><p><a href="${home}">← Kiosko</a></p><h1>${esc(L(T.title))}</h1><p>${esc(L(T.lede).replace('{n}', String(listedHere.reduce((n, p) => n + p.def.widgets!.length, 0))))} <a href="https://github.com/kiosko-lcd/kiosko">${esc(L(T.github))}</a></p><p><a class="try" href="${HOME_URL}demo/?lang=${lang.locale}">${esc(L(T.editor))}</a> &nbsp; <a class="try" href="${HOME_URL}demo/3d/?lang=${lang.locale}">${esc(L(T.in3d))}</a></p><p class="os">${L(T.os).replace('{releases}', RELEASES_URL).replace('{usb}', usb)}</p></header><main>${sections.join('')}</main></body></html>`,
    );
  }
  // The pages of a sample screen (the most bar-shaped one), for the front page to show before anything loads.
  if (o.pages) {
    const sample = normalize(o.pages);
    const screen = [...sample.screens].sort((a, b) => b.width / b.height - a.width / a.height)[0];
    for (const page of screen?.pages.filter((p) => p.enabled !== false) ?? []) {
      const name = `img/page-${slug(page.name || page.id)}`;
      data.pages.push({ id: page.id, name: page.name, file: Object.fromEntries(langs.map((l) => [l.id, l.id === first ? `${name}.jpg` : `${name}.${l.id}.jpg`])), width: screen!.width, height: screen!.height });
    }
    // The widgets speak the config's language: each picture is painted once in each.
    for (const l of langs) {
      // Painted from the localized config: its pages lose the English titles of the sample.
      const local = normalize({ ...localizeSample(sample, l.locale), locale: l.locale });
      const shown = local.screens.find((s) => s.id === screen!.id)!;
      const rt = new Runtime(registry, local, { demo: true });
      try {
        for (const listed of data.pages) {
          const page = shown.pages.find((p) => p.id === listed.id)!;
          writeFileSync(join(o.out, listed.file[l.id]!), rt.preview(shown, page, { now, demo: true }).canvas.toBuffer('image/jpeg', 88));
        }
      } finally {
        rt.stop();
      }
    }
  }
  data.count = count;
  writeFileSync(join(o.out, 'gallery.json'), `${JSON.stringify(data)}\n`);
  return count;
}
