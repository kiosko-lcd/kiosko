// The guides that exist in a language (docs/<id>/install.md, usb.md) as pages of the site:
// /zh-Hans/docs/install/, /zh-Hant/docs/usb/… Read where GitHub is slow or out of reach (mainland
// China), in the site's look, with links between them kept on the site.
//
// The Markdown is the small part the guides use: headings, paragraphs, lists, tables, fenced
// code, quotes, **bold**, `code`, [links](…) and <https://…>.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LANGS, SITE, esc } from './pages.mjs';
import { pageHead } from './store.mjs';

const REPO_BLOB = 'https://github.com/kiosko-lcd/kiosko/blob/main/docs/';
/** The guides the site publishes, by file. */
export const GUIDES = ['install', 'usb', 'remote-screens', 'browser-screens', 'pages', 'data-sources', 'rest-webhook'];

const HAN = /[⺀-鿿豈-﫿＀-￯　-〿]/;

/** An anchor as GitHub makes it (`国内网络`, `windows使用安装程序`), so links written for GitHub land. */
export function slug(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>|[*`]/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

/** Lines of one paragraph, joined: no space where Chinese meets Chinese (a browser would show one). */
function joinLines(lines) {
  return lines.reduce((acc, l) => (!acc ? l : HAN.test(acc.at(-1)) || HAN.test(l[0]) ? acc + l : `${acc} ${l}`), '');
}

/** **bold**, `code`, [text](href) and <https://…>; `link` turns a Markdown href into the site's. */
function inline(s, link) {
  const codes = [];
  let out = esc(s).replace(/`([^`]+)`/g, (_m, c) => `\u0000${codes.push(c) - 1}\u0000`);
  out = out
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, href) => `<a href="${esc(link(href.replace(/&amp;/g, '&')))}">${t}</a>`)
    .replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (_m, u) => `<a href="${u}">${u}</a>`);
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${codes[+i]}</code>`);
}

/** The guide's Markdown as HTML; `link` maps the hrefs. Returns its title (the first # heading) too. */
export function renderMarkdown(md, link = (h) => h) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let title = '';
  let i = 0;
  const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      const body = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i]);
      i++;
      html.push(`<pre><code${fence[1] ? ` class="language-${fence[1]}"` : ''}>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      if (level === 1 && !title) title = h[2];
      html.push(`<h${level} id="${esc(slug(h[2]))}">${inline(h[2], link)}</h${level}>`);
      i++;
      continue;
    }
    if (/^\|/.test(line) && /^\|?\s*:?-{3,}/.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && /^\|/.test(lines[i]); i++) rows.push(cells(lines[i]));
      html.push(`<div class="table"><table><thead><tr>${head.map((c) => `<th>${inline(c, link)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, link)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const body = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) body.push(lines[i].replace(/^>\s?/, ''));
      html.push(`<blockquote><p>${inline(joinLines(body), link)}</p></blockquote>`);
      continue;
    }
    const item = /^(\s*)(?:[-*]|(\d+)\.)\s+/;
    if (item.test(line)) {
      const ordered = !!line.match(item)[2];
      const items = [];
      for (; i < lines.length && lines[i].trim(); i++) {
        if (item.test(lines[i])) items.push([lines[i].replace(item, '')]);
        else items.at(-1).push(lines[i].trim());
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push(`<${tag}>${items.map((it) => `<li>${inline(joinLines(it), link)}</li>`).join('')}</${tag}>`);
      continue;
    }
    const para = [];
    for (; i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\||>|\s*(?:[-*]|\d+\.)\s)/.test(lines[i]); i++) para.push(lines[i].trim());
    if (!para.length) { para.push(line.trim()); i++; }
    html.push(`<p>${inline(joinLines(para), link)}</p>`);
  }
  return { title, html: html.join('\n') };
}

/** A guide's file in a language: English at docs/<guide>.md, the others at docs/<id>/<guide>.md. */
function guideFile(docsDir, langId, guide) {
  return langId === 'en' ? join(docsDir, `${guide}.md`) : join(docsDir, langId, `${guide}.md`);
}

/** The guide's address on GitHub, for the page's footer and for links the site doesn't publish. */
function repoFile(langId, guide) {
  return langId === 'en' ? `${REPO_BLOB}${guide}.md` : `${REPO_BLOB}${langId}/${guide}.md`;
}

/** The languages a guide exists in (docs/<guide>.md for English, docs/<id>/<guide>.md for the rest). */
export function guideLangs(docsDir, guide) {
  return LANGS.filter((l) => existsSync(guideFile(docsDir, l.id, guide)));
}

/** Where a language's guide lives on the site, from the site's root (`zh-Hans/docs/install/`, `docs/usb/`); null if it has none. */
export function guidePath(docsDir, langId, guide) {
  const l = LANGS.find((x) => x.id === langId);
  return l && existsSync(guideFile(docsDir, l.id, guide)) ? `${l.path}docs/${guide}/` : null;
}

/**
 * Writes every guide that has a translation as `<lang>/docs/<guide>/index.html`. Returns the
 * pages for the sitemap (`{ path, langs }`).
 */
export function buildDocPages({ out, docsDir, texts, css }) {
  const pages = [];
  for (const guide of GUIDES) {
    const langs = guideLangs(docsDir, guide);
    for (const l of langs) {
      const path = `docs/${guide}/`;
      const root = '../'.repeat(`${l.path}${path}`.split('/').filter(Boolean).length);
      const link = (href) => {
        if (/^(https?:|mailto:|#)/.test(href)) return href;
        const [file, hash = ''] = href.split('#');
        const name = file.replace(/^\.\//, '').replace(/\.md$/, '');
        if (GUIDES.includes(name) && existsSync(guideFile(docsDir, l.id, name))) return `../${name}/${hash ? `#${hash}` : ''}`;
        // Anything else of the repository: on GitHub.
        return new URL(href, l.id === 'en' ? REPO_BLOB : `${REPO_BLOB}${l.id}/`).href;
      };
      const { title, html } = renderMarkdown(readFileSync(guideFile(docsDir, l.id, guide), 'utf8'), link);
      const description = html.match(/<p>(.*?)<\/p>/)?.[1]?.replace(/<[^>]+>/g, '').slice(0, 160) ?? title;
      const page = `${pageHead({ lang: l.id, texts, title: `${title} · Kiosko`, description, path, root, css, langs })}
  <main class="doc">
    <article class="guide">
${html}
    </article>
    <p class="fine"><a href="${repoFile(l.id, guide)}">GitHub</a> · <a href="${SITE}${l.path}">kioskolcd.dev</a></p>
  </main>
</body>
</html>
`;
      const dir = join(out, l.path, path);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'index.html'), page);
    }
    if (langs.length) pages.push({ path: `docs/${guide}/`, langs });
  }
  return pages;
}
