/**
 * The deck: in what order stories are shown. Pure logic, and it's what
 * decides what you see over an afternoon, so it's tested without running
 * anything. The unit is the story (all versions of one fact), not the item.
 */
import { clusterStories, type Story } from './cluster.ts';
import type { NewsItem } from './feeds.ts';

/**
 * Takes turns between outlets. Feeds bring very different amounts (97 from
 * one, 25 from another) and concatenating them leaves long runs of a single
 * source. Each source is sorted newest first and they're picked in rounds.
 */
export function interleaveBySource(stories: Story[], limit: number): Story[] {
  const bySource = new Map<string, Story[]>();
  for (const s of stories) {
    const list = bySource.get(s.lead.source);
    if (list) list.push(s);
    else bySource.set(s.lead.source, [s]);
  }
  for (const list of bySource.values()) list.sort((a, b) => b.lead.published - a.lead.published);
  const queues = [...bySource.values()];
  const out: Story[] = [];
  for (let round = 0; out.length < limit; round += 1) {
    let progressed = false;
    for (const q of queues) {
      const next = q[round];
      if (!next) continue;
      out.push(next);
      progressed = true;
      if (out.length >= limit) break;
    }
    // A source that runs short can't stop the others' rounds.
    if (!progressed) break;
  }
  return out;
}

/** Consensus stories that open the deck before mixing in the rest. */
export const LEAD_STORIES = 6;

/**
 * A few consensus stories first, the rest interleaved. Opening with **all**
 * consensus stories starved the queue: the exclusives (AI news among them)
 * would come so late that the deck was rebuilt before reaching them.
 */
export function buildDeck(items: NewsItem[], poolSize: number): Story[] {
  const stories = clusterStories(items);
  const shared = stories.filter((s) => s.consensus > 1);
  shared.sort((a, b) => b.consensus - a.consensus || b.lead.published - a.lead.published);
  const lead = shared.slice(0, LEAD_STORIES);
  const rest = [...shared.slice(LEAD_STORIES), ...stories.filter((s) => s.consensus === 1)];
  const deck = lead.slice(0, poolSize);
  if (deck.length < poolSize) deck.push(...interleaveBySource(rest, poolSize - deck.length));
  return deck;
}

/**
 * Where to resume after the deck is renewed: right after the last story shown
 * if it's still there, else keep the position instead of going back to zero
 * (going back to zero on every poll left most of the deck never shown).
 */
export function resumeCursor(deck: Story[], lastShownLink: string, previous: number): number {
  if (deck.length === 0) return 0;
  const at = lastShownLink ? deck.findIndex((s) => s.lead.link === lastShownLink) : -1;
  if (at >= 0) return (at + 1) % deck.length;
  return Math.min(Math.max(previous, 0), deck.length - 1);
}

/**
 * The story on screen at `now`: one per `rotateMs` slot of the wall clock,
 * walking the deck in order. A pure function of time, so every widget and
 * every repaint agree without shared state; when the deck is renewed (every
 * few minutes) the walk simply continues on the new order.
 */
export function storyAt<T>(deck: readonly T[], now: number, rotateMs: number, ahead = 0): T | undefined {
  if (!deck.length) return undefined;
  const slot = Math.floor(now / Math.max(1000, rotateMs)) + ahead;
  return deck[((slot % deck.length) + deck.length) % deck.length];
}
