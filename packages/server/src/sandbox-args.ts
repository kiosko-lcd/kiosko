/** `--sandbox [dir]` and `--sandbox-allow-*` on the command line (and KIOSKO_SANDBOX* in the environment). No side effects. */
import type { SandboxAllow } from '@kiosko/core/sandbox';

/** The CLI's commands: a word after `--sandbox` that is one of these is the command, not the folder. */
const COMMANDS = new Set(['start', 'editor', 'render', 'import-aimonitor', 'config', 'doctor', 'usb', 'remote', 'gallery', 'plugins', 'service', 'self-check', 'version', 'help', 'sandbox']);

export interface SandboxArgs {
  /** Whether a sandbox was asked for (`--sandbox`, or KIOSKO_SANDBOX). */
  on: boolean;
  dir?: string;
  allow: SandboxAllow[];
  /** The arguments without `--sandbox [dir]`, for the rest of the CLI. */
  argv: string[];
}

export function parseSandboxArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): SandboxArgs {
  const rest: string[] = [];
  let on = false;
  let dir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--sandbox') {
      on = true;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-') && !COMMANDS.has(next)) {
        dir = next;
        i++;
      }
    } else if (a.startsWith('--sandbox=')) {
      on = true;
      dir = a.slice('--sandbox='.length) || undefined;
    } else rest.push(a);
  }
  if (!on && env.KIOSKO_SANDBOX) on = true;
  if (on && !dir && env.KIOSKO_SANDBOX) dir = env.KIOSKO_SANDBOX;
  const allow = new Set<SandboxAllow>(
    (env.KIOSKO_SANDBOX_ALLOW ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is SandboxAllow => s === 'usb' || s === 'remote' || s === 'lan'),
  );
  for (const w of ['usb', 'remote', 'lan'] as const) if (rest.includes(`--sandbox-allow-${w}`)) allow.add(w);
  return { on, ...(dir ? { dir } : {}), allow: [...allow], argv: rest };
}

