/**
 * The cats room: every AI agent session is a cat in a room with a real sky,
 * and what needs you comes forward (a sign board for a permission, a cat
 * staring at you when it waits, a sleeper in a box when it's done, a cat at
 * its laptop, back turned, while it works). Ported from aimonitor's
 * "modo gatos".
 *
 * Plus an interlude: the quarter-hour lightsaber duel between two sessions.
 */
import { definePlugin, defineInterlude, defineWidget, t, type Localized } from '@tessera/sdk';
import { sunTimes, type SunTimes, type Weather } from '@loksly/weather-astro';
import { useCanvas } from './canvas.ts';
import { DUEL_FPS, planDuel, prerenderDuel } from './duel-egg.ts';
import { ROOMS, type RoomName } from './room.ts';
import { renderScene, type SceneOptions } from './scene.ts';
import type { SessionView, SessionsData } from './types.ts';
import { wordsFor } from './words.ts';

const ROOM_LABELS: Record<'rotate' | RoomName, Localized> = {
  rotate: { en: 'A different one every day', es: 'Una distinta cada día' },
  estudio: { en: 'Study', es: 'Estudio' },
  cocina: { en: 'Kitchen', es: 'Cocina' },
  cabana: { en: 'Log cabin', es: 'Cabaña' },
  atico: { en: 'Attic', es: 'Ático' },
  oficina: { en: 'Office', es: 'Oficina' },
  japonesa: { en: 'Japanese room', es: 'Habitación japonesa' },
  acuario: { en: 'Aquarium', es: 'Acuario' },
  arcade: { en: 'Arcade', es: 'Recreativos' },
  ventanal: { en: 'Picture window', es: 'Ventanal' },
  playa: { en: 'Beach', es: 'Playa' },
  espacio: { en: 'Outer space', es: 'Espacio' },
  antartida: { en: 'Antarctica', es: 'Antártida' },
  desierto: { en: 'Desert', es: 'Desierto' },
  bosque: { en: 'Forest', es: 'Bosque' },
};

const COLUMN = { none: 'none', right: 'derecha', left: 'izquierda', alternate: 'alternar' } as const;

const roomOptions = t.object({
  room: t.enum(['rotate', ...ROOMS] as const, {
    label: { en: 'Room', es: 'Habitación' },
    help: { en: 'Indoors or out, each with its own window, lamp and floor.', es: 'Dentro o fuera, cada una con su ventana, su lámpara y su suelo.' },
    labels: ROOM_LABELS,
  }),
  column: t.enum(['none', 'right', 'left', 'alternate'] as const, {
    label: { en: 'Strip without cats', es: 'Franja sin gatos' },
    help: {
      en: 'Keeps a strip of the floor free, like the old card column. "Alternate" swaps sides now and then, against burn-in.',
      es: 'Deja libre una franja del suelo, como la antigua columna de tarjetas. «Alternar» cambia de lado cada cierto tiempo, contra el quemado.',
    },
    labels: {
      none: { en: 'None', es: 'Ninguna' },
      right: { en: 'Right', es: 'Derecha' },
      left: { en: 'Left', es: 'Izquierda' },
      alternate: { en: 'Alternate', es: 'Alternar' },
    },
  }),
  swapSidesMs: t.duration({ default: 60 * 60_000, min: 60_000, label: { en: 'Swap sides every', es: 'Cambiar de lado cada' }, advanced: true }),
  zombieMinutes: t.integer({
    default: 15, min: 1, max: 240, unit: 'min', advanced: true,
    label: { en: 'Silent session looks dead after', es: 'Una sesión callada parece muerta tras' },
    help: { en: 'A working session silent for half of this turns into Schrödinger\'s box.', es: 'Una sesión trabajando que calla la mitad de esto se convierte en la caja de Schrödinger.' },
  }),
});

type RoomOptions = (typeof roomOptions)['default'];

function sceneOptions(o: RoomOptions): SceneOptions {
  return { room: o.room, column: COLUMN[o.column], swapSidesMs: o.swapSidesMs, zombieMs: o.zombieMinutes * 60_000 };
}

const sessionsOf = (sources: Record<string, unknown>): SessionView[] => {
  const d = sources['agents/sessions'] as SessionsData | undefined;
  return Array.isArray(d?.sessions) ? d.sessions : [];
};

/** Sunrise and sunset for the sky: the reading's coordinates first, then the user's place. */
function sunFor(now: number, weather: Weather | undefined, location: { latitude: number; longitude: number } | undefined): SunTimes | null {
  const lat = weather?.latitude ?? location?.latitude;
  const lon = weather?.longitude ?? location?.longitude;
  return lat === undefined || lon === undefined ? null : sunTimes(new Date(now), lat, lon);
}

// ---------- Demo ----------
const MIN = 60_000;

