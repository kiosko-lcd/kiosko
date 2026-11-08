/**
 * The few words painted inside the scene (sign boards, speech bubbles, the
 * meeting door, floor tags), in the user's language. Spanish is the original;
 * anything else falls back to English.
 */
const pad = (n: number) => String(n).padStart(2, '0');

export interface Words {
  /** Sign board of the cat that asks for permission. */
  mayI: string;
  asksPermission: string;
  /** Bubble of the cat that waits for you. */
  goOn: string;
  meeting: string;
  /** Meeting starting now / in a while. */
  now: string;
  inTime: (t: string) => string;
  /** "+3 more" tag when not every cat fits. */
  more: string;
  uncommitted: string;
  ready: string;
  waiting: string;
  /** Printed on the cardboard box. */
  fragile: string;
  hiss: string;
  /** Under the SHIP IT poster of the office. */
  notOnFriday: string;
  /** Elapsed time with minute granularity: seconds on a panel would lie. */
  elapsed: (ms: number) => string;
  // The quarter-hour duel.
  duelTitle: string;
  versus: (a: string, b: string) => string;
  wins: (name: string) => string;
  theBug: string;
  bugHadNoChance: string;
  uncommittedFiles: (n: number) => string;
  onPoints: string;
}

function elapsed(nowWord: string) {
  return (ms: number): string => {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return nowWord;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${pad(m % 60)}`;
    return `${Math.floor(h / 24)}d ${pad(h % 24)}h`;
  };
}

const ES: Words = {
  mayI: '¿PUEDO?',
  asksPermission: 'pide permiso',
  goOn: '¿sigo?',
  meeting: 'REUNIÓN',
  now: 'ahora',
  inTime: (t) => `en ${t}`,
  more: 'más',
  uncommitted: 'sin commit',
  ready: 'lista',
  waiting: 'espera',
  fragile: 'FRÁGIL',
  hiss: '¡FFFF!',
  notOnFriday: '(el viernes no)',
  elapsed: elapsed('ahora'),
  duelTitle: 'DUELO DEL CUARTO DE HORA',
  versus: (a, b) => `${a}  contra  ${b}`,
  wins: (n) => `Gana ${n}`,
  theBug: 'el bug',
  bugHadNoChance: 'el bug no tenía nada que hacer',
  uncommittedFiles: (n) => `${n === 0 ? 'ningún fichero' : n === 1 ? 'un fichero' : `${n} ficheros`} sin commit`,
  onPoints: 'a los puntos',
};

const EN: Words = {
  mayI: 'MAY I?',
  asksPermission: 'asks for permission',
  goOn: 'go on?',
  meeting: 'MEETING',
  now: 'now',
  inTime: (t) => `in ${t}`,
  more: 'more',
  uncommitted: 'uncommitted',
  ready: 'ready',
  waiting: 'waiting',
  fragile: 'FRAGILE',
  hiss: 'HSSSS!',
  notOnFriday: '(not on Fridays)',
  elapsed: elapsed('now'),
  duelTitle: 'QUARTER-HOUR DUEL',
  versus: (a, b) => `${a}  vs  ${b}`,
  wins: (n) => `${n} wins`,
  theBug: 'the bug',
  bugHadNoChance: 'the bug never stood a chance',
  uncommittedFiles: (n) => `${n === 0 ? 'no' : n === 1 ? 'one' : n} uncommitted file${n === 1 ? '' : 's'}`,
  onPoints: 'on points',
};

export function wordsFor(locale: string): Words {
  return locale.toLowerCase().startsWith('es') ? ES : EN;
}

/** Compact countdown: `45m`, `1h 05m`. */
export function countdown(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m >= 60) return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
  return `${m}m`;
}
