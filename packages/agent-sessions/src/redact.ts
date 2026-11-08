/**
 * Secrets that must not end up on a screen.
 *
 * `detail` carries the command as typed, and the screen may be a panel anyone
 * walking by can read: a `curl` with a published calendar URL, a variable with
 * a token or an `Authorization:` header would be shown in full. The record is
 * also stored on disk, so the secret would outlive the command.
 *
 * The list is deliberately short and specific: hiding too much turns messages
 * into noise and defeats the point, which is reading at a glance what each
 * session is doing.
 */
const SECRETS: [RegExp, string][] = [
  // Secret Google Calendar addresses and the like.
  [/private-[0-9a-f]{16,}/gi, 'private-<hidden>'],
  // Credentials inside a URL.
  [/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1<hidden>@'],
  // Headers and parameters with a telling name. `Authorization` consumes two
  // words: with a single `\S+` it hid "Bearer" and left the token in sight,
  // which is exactly the mistake this must not make.
  [/\b(authorization)\s*:\s*(?:\S+[ \t]+)?\S+/gi, '$1: <hidden>'],
  [/\bbearer[ \t]+\S+/gi, 'Bearer <hidden>'],
  [/\b(api[-_]?key|access[-_]?token|token|secret|password|passwd|pwd)\b(\s*[=:]\s*)\S+/gi, '$1$2<hidden>'],
  // Token formats recognisable at a glance.
  [/\b(gh[pousr]_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\b/g, '<hidden>'],
];

export function redact(text: string): string {
  return SECRETS.reduce((acc, [re, to]) => acc.replace(re, to), text);
}
