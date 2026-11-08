import { test } from 'node:test';
import assert from 'node:assert';
import { clusterStories, contrastPair, overlap, publisherOf, titleBag } from './cluster.ts';
import type { NewsItem } from './feeds.ts';

function it(source: string, title: string, published = 0): NewsItem {
  return { title, summary: 's', image: 'i', source, link: `${source}/${title.slice(0, 12)}`, published };
}

test('cluster: the bag keeps content terms only', () => {
  const b = titleBag('El Gobierno de España aprueba la nueva ley');
  assert.ok(b.has('gobierno'));
  assert.ok(b.has('espana'), 'accents are normalised');
  assert.ok(b.has('aprueba'));
  assert.ok(!b.has('para') && !b.has('la'), 'stop words and short words go');
});

test('cluster: overlap is measured against the smaller bag', () => {
  const short = new Set(['muere', 'director', 'cyrano']);
  const long = new Set(['muere', 'director', 'cyrano', 'bergerac', 'cine', 'frances', 'aventura']);
  // Jaccard would give 3/7 and not group; overlap gives 1.
  assert.strictEqual(overlap(short, long), 1);
  assert.strictEqual(overlap(new Set(['nada', 'comun']), long), 0);
  assert.strictEqual(overlap(new Set(), long), 0);
});

test('cluster: groups the same fact told by different outlets', () => {
  const stories = clusterStories([
    it('elDiario.es', 'Mueren dos mujeres en el Puerto de Algeciras al caer al mar un coche'),
    it('El País', 'Dos mujeres mueren al caer un coche al mar en el puerto de Algeciras'),
    it('ABC', 'El Gobierno aprueba los presupuestos generales del Estado para el año'),
  ]);
  assert.strictEqual(stories.length, 2);
  assert.strictEqual(stories.find((s) => s.consensus === 2)?.items.length, 2);
  assert.strictEqual(stories.find((s) => s.consensus === 1)?.lead.source, 'ABC');
});

test('cluster: short headlines do not pull others in (the measured false positive)', () => {
  const items = [
    it('elDiario.es', 'El rey como ariete contra Sánchez'),
    it('La Vanguardia', 'El PP y Vox unen fuerzas contra Sánchez en una concentración por Ceuta'),
  ];
  assert.strictEqual(clusterStories(items).length, 2);
});

test('cluster: two pieces of the same paper are not consensus', () => {
  const stories = clusterStories([
    it('elDiario.es', 'El Gobierno aprueba la reforma laboral pactada con los sindicatos'),
    it('elDiario.es', 'El Gobierno aprueba la reforma laboral pactada con los sindicatos hoy'),
  ]);
  assert.strictEqual(stories.length, 2);
  assert.ok(stories.every((s) => s.consensus === 1));
});

test('cluster: a contrast only when the headlines really differ', () => {
  const same = clusterStories([
    it('El País', 'Dos mujeres mueren al caer un coche al mar en el puerto de Algeciras'),
    it('La Vanguardia', 'Dos mujeres mueren al caer un coche al mar en el puerto de Algeciras hoy'),
  ]);
  assert.strictEqual(contrastPair(same[0]!), null, 'repeating the sentence adds nothing');
  const apart = clusterStories([
    it('elDiario.es', 'La Policía analiza imágenes de redes sociales para apuntar a la posible participación de agentes marroquíes'),
    it('El Mundo', 'Las imágenes que demuestran la participación de agentes marroquíes en la entrada'),
  ]);
  const pair = contrastPair(apart[0]!);
  assert.ok(pair, 'same fact, opposite certainty: worth showing');
  assert.notStrictEqual(pair[0].source, pair[1].source);
  assert.strictEqual(contrastPair(clusterStories([it('ABC', 'El Gobierno aprueba los presupuestos generales del Estado')])[0]!), null);
});

test('cluster: a paper is not contrasted with itself through two feeds', () => {
  assert.strictEqual(publisherOf('20minutos IA'), '20minutos');
  assert.strictEqual(publisherOf('Xataka IA'), 'Xataka');
  assert.strictEqual(publisherOf('Diario IAS'), 'Diario IAS', 'only the exact suffix');
  const own = {
    lead: it('20minutos', 'OpenAI presenta su modelo más potente hasta la fecha'),
    items: [it('20minutos', 'OpenAI presenta su modelo más potente hasta la fecha'), it('20minutos IA', 'OpenAI lanza GPT tras frenar parte del desarrollo por seguridad')],
    consensus: 2,
  };
  assert.strictEqual(contrastPair(own), null);
  const pair = contrastPair({ ...own, items: [...own.items, it('Xataka IA', 'El nuevo modelo de OpenAI llega con dudas sobre su coste')] });
  assert.ok(pair);
  assert.notStrictEqual(publisherOf(pair[0].source), publisherOf(pair[1].source));
});