function demoSession(now: number, id: string, project: string, state: SessionView['state'], sinceMin: number, extra: Partial<SessionView> = {}): SessionView {
  return {
    schemaVersion: 1,
    session_id: id,
    provider: 'claude',
    state,
    detail: '',
    project,
    cwd: `/home/dev/src/${project}`,
    repo: `/home/dev/src/${project}`,
    since: now - sinceMin * MIN,
    started: now - (sinceMin + 30) * MIN,
    updated: now - Math.min(sinceMin * MIN, 20_000),
    event: 'PreToolUse',
    ...extra,
  };
}

export function demoSessions(now: number): SessionView[] {
  return [
    demoSession(now, 'demo-api-7f3a', 'api', 'permission', 2, { detail: 'Bash: npm publish', event: 'PermissionRequest' }),
    demoSession(now, 'demo-web-1c9e', 'web-app', 'waiting', 6, { event: 'Stop' }),
    demoSession(now, 'demo-infra-8c07', 'infra', 'active', 18, { detail: 'Edit: modules/network/main.tf', duck: true }),
    demoSession(now, 'demo-docs-9d11', 'docs', 'ready', 9, { event: 'Stop' }),
  ];
}

export function demoWeather(now: number): Weather {
  return {
    place: 'Madrid', latitude: 40.4168, longitude: -3.7038, temp: 17, feels: 16, code: 2, humidity: 58, wind: 12, night: false,
    days: [{ date: new Date(now).toISOString().slice(0, 10), code: 2, min: 9, max: 19, rain: 10 }],
    hours: [], fetched: now - 5 * MIN,
  };
}

export const room = defineWidget({
  id: 'room',
  name: { en: 'Cats room', es: 'Habitación de gatos' },
  description: {
    en: 'Each AI agent session is a cat in a room with the real sky outside: the ones that need you come forward, the ones working sit at their laptops in the back.',
    es: 'Cada sesión de un agente IA es un gato en una habitación con el cielo de verdad: los que te necesitan se acercan y los que trabajan se quedan al fondo con su portátil.',
  },
  icon: 'cat',
  category: 'scene',
  tags: ['agents', 'claude', 'gemini', 'illustration'],
  chrome: 'bare',
  size: { min: { w: 960, h: 300 }, preferred: { w: 1920, h: 462 } },
  options: roomOptions,
  sources: ['agents/sessions', 'weather/current'],
  // The wall clock moves every minute.
  redraw: 'minute',
  idle: ({ sources }) => !sessionsOf(sources).some((s) => s.startsAt === undefined),
  render(g, ctx) {
    const { box, now, options, sources } = ctx;
    useCanvas(ctx.canvas);
    const weather = sources['weather/current'] as Weather | undefined;
    const width = Math.max(1, Math.round(box.w)), height = Math.max(1, Math.round(box.h));
    const frame = renderScene({
      sessions: sessionsOf(sources),
      now,
      width,
      height,
      options: sceneOptions(options),
      words: wordsFor(ctx.locale),
      weather: weather ?? null,
      sun: sunFor(now, weather, ctx.location),
    });
    g.drawImage(frame, box.x, box.y, box.w, box.h);
  },
  demo: ({ now }) => ({ sources: { 'agents/sessions': { sessions: demoSessions(now) }, 'weather/current': demoWeather(now) } }),
});

export const duel = defineInterlude({
  id: 'duel',
  name: { en: 'Quarter-hour duel', es: 'Duelo del cuarto de hora' },
  description: {
    en: 'Two of your sessions fight it out with lightsabers in the cats room. The one with fewer uncommitted files wins. With a single session, it fights the bug.',
    es: 'Dos de tus sesiones se baten con espadas de luz en la habitación de los gatos. Gana la que tiene menos ficheros sin commit. Con una sola, se bate con el bug.',
  },
  icon: 'swords',
  options: t.object({ room: roomOptions.props.room }),
  sources: ['agents/sessions', 'weather/current'],
  fps: DUEL_FPS,
  async prepare(ctx) {
    useCanvas(ctx.canvas);
    const weather = ctx.sources['weather/current'] as Weather | undefined;
    const words = wordsFor(ctx.locale);
    const plan = planDuel(sessionsOf(ctx.sources), ctx.now, words);
    if (!plan) return null;
    const input = { plan, width: ctx.width, height: ctx.height, now: ctx.now, room: ctx.options.room, words, weather: weather ?? null, sun: sunFor(ctx.now, weather, ctx.location) };
    return prerenderDuel(input, ctx.canvas);
  },
  // Not over something that needs you: a permission or a session waiting.
  skip: ({ sources }) => sessionsOf(sources).some((s) => s.state === 'permission' || s.state === 'waiting'),
});

export default definePlugin({
  id: 'cats',
  name: { en: 'Cats room', es: 'Habitación de gatos' },
  version: '0.1.0',
  description: {
    en: 'Your AI agent sessions as cats in a room: what needs you comes forward. From aimonitor.',
    es: 'Tus sesiones de agentes IA como gatos en una habitación: lo que te reclama se acerca. De aimonitor.',
  },
  author: 'Tessera',
  license: 'MIT',
  icon: 'cat',
  widgets: [room],
  interludes: [duel],
});
