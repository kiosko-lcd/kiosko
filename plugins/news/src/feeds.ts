/**
 * Reading RSS/Atom feeds.
 *
 * No dependencies and no AI: this has to work every day on its own, so it's
 * parsed with regular expressions instead of pulling in an XML parser. A
 * conscious, bounded choice: press feeds are flat RSS 2.0 and only five text
 * fields come out of them. Any `<item>` that doesn't fit is dropped silently
 * instead of failing the whole poll.
 */

/** One feed to read. */
export interface FeedSource {
  /** Short label painted on the screen. Also the key for turns and consensus. */
  name: string;
  url: string;
  /**
   * Regular expression the **headline** must match for the item to stay.
   * Matched against the headline only, on purpose: filtering on the body too
   * lets in pieces that mention the topic in passing.
   */
  titleFilter?: string;
  /** Maximum age in hours for this feed only; replaces the global one. */
  maxAgeHours?: number;
}

export interface NewsItem {
  title: string;
  summary: string;
  /** Photo URL, or null if the article had none. */
  image: string | null;
  source: string;
  link: string;
  /** ms epoch; 0 if the feed gave no usable date. */
  published: number;
}

/** Several Spanish outlets answer 403 to a request without a browser-like User-Agent, even on their RSS. */
export const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü', ccedil: 'ç', Ccedil: 'Ç',
  iquest: '¿', iexcl: '¡', ordf: 'ª', ordm: 'º', deg: '°', euro: '€',
  laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  hellip: '…', ndash: '–', mdash: '—', middot: '·', bull: '•', shy: '',
};

/** XML/HTML entities: named and numeric (decimal and hex). Unknown ones stay as they are. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/**
 * Plain running text: no tags, entities resolved, spaces collapsed. Two
 * passes, because some feeds encode the HTML of the standfirst twice
 * (`&amp;nbsp;`, `&lt;p&gt;`).
 */
export function stripHtml(html: string): string {
  const pass = (t: string) =>
    decodeEntities(
      t
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
        .replace(/<[^>]*>/g, ' '),
    );
  return pass(pass(html)).replace(/\s+/g, ' ').trim();
}

/** Content of the first `<tag>`, without CDATA. */
function tagText(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  if (!m?.[1]) return '';
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

function attr(tagXml: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tagXml);
  return m?.[1] ?? null;
}

/** Only http(s), and no SVG (logos, not photos). */
function usableImage(url: string | null): url is string {
  if (!url) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  return !/\.svg(\?|$)/i.test(url);
}

/**
 * The article's photo, trying in order the four ways outlets publish it. None
 * uses all of them and no two agree: some only use `enclosure`, others bury it
 * in the description's HTML, others give several `media:content` by size.
 */
