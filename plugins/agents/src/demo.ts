/**
 * Sample sessions for the gallery, the editor and the tests: the scenarios
 * the old dashboard was designed against, with generic names. Times are
 * relative to `now` so the elapsed counters read the same in any preview.
 */
import type { Provider, SessionState, SessionView } from './types.ts';

const s = (n: number) => n * 1000;
const min = (n: number) => n * 60_000;

interface Spec {
  id: string;
  project: string;
  state: SessionState;
  detail: string;
  provider?: Provider;
  /** How long ago it entered its state. */
  ago: number;
  dirty?: number;
  /** How long ago the record was written; `ago` by default. */
  updatedAgo?: number;
}

function rec(spec: Spec, now: number): SessionView {
  return {
    schemaVersion: 1,
    session_id: spec.id,
    provider: spec.provider ?? 'claude',
    state: spec.state,
    detail: spec.detail,
    project: spec.project,
    cwd: `/home/user/dev/${spec.project}`,
    since: now - spec.ago,
    updated: now - (spec.updatedAgo ?? spec.ago),
    event: 'PreToolUse',
    ...(spec.dirty !== undefined ? { dirty: spec.dirty } : {}),
  };
}

export type ScenarioName = 'empty' | 'one' | 'two' | 'threeClaim' | 'quiet' | 'longNames' | 'overflow' | 'meeting';

/** `threeClaim` is the one that matters: it's the case the three weights exist for. */
export function scenario(name: ScenarioName, now: number): SessionView[] {
  const r = (spec: Spec) => rec(spec, now);
  switch (name) {
    case 'empty':
      return [];
    case 'one':
      return [r({ id: 'a1b2c3d4-1111', project: 'api-gateway', state: 'active', detail: 'Edit src/routes/orders.ts', ago: s(12), dirty: 4 })];
    case 'two':
      return [
        r({ id: 'a1b2c3d4-1111', project: 'web-app', state: 'permission', detail: 'Bash: npm publish', ago: min(2) + s(18), dirty: 3 }),
        r({ id: 'b2c3d4e5-2222', project: 'api-gateway', state: 'active', detail: 'Read src/adapters/payments/client.ts', ago: s(24), dirty: 0 }),
      ];
    case 'threeClaim':
      return [
        r({ id: 'a1b2c3d4-1111', project: 'infra', state: 'permission', detail: 'Bash: sudo systemctl restart nginx --no-block', ago: min(3) + s(41), dirty: 2 }),
        r({ id: 'b2c3d4e5-2222', project: 'web-app', state: 'waiting', detail: 'Waiting for your input', ago: min(18) + s(7), dirty: 11, provider: 'gemini' }),
        r({ id: 'c3d4e5f6-3333', project: 'api-gateway', state: 'ready', detail: 'Stop', ago: min(1) + s(4), dirty: 0, provider: 'gemini' }),
        r({ id: 'd4e5f6a7-4444', project: 'docs-site', state: 'active', detail: 'Grep "createServer"', ago: s(9), dirty: 1 }),
      ];
    case 'quiet':
      return [
        r({ id: 'b8c9d0e1-8888', project: 'api-gateway', state: 'active', detail: 'Bash: npm run build', ago: s(31), dirty: 6 }),
        r({ id: 'c9d0e1f2-9999', project: 'web-app', state: 'idle', detail: 'SessionStart', ago: min(42), dirty: 0, provider: 'gemini' }),
      ];
    case 'longNames':
      return [
        r({ id: 'e5f6a7b8-5555', project: 'infrastructure-terraform-production', state: 'permission', detail: 'Write /etc/systemd/system/app-worker.service with a rather long unit file that will not fit', ago: min(7) + s(22), dirty: 37 }),
        r({ id: 'f6a7b8c9-6666', project: 'frontend-monorepo-customer-portal', state: 'ready', detail: 'SubagentStop', ago: min(2), dirty: 0, provider: 'gemini' }),
        r({ id: 'a7b8c9d0-7777', project: 'x', state: 'active', detail: 'Read package.json', ago: s(3), dirty: 0 }),
      ];
    case 'overflow':
      return [
        r({ id: 'd0e1f2a3-aaaa', project: 'infra', state: 'permission', detail: 'Bash: kubectl rollout restart deploy/api', ago: min(5) + s(13), dirty: 2 }),
        r({ id: 'e1f2a3b4-bbbb', project: 'web-app', state: 'waiting', detail: 'idle_prompt', ago: min(11), dirty: 11, provider: 'gemini' }),
        r({ id: 'f2a3b4c5-cccc', project: 'api-gateway', state: 'waiting', detail: 'permission needed for MCP', ago: min(4) + s(51), dirty: 3 }),
        r({ id: 'a3b4c5d6-dddd', project: 'docs-site', state: 'ready', detail: 'Stop', ago: s(48), dirty: 1, provider: 'gemini' }),
        r({ id: 'b4c5d6e7-eeee', project: 'notes', state: 'ready', detail: 'Stop', ago: min(3), dirty: 0 }),
        r({ id: 'c5d6e7f8-ffff', project: 'scraper', state: 'active', detail: 'WebFetch example.com', ago: s(6), dirty: 0, provider: 'gemini' }),
        r({ id: 'd6e7f8a9-0001', project: 'bench', state: 'active', detail: 'Bash: pytest -q', ago: s(22), dirty: 4 }),
        r({ id: 'e7f8a9b0-0002', project: 'archive', state: 'idle', detail: 'SessionStart', ago: min(30), dirty: 0, provider: 'gemini' }),
      ];
    case 'meeting':
      return [
        {
          schemaVersion: 1,
          session_id: 'meeting-1',
          provider: 'calendar',
          state: 'waiting',
          detail: '',
          project: 'Architecture review',
          since: now + min(4),
          updated: now,
          event: 'Meeting',
          startsAt: now + min(4),
          endsAt: now + min(64),
        },
        r({ id: 'a1b2c3d4-1111', project: 'web-app', state: 'permission', detail: 'Bash: npm publish', ago: min(2), dirty: 3 }),
        r({ id: 'b2c3d4e5-2222', project: 'api-gateway', state: 'active', detail: 'Read src/transport.ts', ago: s(24), dirty: 0 }),
      ];
  }
}

/** Fixed vitals for the summary strip's RAM figure. */
export const DEMO_VITALS = {
  cpuTemp: 61,
  cpuUsage: 0.23,
  mem: { used: 44 * 1024 ** 3, total: 62 * 1024 ** 3 },
};
