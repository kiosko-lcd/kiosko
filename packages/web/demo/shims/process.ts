/**
 * The `process` global, for code that reads `process.env` or
 * `process.platform` (injected by the demo build wherever `process` is
 * used). Quiet logs, and a home folder that is never written to.
 */
export const process = {
  env: { KIOSKO_QUIET: '1', KIOSKO_HOME: '/kiosko-demo' } as Record<string, string | undefined>,
  platform: 'browser',
  argv: [] as string[],
  versions: {} as Record<string, string>,
  cwd: () => '/',
};
