import { test } from 'node:test';
import assert from 'node:assert';
import { applyFilter, cleanSummary, dedupe, decodeEntities, extractImage, isFeedBroken, isFresh, newestAgeHours, parseFeed, stripHtml, STALE_FEED_HOURS, type NewsItem } from './feeds.ts';
import { AI_TITLE_FILTER, JUNK_TITLE_FILTER } from './defaults.ts';

test('feeds: named, decimal and hex entities', () => {
  assert.strictEqual(decodeEntities('Espa&ntilde;a'), 'España');
  assert.strictEqual(decodeEntities('&iquest;Qu&eacute; tal?'), '¿Qué tal?');
  assert.strictEqual(decodeEntities('&#191;S&#237;?'), '¿Sí?');
  assert.strictEqual(decodeEntities('&#x41;&#x42;'), 'AB');
  assert.strictEqual(decodeEntities('caf&eacute; &amp; copa'), 'café & copa');
  // An unknown entity is left alone rather than breaking the text.
  assert.strictEqual(decodeEntities('&noexiste; fin'), '&noexiste; fin');
});

test('feeds: stripHtml leaves running text, also when encoded twice', () => {
  assert.strictEqual(stripHtml('<p>Hola <b>mundo</b></p>'), 'Hola mundo');
  assert.strictEqual(stripHtml('<![CDATA[ Con  espacios  ]]>'), 'Con espacios');
  assert.strictEqual(stripHtml('<script>malo()</script>Bueno'), 'Bueno');
  assert.strictEqual(stripHtml('<img src="x.jpg">Pie de foto'), 'Pie de foto');
  assert.strictEqual(stripHtml('Agricultura decreta&amp;nbsp;el almacenamiento'), 'Agricultura decreta el almacenamiento');
  assert.strictEqual(stripHtml('&lt;p&gt;Hola&amp;shy;mundo&lt;/p&gt;'), 'Holamundo');
});

test('feeds: the "read more" tail is cut', () => {
  assert.strictEqual(cleanSummary('El Gobierno aprueba la ley. Leer'), 'El Gobierno aprueba la ley.');
  assert.strictEqual(cleanSummary('Noticia importante Leer más'), 'Noticia importante');
  assert.strictEqual(cleanSummary('Otra cosa Seguir leyendo'), 'Otra cosa');
  assert.strictEqual(cleanSummary('Tercera Ver más'), 'Tercera');
  assert.strictEqual(cleanSummary('A story Read more'), 'A story');
  // Legitimate text that only contains the words inside is untouched.
  assert.strictEqual(cleanSummary('Aprende a leer más rápido con este método'), 'Aprende a leer más rápido con este método');
});

test('feeds: the photo comes out of the four possible places', () => {
  assert.strictEqual(extractImage('<media:content url="https://a/small.jpg" width="200"/><media:content url="https://a/big.jpg" width="1200"/>'), 'https://a/big.jpg', 'the widest media:content');
  assert.strictEqual(extractImage('<media:thumbnail url="https://a/t.jpg"/>'), 'https://a/t.jpg');
  assert.strictEqual(extractImage('<enclosure type="image/jpeg" url="https://a/e.jpg"/>'), 'https://a/e.jpg');
  assert.strictEqual(extractImage('<description>&lt;p&gt;&lt;img src="https://a/d.jpg"&gt;&lt;/p&gt;</description>'), 'https://a/d.jpg', 'an <img> in the description');
  assert.strictEqual(extractImage('<enclosure type="audio/mpeg" url="https://a/x.mp3"/>'), null, 'audio is not a photo');
  assert.strictEqual(extractImage('<media:content url="https://a/logo.svg"/>'), null, 'SVGs are logos');
  // El Mundo's measurement pixel in the description is not a photo either.
  assert.strictEqual(extractImage('<description>&lt;img src="http://secure-uk.imrworldwide.com/cgi-bin/m?cid=x"&gt;</description>'), null);
  assert.strictEqual(extractImage('<description>&lt;img src="https://a/p.gif" width="1" height="1"&gt;&lt;img src="https://a/real.jpg"&gt;</description>'), 'https://a/real.jpg');
});

