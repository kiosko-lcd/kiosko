#!/usr/bin/env node
/**
 * `agent-sessions-hook [--provider claude|gemini|…]`: reads one hook event
 * from stdin and updates the session's file. Wire it as a command hook in your
 * CLI's settings. It exits 0 whatever happens: a failing hook must never get
 * in the way of the session it observes.
 */
import { providerFromArgs, runHook } from './hook.ts';

process.on('uncaughtException', () => process.exit(0));

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
try {
  runHook(Buffer.concat(chunks).toString('utf8'), providerFromArgs(process.argv.slice(2)));
} catch {
  // Never fail loudly.
}
