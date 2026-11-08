/**
 * Default feeds and headline filters, from aimonitor's news panel. Every rule
 * here was measured against the real feeds; the notes say why it is the way it
 * is, so nobody "simplifies" it back into a known bug.
 */
import type { FeedSource } from './feeds.ts';

/**
 * AI headlines. There's no Spanish AI feed with a photo per article, so the
 * topic is taken from general technology feeds with this regex: zero AI to
 * talk about AI. Two groups: brands and products (unambiguous) and generic
 * terms (`IA`, `LLM`…), case-sensitive so `IA` doesn't match inside words.
 */
export const AI_TITLE_FILTER =
  '\\b(?:[Aa]nthropic|[Cc]laude|[Cc]hat[Gg]PT|[Oo]pen[Aa][Ii]|[Gg]emini|[Dd]eep[Mm]ind|' +
  '[Cc]opilot|[Mm]idjourney|[Dd]eep[Ss]eek|[Mm]istral [Aa][Ii]|[Pp]erplexity|[Ll]lama \\d|[Gg]rok|' +
  'inteligencia artificial|IA|IAs|AI|LLMs?|chatbots?|modelo de lenguaje|language model|red neuronal|neural network|superinteligencia)\\b';

/**
 * Maximum age of AI items, in hours. Technology feeds aren't chronological
 * like a front page: they mix this morning with features from months ago, and
 * matching the topic without a date limit filled the screen with stale AI.
 * 36 h is the measured balance: less starves weekends, more lets last week in.
 */
export const AI_MAX_AGE_HOURS = 36;

/** General maximum age: a safety net so a frozen outlet doesn't keep showing the day before yesterday. */
export const DEFAULT_MAX_AGE_HOURS = 72;

/**
 * Order matters: `dedupe` keeps the **first** appearance of an article, and
 * with it its source label, which is the key for taking turns. Topic feeds go
 * first, or their AI items would compete in the general front page's queue.
 * Topic feeds are named "<Outlet> IA" (see `publisherOf`).
 */
export const DEFAULT_FEEDS: FeedSource[] = [
  { name: 'Xataka IA', url: 'https://feeds.weblogssl.com/xataka2', titleFilter: AI_TITLE_FILTER, maxAgeHours: AI_MAX_AGE_HOURS },
  { name: 'Hipertextual IA', url: 'https://hipertextual.com/feed', titleFilter: AI_TITLE_FILTER, maxAgeHours: AI_MAX_AGE_HOURS },
  { name: '20minutos IA', url: 'https://www.20minutos.es/rss/tecnologia/', titleFilter: AI_TITLE_FILTER, maxAgeHours: AI_MAX_AGE_HOURS },
  { name: 'Omicrono IA', url: 'https://www.elespanol.com/rss/omicrono/', titleFilter: AI_TITLE_FILTER, maxAgeHours: AI_MAX_AGE_HOURS },
  { name: 'elDiario.es', url: 'https://www.eldiario.es/rss/' },
  { name: '20minutos', url: 'https://www.20minutos.es/rss/' },
  { name: 'El País', url: 'https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada' },
  { name: 'La Vanguardia', url: 'https://www.lavanguardia.com/rss/home.xml' },
  { name: 'El Mundo', url: 'https://e00-elmundo.uecdn.es/elmundo/rss/portada.xml' },
  { name: 'ABC', url: 'https://www.abc.es/rss/2.0/portada/' },
];

/**
 * Headlines not worth a turn on a screen read at a glance: affiliate
 * advertorials, lottery results, clickbait, galleries, live blogs, listicles.
 * Compiled case-insensitive. Deliberately conservative: a dull story goes away
 * in thirty seconds, an important one that's never shown doesn't come back.
 * (`oferta` alone killed real economy news; `\d+% menos` killed a real
 * product launch: shop context is required instead.)
 */
export const JUNK_TITLE_FILTER = [
  // Advertorials and affiliates.
  '\\b(?:amazon|aliexpress|chollo|descuentazo|superventas|el corte ingl[eé]s',
  '|black friday|c[óo]digo promocional|por menos de \\d+ ?(?:euros|€)',
  '|merece la pena comprar|he probado (?:el|la|los|las)|comprar[íi]as)\\b',
  // Services: draws, horoscopes, results.
  '|\\b(?:euromillones|primitiva|bonoloto|loter[íi]a|sorteo|hor[óo]scopo|quiniela',
  '|cup[óo]n diario|comprobar (?:el|tu)|n[úu]meros premiados)\\b',
  // Clickbait vocabulary.
  '|\\b(?:la joya oculta|joya escondida|lo que nadie|nadie te (?:cuenta|dice)',
  '|no te lo vas a creer|te sorprender|vas a alucinar|el truco|este truco|los trucos',
  '|la raz[óo]n por la que|el motivo por el que|as[íi] es como|esto es lo que (?:pasa|hace|ocurre)',
  '|y no es lo que|el secreto (?:de|que)|dile adi[óo]s|te cambiar[áa] la vida',
  '|estas son las claves|las claves para)\\b',
  // Galleries and virals.
  '|\\b(?:en im[áa]genes|en fotos|las mejores fotos|foto a foto|el v[íi]deo viral',
  '|se hace viral|arrasa en (?:tiktok|redes)|revoluciona las redes)\\b',
  // Live blogs: their headline changes by itself and says nothing.
  '|\\b(?:en directo|minuto a minuto|s[íi]guelo en vivo|[úu]ltima hora de)\\b',
  // Recommendation lists.
  '|\\b(?:series recomendadas|pel[íi]culas recomendadas|las mejores series|recomendadas para)\\b',
  // "Name, job: «quote»" — filler testimonials.
  '|^[a-záéíóúñ]+, [a-záéíóúñ ]{3,28}: ["“\']',
  // "Las 7 claves de…", "Los 5 trucos para…"
  '|^(?:las?|los?) \\d+ (?:claves|cosas|razones|trucos|mejores|secretos|motivos)\\b',
].join('');
