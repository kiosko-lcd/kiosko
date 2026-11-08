const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Time spent in a state, in large type. Minute granularity on purpose: the
 * widget repaints once a minute, so seconds on screen would lie with false
 * precision; and "18 min" reads at a glance better than "18:07".
 * `nowWord` is the localized word for "less than a minute".
 */
export function elapsed(ms: number, nowWord = 'now'): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return nowWord;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${pad(m % 60)}`;
  return `${Math.floor(h / 24)}d ${pad(h % 24)}h`;
}

/** Compact countdown (meetings, window resets). */
export function countdown(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m >= 60) return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
  return `${m}m`;
}

export function clock(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Short, stable id to recognise the console on its tile. */
export function shortId(sessionId: string): string {
  return sessionId.replace(/-/g, '').slice(0, 6).toUpperCase();
}

/** Size in whole GB, the unit people think RAM and disks in. */
export function gigabytes(bytes: number): string {
  return `${Math.round(bytes / 1024 ** 3)}GB`;
}
