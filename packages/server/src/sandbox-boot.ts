/**
 * The first thing the CLI does (cli.ts imports it before anything else):
 * with `--sandbox [dir]` (or `KIOSKO_SANDBOX=dir` in the environment), turn
 * this process into a sandbox (core's sandbox.ts) before any module reads a
 * path from the environment. It imports only the sandbox module, which
 * imports nothing of Kiosko.
 */
import { applySandbox, type Sandbox } from '@kiosko/core/sandbox';
import { parseSandboxArgs } from './sandbox-args.ts';

const parsed = parseSandboxArgs(process.argv.slice(2));
// `kiosko sandbox list|stop` looks at the sandboxes from outside: it isn't one.
const sandboxCmd = parsed.argv[0] === 'sandbox';

/** The sandbox this process is, if any (with `created`: its folder was made now, in the temp folder). */
export const boot: { sandbox: (Sandbox & { created: boolean }) | null; argv: string[] } = {
  sandbox: parsed.on && !sandboxCmd ? applySandbox(parsed.dir, { allow: parsed.allow }) : null,
  argv: parsed.argv,
};
