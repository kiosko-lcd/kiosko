/**
 * AI coding agents on the panel, ported from aimonitor: the sessions source
 * (fed by the @loksly/agent-sessions hook), the tile dashboard, its summary
 * strip and the 8-bit runner that plays every quarter hour.
 *
 * The art direction is the original's: the normal state is darkness, and
 * colour is spent only on the session that claims you.
 */
import { defineInterlude, definePlugin, defineSource, defineWidget, t } from '@tessera/sdk';
import { DEMO_VITALS, scenario } from './demo.ts';
import { drawSessions, drawSummaryStrip } from './draw.ts';
import { DEFAULT_TEXTS, levelFor, runnerPlayer } from './platformer.ts';
import { resolveDir, watchSessions } from './source.ts';
import { needsPermission, sessionsOf, SESSIONS_SOURCE, type SessionsData } from './types.ts';

export type { SessionView, SessionsData, Weight } from './types.ts';
export { assignWeights, plan, spareWidth } from './select.ts';

export const sessionsSource = defineSource({
  id: 'sessions',
  name: { en: 'AI agent sessions', es: 'Sesiones de agentes IA' },
  description: {
    en: 'Claude Code, Gemini CLI… sessions as written by the agent-sessions hook, with git status.',
    es: 'Las sesiones de Claude Code, Gemini CLI… que escribe el hook de agent-sessions, con el estado de git.',
  },
  options: t.object({
    dir: t.string({
      default: '~/.aimonitor/sessions',
      format: 'path',
      label: { en: 'Sessions folder', es: 'Carpeta de sesiones' },
      help: { en: 'Where the hook writes one JSON file per session. Empty: $AGENT_SESSIONS_DIR or ~/.aimonitor/sessions.', es: 'Donde el hook escribe un JSON por sesión. Vacío: $AGENT_SESSIONS_DIR o ~/.aimonitor/sessions.' },
    }),
    git: t.boolean({
      default: true,
      label: { en: 'Read git status', es: 'Leer el estado de git' },
      help: { en: 'Repository name and uncommitted files of each session (runs git).', es: 'Nombre del repositorio y ficheros sin commit de cada sesión (ejecuta git).' },
    }),
    zombieMs: t.duration({
      default: 15 * 60_000,
      min: 60_000,
      label: { en: 'Drop silent working sessions after', es: 'Descartar sesiones activas calladas tras' },
      help: { en: 'A session that says it is working and writes nothing for this long is dead.', es: 'Una sesión que dice estar trabajando y no escribe nada en este tiempo está muerta.' },
    }),
    staleMs: t.duration({
      default: 2 * 3_600_000,
      min: 60_000,
      label: { en: 'Drop any silent session after', es: 'Descartar cualquier sesión callada tras' },
      help: { en: 'The net under SessionEnd, which never arrives if the terminal is killed. Raise it if you leave permission prompts waiting for hours.', es: 'La red bajo SessionEnd, que no llega si se mata el terminal. Súbelo si dejas permisos esperando horas.' },
    }),
    reap: t.boolean({
      default: true,
      advanced: true,
      label: { en: 'Delete files of dead sessions', es: 'Borrar los ficheros de sesiones muertas' },
      help: { en: 'Safe: a live session writes its file again on its next event.', es: 'Es seguro: una sesión viva vuelve a escribir su fichero en el siguiente evento.' },
    }),
    debounceMs: t.integer({ default: 200, min: 0, max: 5000, unit: 'ms', advanced: true, label: { en: 'Wait for a burst of events', es: 'Esperar a que acabe una ráfaga de eventos' } }),
    pollMs: t.duration({ default: 30_000, min: 5_000, advanced: true, label: { en: 'Re-read every', es: 'Releer cada' }, help: { en: 'Fallback to file watching; also refreshes the git counts.', es: 'Respaldo de la vigilancia de ficheros; también refresca los contadores de git.' } }),
  }),
  watch(ctx, emit: (data: SessionsData) => void) {
    const o = ctx.options;
    return watchSessions({ ...o, dir: resolveDir(o.dir) }, { emit, log: ctx.log, signal: ctx.signal });
  },
  demo: ({ now }) => ({ sessions: scenario('threeClaim', now) }),
});

const sessionsOptions = t.object({
  tileMin: t.integer({ default: 320, min: 120, max: 1000, unit: 'px', label: { en: 'Narrowest tile', es: 'Casilla más estrecha' }, help: { en: 'At a 374 px tall widget; scales with the height. Sessions that would need narrower tiles go to the summary column.', es: 'Para un widget de 374 px de alto; escala con la altura. Las sesiones que no quepan van a la columna de resumen.' } }),
  tileMax: t.integer({ default: 430, min: 120, max: 2000, unit: 'px', label: { en: 'Widest tile', es: 'Casilla más ancha' }, help: { en: 'So a single session doesn’t stretch across the panel.', es: 'Para que una sola sesión no se estire a todo el panel.' } }),
  gap: t.integer({ default: 12, min: 0, max: 60, unit: 'px', label: { en: 'Gap between tiles', es: 'Separación entre casillas' } }),
  detailLines: t.integer({ default: 3, min: 1, max: 6, slider: true, label: { en: 'Detail lines', es: 'Líneas de detalle' }, help: { en: 'Lines of the last tool call or message before cutting with an ellipsis.', es: 'Líneas de la última herramienta o mensaje antes de cortar con puntos suspensivos.' } }),
  spineWidth: t.integer({ default: 7, min: 2, max: 30, unit: 'px', advanced: true, label: { en: 'Colour spine width', es: 'Ancho de la espina de color' } }),
  summaryWidth: t.integer({ default: 150, min: 80, max: 400, unit: 'px', advanced: true, label: { en: 'Summary column width', es: 'Ancho de la columna de resumen' } }),
  stretch: t.boolean({ label: { en: 'Stretch tiles to fill the width', es: 'Estirar las casillas a todo el ancho' } }),
  align: t.enum(['left', 'center', 'right'] as const, { label: { en: 'Alignment', es: 'Alineación' }, labels: { left: { en: 'Left', es: 'Izquierda' }, center: { en: 'Centre', es: 'Centro' }, right: { en: 'Right', es: 'Derecha' } } }),
  showGit: t.boolean({ default: true, label: { en: 'Show uncommitted files', es: 'Mostrar ficheros sin commit' } }),
});

