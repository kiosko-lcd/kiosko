/**
 * Release notes (GitHub's Markdown) as plain blocks the editor draws with its
 * own elements: headings, list items and paragraphs of text, code, bold and
 * links. Nothing is ever handed to the browser as HTML, so a release's text
 * can't inject anything; links are kept only when they are http(s).
 *
 * GitHub's generated notes ("* Thing by @someone in https://github.com/…/pull/49")
 * read better with the pull request as "#49" and the comparison as "v0.2.7…v0.2.8".
 */
export type Inline = { t: 'text' | 'code' | 'b'; text: string } | { t: 'a'; text: string; href: string };
export type Block = { t: 'h' | 'p' | 'li'; parts: Inline[] };

const safeHref = (u: string) => (/^https?:\/\/[^\s<>"']+$/i.test(u) ? u : null);

/** How a link to the repository reads: #49 for a pull request or issue, the range for a comparison. */
export function linkText(href: string): string {
  const m = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/(\d+)$/.exec(href);
  if (m) return `#${m[1]}`;
  const c = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/compare\/(.+)$/.exec(href);
  if (c) return c[1]!.replace('...', '…');
  return href.replace(/^https?:\/\//, '');
}

/** `**bold**`, `` `code` ``, `[text](url)` and bare URLs; anything else is text. */
export function inline(s: string): Inline[] {
  const out: Inline[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  let at = 0;
  const text = (x: string) => {
    if (!x) return;
    const last = out.at(-1);
    if (last?.t === 'text') last.text += x;
    else out.push({ t: 'text', text: x });
  };
  for (let m = re.exec(s); m; m = re.exec(s)) {
    text(s.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1] !== undefined) out.push({ t: 'code', text: m[1] });
    else if (m[2] !== undefined) out.push({ t: 'b', text: m[2] });
    else if (m[3] !== undefined) {
      const href = safeHref(m[4]!);
      if (href) out.push({ t: 'a', text: m[3], href });
      else text(m[3]);
    } else {
      const href = safeHref(m[5]!);
      if (href) out.push({ t: 'a', text: linkText(href), href });
      else text(m[5]!);
    }
  }
  text(s.slice(at));
  return out;
}

/** The notes as blocks: `#` headings, `*`/`-` list items, paragraphs (lines joined); HTML tags are dropped as text. */
export function parseNotes(md: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', parts: inline(para.join(' ')) });
    para = [];
  };
  for (const raw of md.replace(/<[^>]*>/g, '').split(/\r?\n/)) {
    const line = raw.trim();
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    const li = /^[*+-]\s+(.*)$/.exec(line);
    if (!line) flush();
    else if (h) {
      flush();
      blocks.push({ t: 'h', parts: inline(h[1]!) });
    } else if (li) {
      flush();
      blocks.push({ t: 'li', parts: inline(li[1]!) });
    } else para.push(line);
  }
  flush();
  return blocks;
}