test('feeds: parseFeed takes the five fields of an <item>', () => {
  const xml = `<rss><channel>
    <item>
      <title><![CDATA[Un titular con ñ]]></title>
      <link>https://ejemplo.es/noticia</link>
      <description><![CDATA[Una explicación suficientemente larga para valer.]]></description>
      <pubDate>Wed, 02 Sep 2026 09:31:55 +0200</pubDate>
      <enclosure type="image/jpeg" url="https://ejemplo.es/foto.jpg"/>
    </item>
  </channel></rss>`;
  const [item] = parseFeed(xml, 'Ejemplo');
  assert.ok(item);
  assert.strictEqual(item.title, 'Un titular con ñ');
  assert.strictEqual(item.link, 'https://ejemplo.es/noticia');
  assert.strictEqual(item.summary, 'Una explicación suficientemente larga para valer.');
  assert.strictEqual(item.image, 'https://ejemplo.es/foto.jpg');
  assert.strictEqual(item.source, 'Ejemplo');
  assert.strictEqual(item.published, Date.parse('2026-09-02T07:31:55Z'));
});

test('feeds: Atom entries too, with the link in href', () => {
  const xml = '<feed><entry><title>Atom story</title><link href="https://a/x"/><updated>2026-09-02T10:00:00Z</updated><summary>Short</summary></entry></feed>';
  const [item] = parseFeed(xml, 'A');
  assert.strictEqual(item?.link, 'https://a/x');
  assert.strictEqual(item?.published, Date.parse('2026-09-02T10:00:00Z'));
});

test('feeds: an <item> without a headline is dropped instead of breaking the poll', () => {
  const items = parseFeed('<rss><channel><item><link>https://a/1</link></item><item><title>Bueno</title></item></channel></rss>', 'X');
  assert.deepStrictEqual(items.map((i) => i.title), ['Bueno']);
});

function item(over: Partial<NewsItem>): NewsItem {
  return { title: 't', summary: 's', image: 'i', source: 'F', link: '', published: 0, ...over };
}

test('feeds: dedupe drops repeats by link and by similar headline', () => {
  const out = dedupe([
    item({ title: 'El PP pide la dimisión del ministro', link: 'https://a/1' }),
    item({ title: 'El PP pide la dimisión del ministro', link: 'https://b/2' }), // same story, another outlet
    item({ title: 'Otra noticia completamente distinta aquí', link: 'https://a/1' }), // same link
    item({ title: 'Una tercera noticia sin relación ninguna', link: 'https://c/3' }),
  ]);
  assert.deepStrictEqual(out.map((i) => i.link), ['https://a/1', 'https://c/3']);
});

test('feeds: the topic filter looks at the headline only', () => {
  const items = [
    item({ title: 'Anthropic lanza Claude Mythos 5.1', summary: 'nada' }),
    item({ title: 'Google lanza Gemini 3.8 Flash, su IA más inteligente', summary: 'nada' }),
    // The measured case to keep out: AI only in the body.
    item({ title: 'Un jefe boomer no entendía a sus empleados millennials', summary: 'habla de IA' }),
    item({ title: 'El Gobierno aprueba los presupuestos', summary: 'nada' }),
  ];
  const out = applyFilter(items, { name: 'X', url: 'u', titleFilter: AI_TITLE_FILTER });
  assert.deepStrictEqual(out.map((i) => i.title.slice(0, 20)), ['Anthropic lanza Clau', 'Google lanza Gemini ']);
});

test('feeds: "IA" does not match inside other words', () => {
  const items = [item({ title: 'La familia real visita Valencia' }), item({ title: 'MEDIA y COPIA de seguridad' })];
  assert.deepStrictEqual(applyFilter(items, { name: 'X', url: 'u', titleFilter: AI_TITLE_FILTER }), []);
});