export const sessionsWidget = defineWidget({
  id: 'sessions',
  name: { en: 'Agent sessions', es: 'Sesiones de agentes' },
  description: {
    en: 'One tile per AI coding session. The one that needs you most turns solid, the others that wait get a colour spine, and working ones stay dark.',
    es: 'Una casilla por sesión de IA. La que más te necesita se enciende entera, las demás que esperan llevan una espina de color y las que trabajan quedan a oscuras.',
  },
  icon: 'bot',
  category: 'agents',
  tags: ['claude', 'gemini', 'ai', 'sessions', 'git'],
  chrome: 'bare',
  size: { min: { w: 400, h: 200 }, preferred: { w: 1500, h: 390 } },
  options: sessionsOptions,
  sources: [SESSIONS_SOURCE],
  redraw: 'minute',
  render(g, ctx) {
    drawSessions(g, ctx, ctx.options);
  },
  urgent: ({ sources }) => needsPermission(sessionsOf(sources)),
  idle: ({ sources }) => sessionsOf(sources).length === 0,
  demo: ({ now }) => ({ sources: { [SESSIONS_SOURCE]: { sessions: scenario('threeClaim', now) } } }),
});

export const summaryWidget = defineWidget({
  id: 'summary',
  name: { en: 'Agents summary strip', es: 'Franja de resumen de agentes' },
  description: {
    en: 'A thin header line: RAM, how many consoles are open, how many wait for you (tinted by the most urgent) and the clock.',
    es: 'Una línea fina de cabecera: RAM, cuántas consolas hay abiertas, cuántas te esperan (teñido por la más urgente) y la hora.',
  },
  icon: 'activity',
  category: 'agents',
  tags: ['claude', 'gemini', 'header'],
  chrome: 'bare',
  size: { min: { w: 400, h: 32 }, preferred: { w: 1900, h: 60 } },
  options: t.object({
    ram: t.boolean({ default: true, label: { en: 'Show RAM', es: 'Mostrar la RAM' }, help: { en: 'Needs the system vitals source.', es: 'Necesita la fuente de vitales del sistema.' } }),
    clock: t.boolean({ default: true, label: { en: 'Show the clock', es: 'Mostrar la hora' } }),
    rule: t.boolean({ default: true, label: { en: 'Rule underneath', es: 'Raya debajo' } }),
  }),
  sources: [SESSIONS_SOURCE, 'system/vitals'],
  redraw: 'minute',
  render(g, ctx) {
    drawSummaryStrip(g, ctx, ctx.options);
  },
  idle: ({ sources }) => sessionsOf(sources).length === 0,
  demo: ({ now }) => ({ sources: { [SESSIONS_SOURCE]: { sessions: scenario('threeClaim', now) }, 'system/vitals': DEMO_VITALS } }),
});

export const runner = defineInterlude({
  id: 'runner',
  name: { en: '8-bit runner', es: 'Corredor de 8 bits' },
  description: {
    en: 'A side-scrolling platformer run through a server room, in flat colours. Every slot plays a different ending; now and then the runner ships the release.',
    es: 'Una carrera de plataformas de scroll lateral por una sala de servidores, en colores planos. Cada franja acaba distinto; de vez en cuando el corredor saca la versión.',
  },
  icon: 'gamepad',
  options: t.object({
    title: t.string({ default: DEFAULT_TEXTS.title, maxLength: 12, label: { en: 'Name in the score', es: 'Nombre en el marcador' }, help: { en: 'Letters, digits and - . ! ?', es: 'Letras, cifras y - . ! ?' } }),
  }),
  sources: [SESSIONS_SOURCE],
  fps: 12,
  async prepare(ctx) {
    if (ctx.width < 8 || ctx.height < 8) return null;
    const texts = {
      title: ctx.options.title.trim() || DEFAULT_TEXTS.title,
      world: ctx.t({ en: 'RELEASE', es: 'VERSION' }),
      level: levelFor(ctx.seed),
      time: ctx.t({ en: 'TIME', es: 'TIEMPO' }),
      retry: ctx.t({ en: 'TRY AGAIN', es: 'OTRA VEZ SERA' }),
    };
    const p = runnerPlayer(ctx.width, ctx.height, ctx.seed, texts);
    return { frames: p.frames, draw: p.draw };
  },
  // A session blocked on a permission prompt is no time to play.
  skip: ({ sources }) => needsPermission(sessionsOf(sources)),
});

export default definePlugin({
  id: 'agents',
  name: { en: 'AI agents', es: 'Agentes IA' },
  version: '0.1.0',
  description: {
    en: 'Claude Code and Gemini CLI sessions at a glance: who waits for you, for how long, and git status. Ported from aimonitor.',
    es: 'Las sesiones de Claude Code y Gemini CLI de un vistazo: quién te espera, desde cuándo y el estado de git. Portado de aimonitor.',
  },
  author: 'Tessera',
  license: 'MIT',
  icon: 'bot',
  widgets: [sessionsWidget, summaryWidget],
  sources: [sessionsSource],
  interludes: [runner],
});
