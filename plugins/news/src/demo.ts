/**
 * A believable deck for the gallery and the editor: no network, fictional
 * outlets and generic stories. Photos are `demo:<scene>` URLs, painted
 * procedurally by `demophoto.ts`.
 */
import type { Weather } from '@loksly/weather-astro';
import { clusterStories } from './cluster.ts';
import type { NewsItem } from './feeds.ts';
import type { NewsDeck } from './index.ts';

const MIN = 60_000;

function item(source: string, title: string, summary: string, scene: string, agoMin: number, now: number, slug: string): NewsItem {
  return { source, title, summary, image: `demo:${scene}`, link: `https://example.org/${slug}`, published: now - agoMin * MIN };
}

export function demoDeck(now: number): NewsDeck {
  const items: NewsItem[] = [
    item('La Crónica', 'El puerto amplía su terminal de contenedores y prevé duplicar el tráfico de mercancías en cinco años',
      'La obra, que arrancará en primavera, gana 40 hectáreas al mar y añade seis grúas. La autoridad portuaria calcula 2.000 empleos directos durante la construcción.', 'harbour', 12, now, 'puerto-1'),
    item('Diario Costa', 'El puerto amplía la terminal de contenedores para duplicar el tráfico de mercancías',
      'El proyecto suma seis grúas y 40 hectáreas ganadas al mar.', 'harbour', 25, now, 'puerto-2'),
    item('Noticias 24', 'La terminal de contenedores del puerto crecerá para duplicar el tráfico de mercancías',
      'Las navieras celebran la decisión; los vecinos piden un estudio de ruido.', 'harbour', 41, now, 'puerto-3'),
    item('Noticias 24', 'El metro funcionará toda la noche durante las fiestas de fin de año',
      'Las líneas principales abrirán sin interrupción del 24 de diciembre al 6 de enero, con trenes cada quince minutos a partir de la una.', 'city', 48, now, 'metro'),
    item('La Crónica', 'Los molinos de la meseta ya producen: la primera fase del parque eólico abastecerá a 90.000 hogares',
      'Los 32 aerogeneradores instalados hasta ahora vierten a la red desde esta semana; la segunda fase se licita en enero.', 'field', 95, now, 'eolico-1'),
    item('Diario Costa', 'El parque eólico de la meseta empieza a producir con retraso: su primera fase llega a 90.000 hogares en invierno',
      'Los promotores atribuyen la demora a la falta de transformadores.', 'field', 130, now, 'eolico-2'),
    item('Tecnología Hoy IA', 'Un modelo de lenguaje abierto iguala a los grandes en tareas de programación',
      'El equipo publica los pesos y los datos de evaluación; en pruebas independientes resuelve el 71% de los problemas, cerca de los sistemas comerciales.', 'city', 180, now, 'modelo-abierto'),
  ];
  const stories = clusterStories(items).sort((a, b) => b.consensus - a.consensus || b.lead.published - a.lead.published);
  return { stories, updated: now - 3 * MIN, failed: [] };
}

/** The little the news corner needs, in case the weather plugin isn't there to give its demo. */
export function demoCornerWeather(now: number): Weather {
  return {
    place: 'Madrid', temp: 14, feels: 12, code: 2, humidity: 60, wind: 10, night: false,
    days: [{ date: new Date(now).toISOString().slice(0, 10), code: 2, min: 6, max: 16, rain: 10 }],
    hours: [], fetched: now - 5 * MIN,
  };
}
