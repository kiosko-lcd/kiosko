/**
 * Did the tests fail? The hook checks after every shell command that looks
 * like a test run, reading its output. Pure and cheap: it is on the path of
 * every tool call.
 *
 * It is a heuristic over text, not a verdict: when unclear it says nothing
 * (null) and the previous value is kept.
 */
export const TEST_COMMAND = /\b(npm (run )?test|pnpm test|yarn test|pytest|vitest|jest|cargo test|go test|node --test|mvn test|gradle test|phpunit|rspec)\b/;

const FAIL = [
  /\b[1-9]\d* (failed|failing|failures?|errors?)\b/i,
  /^ℹ fail [1-9]/m,
  /^not ok\b/m,
  /\bFAIL(ED)?\b/,
  /\bTests?:\s+[1-9]\d* failed/i,
  /^✖ /m,
];
const OK = [/\b0 failed\b/i, /^ℹ fail 0\b/m, /\b\d+ passed\b/i, /\ball tests passed\b/i, /\bOK \(\d+ tests?\)/, /\btest result: ok\b/];

function text(response: unknown): string {
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object') {
    const o = response as Record<string, unknown>;
    return [o.stdout, o.stderr, o.output, o.result].filter((v) => typeof v === 'string').join('\n') || JSON.stringify(response).slice(0, 50_000);
  }
  return '';
}

/** 'fail', 'ok', or null if this was not a test run or the output is unclear. */
export function testOutcome(event: string, tool: string, input: unknown, response: unknown): 'fail' | 'ok' | null {
  if (event !== 'PostToolUse' || !/^(Bash|run_shell_command)$/.test(tool)) return null;
  const cmd = input && typeof input === 'object' ? String((input as Record<string, unknown>).command ?? '') : '';
  if (!TEST_COMMAND.test(cmd)) return null;
  const r = response && typeof response === 'object' ? (response as Record<string, unknown>) : {};
  const code = [r.exit_code, r.exitCode, r.returnCode, r.code].find((v) => typeof v === 'number') as number | undefined;
  if (code !== undefined) return code === 0 ? 'ok' : 'fail';
  const out = text(response).slice(-50_000);
  if (!out) return null;
  // "0 failed" wins over a stray FAIL inside a test name.
  if (OK.some((re) => re.test(out)) && !/\b[1-9]\d* failed\b/i.test(out) && !/^ℹ fail [1-9]/m.test(out)) return 'ok';
  if (FAIL.some((re) => re.test(out))) return 'fail';
  return null;
}

/**
 * Did the last shell command fail? Claude Code reports non-zero exits with the
 * `PostToolUseFailure` event (it has to be in the hooks); Gemini and others
 * carry the exit code in the response. A rebase with conflicts is also
 * recognised by its text. null = it was not a shell command.
 */
export function commandFailed(event: string, tool: string, input: unknown, response: unknown): boolean | null {
  if (!/^(Bash|run_shell_command)$/.test(tool)) return null;
  if (event === 'PostToolUseFailure') return true;
  if (event !== 'PostToolUse') return null;
  const r = response && typeof response === 'object' ? (response as Record<string, unknown>) : {};
  const code = [r.exit_code, r.exitCode, r.returnCode, r.code].find((v) => typeof v === 'number') as number | undefined;
  if (code !== undefined) return code !== 0;
  const cmd = input && typeof input === 'object' ? String((input as Record<string, unknown>).command ?? '') : '';
  if (/\bgit\s+rebase\b/.test(cmd) && /\b(CONFLICT|could not apply|error: )/.test(text(response).slice(-20_000))) return true;
  return false;
}
