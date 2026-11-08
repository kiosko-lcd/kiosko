/**
 * Groups the same story told by several outlets.
 *
 * Not to drop duplicates (`dedupe` does that, by link) but to **measure
 * consensus**: five of six outlets leading with the same thing is a relevance
 * signal that comes from plain set theory, no model and no API. And as a
 * bonus, the same fact with two headlines from different editorial lines.
 *
 * Bags of terms with overlap, not prefixes: the same story almost never starts
 * the same way in two papers (measured on 634 real items: prefixes grouped 2,
 * bags 21, all correct). Thresholds are measured too: with a minimum bag of 3
 * a false positive joined four different stories sharing three names; with 5
 * it goes away.
 */
import type { NewsItem } from './feeds.ts';

/** Minimum overlap for two headlines to be the same story. */
export const SAME_STORY = 0.6;
/** Minimum terms in the bag for a headline to group others: the guard against short headlines. */
export const MIN_BAG = 5;
/**
 * Upper bound to show two versions side by side. It does NOT measure
 * editorial divergence (a low overlap means different vocabulary, not a
 * different angle); it only drops literal repetition, where the second column
 * would add nothing.
 */
export const CONTRAST_MAX = 0.8;

/** Spanish stop words. Short on purpose: each one removed raises every pair's overlap. */
const STOPWORDS = new Set([
  'para', 'como', 'pero', 'este', 'esta', 'esto', 'entre', 'sobre', 'desde',
  'hasta', 'tras', 'sus', 'han', 'del', 'las', 'los', 'que', 'con', 'por',
  'una', 'uno', 'ser', 'son', 'fue', 'sin', 'ante', 'cada', 'todo', 'toda',
  'otro', 'otra', 'hace', 'tiene', 'puede', 'dice', 'muy',
  'with', 'from', 'that', 'this', 'their', 'have', 'after', 'over', 'into', 'says',
]);

/** Bag of content terms: no accents, no punctuation, no stop words. */
export function titleBag(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w)),
  );
}

/**
 * Overlap relative to the smaller bag (Szymkiewicz-Simpson), not Jaccard: a
 * terse headline and a long one about the same event have a low Jaccard only
 * because one has more words. This asks "is the short one contained in the
 * long one?", which is the relation between two versions of a story.
 */
export function overlap(a: Set<string>, b: Set<string>): number {
  const min = Math.min(a.size, b.size);
  if (min === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / min;
}

export interface Story {
  /** The version painted: the most recent of the group. */
  lead: NewsItem;
  /** Every version, `lead` included. */
  items: NewsItem[];
  /** Distinct outlets carrying it. 1 = exclusive or little followed. */
  consensus: number;
}

/**
 * Single-pass clustering against the group's representative, not all its
 * members: with single linkage, A like B and B like C would put A and C
 * together even if they share nothing.
 */
export function clusterStories(items: NewsItem[], threshold = SAME_STORY, minBag = MIN_BAG): Story[] {
  const bags = items.map((it) => ({ it, bag: titleBag(it.title) }));
  const taken = new Array<boolean>(bags.length).fill(false);
  const out: Story[] = [];
  for (let i = 0; i < bags.length; i += 1) {
    if (taken[i]) continue;
    const head = bags[i]!;
    taken[i] = true;
    const group = [head.it];
    if (head.bag.size >= minBag) {
      for (let j = i + 1; j < bags.length; j += 1) {
        if (taken[j]) continue;
        const other = bags[j]!;
        if (other.bag.size < minBag) continue;
        // Two outlets, not two pieces of the same paper on the same topic:
        // chronicle, analysis and opinion of one paper is coverage, not consensus.
        if (other.it.source === head.it.source) continue;
        if (overlap(head.bag, other.bag) >= threshold) {
          group.push(other.it);
          taken[j] = true;
        }
      }
    }
    group.sort((a, b) => b.published - a.published);
    out.push({ lead: group[0]!, items: group, consensus: new Set(group.map((g) => g.source)).size });
  }
  return out;
}

/**
 * The outlet a source belongs to, without the topic label: "20minutos IA" is
 * a separate source for taking turns, but the same paper, and a paper
 * contrasted with itself contrasts nothing. Only the exact suffix is cut.
 */
export function publisherOf(source: string): string {
  return source.replace(/ (?:IA|AI)$/, '');
}

/**
 * Two versions of the same fact from different outlets, if there are: the
 * pair with the **lowest** overlap below `maxOverlap`. Null with one outlet,
 * or when they repeat the same sentence.
 */
export function contrastPair(story: Story, maxOverlap = CONTRAST_MAX): [NewsItem, NewsItem] | null {
  if (story.items.length < 2) return null;
  let best: { pair: [NewsItem, NewsItem]; score: number } | null = null;
  for (let i = 0; i < story.items.length; i += 1) {
    for (let j = i + 1; j < story.items.length; j += 1) {
      const a = story.items[i]!;
      const b = story.items[j]!;
      if (publisherOf(a.source) === publisherOf(b.source)) continue;
      const score = overlap(titleBag(a.title), titleBag(b.title));
      // Strict: at exactly 0.80 the headlines differ only in a connector.
      if (score >= maxOverlap) continue;
      if (!best || score < best.score) best = { pair: [a, b], score };
    }
  }
  return best?.pair ?? null;
}
