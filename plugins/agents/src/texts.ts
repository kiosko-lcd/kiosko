/**
 * User-facing words of the agents widgets. Kept together so a new language
 * is one file.
 */
import type { Localized } from '@tessera/sdk';
import type { SessionState } from './types.ts';

/**
 * Small-caps label of each state. No emoji on purpose: the panel fonts are
 * DejaVu, without emoji glyphs; colour and weight already say the state.
 */
export const STATE_LABEL: Record<SessionState, Localized> = {
  permission: { en: 'Permission', es: 'Permiso' },
  waiting: { en: 'Waiting', es: 'Espera' },
  ready: { en: 'Ready', es: 'Listo' },
  active: { en: 'Active', es: 'Activa' },
  idle: { en: 'Idle', es: 'Inactiva' },
};

export const TEXT = {
  now: { en: 'now', es: 'ahora' },
  meeting: { en: 'Meeting', es: 'Reunión' },
  gitClean: { en: 'git clean', es: 'git limpio' },
  gitDirty: { en: 'git {n} uncommitted', es: 'git {n} sin commit' },
  more: { en: '+{n} more', es: '+{n} más' },
  consoles: { en: '{n} consoles', es: '{n} consolas' },
  console: { en: '1 console', es: '1 consola' },
  waitingMany: { en: '{n} waiting for you', es: '{n} te esperan' },
  waitingOne: { en: '1 waiting for you', es: '1 te espera' },
  nobody: { en: 'nobody waiting', es: 'nadie espera' },
  noSessions: { en: 'No agent sessions', es: 'Sin sesiones de agentes' },
} satisfies Record<string, Localized>;

/** Replaces `{name}` placeholders. */
export function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
}