test('feeds: an invalid regex warns and lets everything through', () => {
  const warnings: string[] = [];
  const out = applyFilter([item({ title: 'Cualquier cosa' })], { name: 'X', url: 'u', titleFilter: '(unclosed' }, (m) => warnings.push(m));
  assert.strictEqual(out.length, 1, 'better too much than a mute feed');
  assert.match(warnings[0]!, /invalid/);
});

test('feeds: a filtered feed with no matches today is not broken; a frozen one is', () => {
  const filtered = { name: 'Xataka IA', url: 'u', titleFilter: 'gemini' };
  const plain = { name: 'El País', url: 'u' };
  assert.strictEqual(isFeedBroken(filtered, 26, 0), false, '26 items, none on AI: normal');
  assert.strictEqual(isFeedBroken(filtered, 0, 0), true, 'nothing at all: broken');
  assert.strictEqual(isFeedBroken(plain, 30, 0), true, 'unfiltered with zero usable: broken');
  assert.strictEqual(isFeedBroken(plain, 30, 30), false);
  // The shape of a feed that kept answering with the same items for eight months.
  assert.strictEqual(isFeedBroken(filtered, 14, 4, 5931), true);
  assert.strictEqual(isFeedBroken(plain, 14, 14, STALE_FEED_HOURS), false, 'right at the threshold, not yet');
  assert.strictEqual(isFeedBroken(filtered, 26, 0, 3), false);
});

test('feeds: newestAgeHours looks at the newest, not the first', () => {
  const now = Date.UTC(2026, 8, 4, 12);
  const at = (h: number) => item({ published: h ? now - h * 3_600_000 : 0 });
  assert.strictEqual(newestAgeHours([at(50), at(2), at(200)], now), 2);
  assert.strictEqual(newestAgeHours([at(0), at(0)], now), Number.POSITIVE_INFINITY, 'no dates: assume the worst');
  assert.strictEqual(newestAgeHours([], now), Number.POSITIVE_INFINITY);
});

test('feeds: freshness cuts by age and by unreadable date', () => {
  const now = Date.UTC(2026, 8, 4, 12);
  const at = (h: number) => item({ published: now - h * 3_600_000 });
  assert.strictEqual(isFresh(at(1), 36, now), true);
  assert.strictEqual(isFresh(at(36), 36, now), true);
  assert.strictEqual(isFresh(at(37), 36, now), false);
  assert.strictEqual(isFresh(item({ published: 0 }), 36, now), false, 'undated: can\'t say it\'s fresh');
  assert.strictEqual(isFresh(item({ published: 0 }), 0, now), true, 'filter off: everything passes');
  assert.strictEqual(isFresh(at(-6), 36, now), true, 'a time-zone slip into the future is fine');
  assert.strictEqual(isFresh(at(-24 * 365), 36, now), false, 'an absurd future date is not');
});

test('feeds: the junk filter kills filler and respects real news', () => {
  const re = new RegExp(JUNK_TITLE_FILTER, 'i');
  for (const t of [
    'Las ofertas de Amazon que más están llamando la atención: hasta un 57% menos',
    'Cupón diario de la ONCE: comprobar sorteo del miércoles 2 de septiembre',
    'Consulta tu horóscopo de este miércoles',
    'La joya oculta que rescató a la animación de Disney del abismo',
    'Juanjo, mecánico: "Viendo cosas así, doy la razón al que dice"',
    'Las protestas por todo el país, en imágenes',
    'Última hora de la entrada de inmigrantes a Ceuta, en directo',
    'Los 5 trucos para dormir mejor',
  ]) assert.ok(re.test(t), `should be dropped: ${t}`);
  // The false positives that each cost a version of the pattern.
  for (const t of [
    'La matriz de Glovo apoya la oferta de Uber para comprar la compañía',
    'Samsung presenta las Bespoke AI: más capacidad y hasta un 70% menos de consumo',
    'El informe de la Policía apunta que agentes marroquíes guiaron la entrada',
    'Uber despedirá a 3.300 empleados, el 10% de su plantilla',
  ]) assert.ok(!re.test(t), `should NOT be dropped: ${t}`);
});
