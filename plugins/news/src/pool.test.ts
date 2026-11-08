import { test } from 'node:test';
import assert from 'node:assert';
import { buildDeck, interleaveBySource, LEAD_STORIES, resumeCursor, storyAt } from './pool.ts';
import { clusterStories, type Story } from './cluster.ts';
import type { NewsItem } from './feeds.ts';

function item(source: string, n: number): NewsItem {
  // The smaller n, the more recent.
  return { title: `${source} noticia numero ${n} sobre asuntos varios`, summary: 's', image: 'i', source, link: `https://${source}/${n}`, published: 1_000_000 - n };
}
const story = (it: NewsItem): Story => ({ lead: it, items: [it], consensus: 1 });

test('pool: the deck alternates outlets instead of chaining them', () => {
  const raw = [...Array.from({ length: 5 }, (_, i) => story(item('A', i))), ...Array.from({ length: 3 }, (_, i) => story(item('B', i))), ...Array.from({ length: 2 }, (_, i) => story(item('C', i)))];
  const out = interleaveBySource(raw, 10);
  assert.strictEqual(out.length, 10);
  assert.deepStrictEqual(out.slice(0, 3).map((s) => s.lead.source), ['A', 'B', 'C']);
  assert.strictEqual(out[3]?.lead.title, raw[1]!.lead.title, 'within an outlet, newest first');
});

test('pool: an outlet that runs out does not block the rest', () => {
  const out = interleaveBySource([...Array.from({ length: 4 }, (_, i) => story(item('A', i))), story(item('C', 0))], 10);
  assert.deepStrictEqual(out.map((s) => s.lead.source), ['A', 'C', 'A', 'A', 'A']);
});

test('pool: what several outlets agree on opens the deck', () => {
  const shared = [
    { ...item('El País', 9), title: 'Mueren dos mujeres al caer un coche al mar en el puerto de Algeciras' },
    { ...item('ABC', 9), title: 'Dos mujeres mueren al caer al mar un coche en el puerto de Algeciras' },
  ];
  const deck = buildDeck([...Array.from({ length: 6 }, (_, i) => item('20minutos', i)), ...shared], 10);
  assert.strictEqual(deck[0]?.consensus, 2, 'consensus first, not the most recent');
  assert.ok(deck.slice(1).every((s) => s.consensus === 1));
  assert.strictEqual(deck.length, 7);
});

test('pool: poolSize bounds the deck', () => {
  const raw = Array.from({ length: 50 }, (_, i) => item('A', i));
  assert.strictEqual(buildDeck(raw, 12).length, 12);
  assert.strictEqual(buildDeck(raw, 500).length, 50, 'no invented stories, no hang');
});

test('pool: the tail is not starved behind the consensus', () => {
  const items: NewsItem[] = [];
  for (let i = 0; i < 20; i += 1) {
    const t = `Historia numero ${i} con suficientes terminos distintos para agrupar bien`;
    items.push({ ...item('El País', i), title: t }, { ...item('ABC', i), title: t });
  }
  items.push({ ...item('Xataka IA', 99), title: 'Anthropic lanza Claude y cambia el panorama de los modelos' });
  const deck = buildDeck(items, 60);
  const pos = deck.findIndex((s) => s.lead.source === 'Xataka IA');
  assert.ok(pos >= 0 && pos <= LEAD_STORIES, `the exclusive must come early, not at ${pos + 1}`);
  assert.strictEqual(deck[0]?.consensus, 2);
});

test('pool: resuming where it left off', () => {
  const deck = clusterStories(Array.from({ length: 60 }, (_, i) => item('A', i)));
  assert.strictEqual(resumeCursor(deck, 'https://A/11', 0), 12);
  assert.strictEqual(resumeCursor(deck, 'https://A/999', 25), 25, 'if it dropped off, keep the position');
  assert.strictEqual(resumeCursor(deck, 'https://A/59', 59), 0, 'wraps at the end');
  assert.strictEqual(resumeCursor([], 'https://A/1', 3), 0);
});

test('pool: storyAt walks the deck by wall-clock slots', () => {
  const deck = ['a', 'b', 'c'];
  const t0 = 30_000 * 300; // slot 300, which is 0 mod 3
  assert.strictEqual(storyAt(deck, t0, 30_000), 'a');
  assert.strictEqual(storyAt(deck, t0 + 29_999, 30_000), 'a', 'the same story for the whole slot');
  assert.strictEqual(storyAt(deck, t0 + 30_000, 30_000), 'b');
  assert.strictEqual(storyAt(deck, t0, 30_000, 1), 'b', 'offset skips ahead');
  assert.strictEqual(storyAt(deck, t0, 30_000, 5), 'c', 'and wraps');
  assert.strictEqual(storyAt([], t0, 30_000), undefined);
});