export function extractImage(itemXml: string): string | null {
  // 1) media:content — maybe several; keep the widest.
  let best: { url: string; width: number } | null = null;
  for (const m of itemXml.matchAll(/<media:content\b([^>]*)>/gi)) {
    const raw = m[1] ?? '';
    const url = attr(raw, 'url');
    const type = attr(raw, 'type') ?? '';
    const medium = attr(raw, 'medium') ?? '';
    if (!usableImage(url)) continue;
    if (type && !/^image\//i.test(type)) continue;
    if (!type && medium && medium.toLowerCase() !== 'image') continue;
    const width = Number.parseInt(attr(raw, 'width') ?? '0', 10) || 0;
    if (!best || width > best.width) best = { url, width };
  }
  if (best) return best.url;

  // 2) media:thumbnail
  const thumb = /<media:thumbnail\b([^>]*)>/i.exec(itemXml);
  if (thumb) {
    const url = attr(thumb[1] ?? '', 'url');
    if (usableImage(url)) return url;
  }

  // 3) an image enclosure
  for (const m of itemXml.matchAll(/<enclosure\b([^>]*)>/gi)) {
    const raw = m[1] ?? '';
    const url = attr(raw, 'url');
    const type = attr(raw, 'type') ?? '';
    if (usableImage(url) && (!type || /^image\//i.test(type))) return url;
  }

  // 4) the first real <img> embedded in the description or the body. Some
  // outlets put an audience-measurement pixel there (El Mundo), which would
  // paint as a flat grey frame.
  for (const m of decodeEntities(itemXml).matchAll(/<img\b([^>]*)>/gi)) {
    const raw = m[1] ?? '';
    const url = attr(raw, 'src');
    if (!usableImage(url) || TRACKER.test(url)) continue;
    const w = Number.parseInt(attr(raw, 'width') ?? '', 10);
    const h = Number.parseInt(attr(raw, 'height') ?? '', 10);
    if (w <= 2 || h <= 2) continue;
    return url;
  }
  return null;
}

/** Audience pixels and beacons, never photos. */
const TRACKER = /imrworldwide|doubleclick|scorecardresearch|google-analytics|\/pixel|\/beacon|\/cgi-bin\//i;

/**
 * Removes the "read more" tail some outlets close the description with
 * (after stripping tags, an orphan "Leer" was left). In a loop because some
 * chain two ("Leer más Ver más").
 */
export function cleanSummary(text: string): string {
  const tail = /(?:\s|[·|—-])*(?:leer(?:\s+m[áa]s)?|seguir\s+leyendo|continuar\s+leyendo|ver\s+m[áa]s|m[áa]s\s+informaci[óo]n|le[eé]r?\s+la\s+noticia\s+completa|read\s+more|continue\s+reading)(?:\s|[.·|—-])*$/i;
  let out = text.trim();
  for (let i = 0; i < 4; i += 1) {
    const next = out.replace(tail, '').trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

function parseDate(raw: string): number {
  if (!raw) return 0;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}

/** Splits the feed's XML into items. Incomplete `<item>`s are dropped. */
export function parseFeed(xml: string, source: string): NewsItem[] {
  const out: NewsItem[] = [];
  const blocks = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi), ...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)];
  for (const block of blocks) {
    const raw = block[1] ?? '';
    const title = stripHtml(tagText(raw, 'title'));
    if (!title) continue;
    // The short description is the good one; `content:encoded` is the whole
    // article and only used when the other is empty or a useless caption.
    const short = stripHtml(tagText(raw, 'description') || tagText(raw, 'summary'));
    const long = stripHtml(tagText(raw, 'content:encoded') || tagText(raw, 'content'));
    const summary = cleanSummary(short.length >= 40 ? short : long.length > short.length ? long : short);
    let link = stripHtml(tagText(raw, 'link'));
    if (!link) link = attr(/<link\b([^>]*)>/i.exec(raw)?.[1] ?? '', 'href') ?? '';
    out.push({
      title,
      summary,
      image: extractImage(raw),
      source,
      link,
      published: parseDate(tagText(raw, 'pubDate') || tagText(raw, 'published') || tagText(raw, 'updated')),
    });
  }
  return out;
}

/** Hours without publishing anything after which a feed counts as frozen. A week: no live outlet goes that long. */
export const STALE_FEED_HOURS = 168;

/** Age of the newest item, in hours; `Infinity` if none has a usable date. */
export function newestAgeHours(items: NewsItem[], now = Date.now()): number {
  let newest = 0;
  for (const it of items) if (it.published > newest) newest = it.published;
  return newest ? (now - newest) / 3_600_000 : Number.POSITIVE_INFINITY;
}

/**
 * Is this feed broken? Without a filter, a feed that answers but brings
 * nothing usable is as broken as one that's down. With a filter, zero is
 * normal (no news on the topic today), so what matters is whether it brought
 * anything before filtering. And above both, **freezing**: a feed that keeps
 * serving the same items for months with a fresh `lastBuildDate` looks
 * healthy to the other two rules. Age is measured before filtering.
 */
export function isFeedBroken(feed: FeedSource, parsed: number, usable: number, newestHours = 0): boolean {
  if (parsed === 0) return true;
  if (newestHours > STALE_FEED_HOURS) return true;
  return feed.titleFilter ? false : usable === 0;
}

/**
 * Clock margin into the future: some outlets date in their zone without
 * saying so, or schedule publication a few hours ahead. Beyond this the date
 * is absurd and would stay first forever when sorting by recency.
 */
export const FUTURE_TOLERANCE_HOURS = 24;

/**
 * Is the item recent? `maxAgeHours <= 0` disables the filter. **An undated
 * item is dropped** while the filter is on: it's impossible to say it's fresh.
 */
export function isFresh(item: NewsItem, maxAgeHours: number, now = Date.now()): boolean {
  if (maxAgeHours <= 0) return true;
  if (!item.published) return false;
  if (item.published - now > FUTURE_TOLERANCE_HOURS * 3_600_000) return false;
  return now - item.published <= maxAgeHours * 3_600_000;
}

/** Applies a feed's headline filter. An invalid regex is reported and lets everything through. */
export function applyFilter(items: NewsItem[], feed: FeedSource, log: (msg: string) => void = () => {}): NewsItem[] {
  if (!feed.titleFilter) return items;
  let re: RegExp;
  try {
    re = new RegExp(feed.titleFilter);
  } catch (err) {
    log(`${feed.name}: invalid titleFilter (${err instanceof Error ? err.message : String(err)}); not filtering`);
    return items;
  }
  return items.filter((it) => re.test(it.title));
}

async function fetchText(url: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export interface FeedHarvest {
  items: NewsItem[];
  /** Feeds that gave nothing usable in this pass. */
  failed: string[];
  /** Of those, the frozen ones: name → hours since their newest item. */
  frozen: Map<string, number>;
}

export interface HarvestOptions {
  timeoutMs: number;
  log?: (msg: string) => void;
  /** Headlines dropped for every feed (case-insensitive regex). */
  rejectFilter?: string;
  /** Default maximum age; 0 = off. */
  maxAgeHours?: number;
  now?: number;
  signal?: AbortSignal;
}

/**
 * Reads every feed at once. A feed that's down can't take the others with it:
 * each resolves on its own and its failure is only noted. Items without a
 * photo are dropped: the design is a full-bleed photo, and a frame without one
 * looks worse than the missing story.
 */
export async function fetchAllFeeds(feeds: FeedSource[], o: HarvestOptions): Promise<FeedHarvest> {
  const log = o.log ?? (() => {});
  const now = o.now ?? Date.now();
  let reject: RegExp | null = null;
  if (o.rejectFilter) {
    try {
      reject = new RegExp(o.rejectFilter, 'i');
    } catch (err) {
      log(`invalid rejectFilter (${err instanceof Error ? err.message : String(err)}); nothing is dropped`);
    }
  }
  const results = await Promise.allSettled(
    feeds.map(async (f) => {
      const parsed = parseFeed(await fetchText(f.url, o.timeoutMs, o.signal), f.name);
      return { parsed, kept: applyFilter(parsed, f, log) };
    }),
  );
  const all: NewsItem[] = [];
  const failed: string[] = [];
  const frozen = new Map<string, number>();
  results.forEach((r, i) => {
    const feed = feeds[i]!;
    if (r.status === 'rejected') {
      log(`${feed.name}: failed (${r.reason instanceof Error ? r.reason.message : String(r.reason)})`);
      failed.push(feed.name);
      return;
    }
    const { parsed, kept } = r.value;
    const clean = reject ? kept.filter((n) => !reject.test(n.title)) : kept;
    const maxAge = feed.maxAgeHours ?? o.maxAgeHours ?? 0;
    const usable = clean.filter((n) => isFresh(n, maxAge, now) && n.image);
    const age = newestAgeHours(parsed, now);
    if (isFeedBroken(feed, parsed.length, usable.length, age)) {
      if (Number.isFinite(age) && age > STALE_FEED_HOURS) {
        frozen.set(feed.name, age);
        log(`${feed.name}: frozen, nothing new for ${Math.round(age / 24)} days`);
      } else {
        log(`${feed.name}: ${parsed.length} items, none usable`);
      }
      failed.push(feed.name);
    }
    all.push(...usable);
  });
  return { items: dedupe(all), failed, frozen };
}

/**
 * Removes duplicates by link and by headline. The second matters as much as
 * the first: several outlets covering the same front page give different
 * links for the same story.
 */
export function dedupe(items: NewsItem[]): NewsItem[] {
  const seenLink = new Set<string>();
  const seenTitle = new Set<string>();
  const out: NewsItem[] = [];
  for (const it of items) {
    const link = it.link.trim().toLowerCase();
    // Normalised headline: no accents, punctuation or short words.
    const key = it.title
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 6)
      .join(' ');
    if (link && seenLink.has(link)) continue;
    if (key && seenTitle.has(key)) continue;
    if (link) seenLink.add(link);
    if (key) seenTitle.add(key);
    out.push(it);
  }
  return out;
}
