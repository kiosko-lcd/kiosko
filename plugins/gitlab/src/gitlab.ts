/**
 * Your open merge requests and the ones waiting for your review, from a
 * single GraphQL query to GitLab: through the `glab` CLI (already logged in)
 * or, with a token, straight over HTTPS. Shared by `pipelines` and `reviews`
 * as one source, so both cards cost one call.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Localized } from '@tessera/sdk';

const execFileAsync = promisify(execFile);

export type PipelineStatus = 'FAILED' | 'RUNNING' | 'PENDING' | 'CREATED' | 'PREPARING' | 'WAITING_FOR_RESOURCE' | 'SCHEDULED' | 'MANUAL' | 'SUCCESS' | 'CANCELED' | 'SKIPPED' | (string & {});

export interface MergeRequest {
  /** `group/project!123`. */
  reference: string;
  title: string;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  author: string;
  approvedBy: string[];
  pipeline: PipelineStatus | null;
}

export interface MyMergeRequests {
  me: string;
  authored: MergeRequest[];
  toReview: MergeRequest[];
}

export const QUERY = `{ currentUser { username
  authoredMergeRequests(state: opened, first: 50) { nodes { reference(full: true) title draft createdAt updatedAt author { username } approvedBy { nodes { username } } headPipeline { status } } }
  reviewRequestedMergeRequests(state: opened, first: 50) { nodes { reference(full: true) title draft createdAt updatedAt author { username } approvedBy { nodes { username } } headPipeline { status } } } } }`;

interface Node {
  reference: string;
  title: string;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  author?: { username?: string };
  approvedBy?: { nodes?: { username: string }[] };
  headPipeline?: { status?: string } | null;
}

export function parseMergeRequests(json: string): MyMergeRequests {
  const d = JSON.parse(json) as { errors?: { message?: string }[]; data?: { currentUser?: { username: string; authoredMergeRequests?: { nodes: Node[] }; reviewRequestedMergeRequests?: { nodes: Node[] } } | null } };
  if (d.errors?.length) throw new Error(d.errors[0]?.message ?? 'GraphQL error');
  const u = d.data?.currentUser;
  if (!u) throw new Error('not logged in to GitLab (no current user)');
  const map = (n: Node): MergeRequest => ({
    reference: n.reference,
    title: n.title.replace(/^Draft:\s*/i, ''),
    draft: n.draft,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    author: n.author?.username ?? '',
    approvedBy: (n.approvedBy?.nodes ?? []).map((a) => a.username),
    pipeline: n.headPipeline?.status ?? null,
  });
  return { me: u.username, authored: (u.authoredMergeRequests?.nodes ?? []).map(map), toReview: (u.reviewRequestedMergeRequests?.nodes ?? []).map(map) };
}

/** `gitlab.example.com` → `https://gitlab.example.com/api/graphql`. */
export function graphqlUrl(host: string): string {
  const h = (host.trim() || 'gitlab.com').replace(/\/+$/, '');
  return `${/^https?:\/\//.test(h) ? h : `https://${h}`}/api/graphql`;
}

export interface Connection {
  /** The `glab` command, used when there is no token. */
  bin: string;
  /** GitLab host; empty = glab's default, or gitlab.com with a token. */
  host: string;
  /** Personal access token (read_api). Empty = use glab. */
  token: string;
}

export async function readMergeRequests(c: Connection, signal: AbortSignal): Promise<MyMergeRequests> {
  if (c.token.trim()) {
    const res = await fetch(graphqlUrl(c.host), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.token.trim()}` },
      body: JSON.stringify({ query: QUERY }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    if (!res.ok) throw new Error(`GitLab HTTP ${res.status}`);
    return parseMergeRequests(await res.text());
  }
  const args = ['api', 'graphql', '-f', `query=${QUERY}`, ...(c.host.trim() ? ['--hostname', c.host.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')] : [])];
  const { stdout } = await execFileAsync(c.bin || 'glab', args, { timeout: 20_000, maxBuffer: 8_000_000, signal });
  return parseMergeRequests(stdout);
}

/** `group/web-app!412` → `web-app!412`; aliases (by project name) win; long names are cut. */
export function shortRef(reference: string, aliases: Record<string, string> = {}): string {
  const [path = '', iid = ''] = reference.split('!');
  const project = path.split('/').pop() ?? path;
  const name = aliases[project] ?? aliases[path] ?? project;
  return `${name.length > 10 ? `${name.slice(0, 9)}…` : name}!${iid}`;
}

/** "3 h", "2 d", "5 wk", "1 y" (Spanish: "5 sem", "1 a"): age at a glance. */
export function age(iso: string, now: number, locale = 'en'): string {
  const es = /^es(?:$|[-_])/i.test(locale);
  const h = Math.max(0, (now - Date.parse(iso)) / 3_600_000);
  if (h < 24) return `${Math.max(1, Math.round(h))} h`;
  const d = h / 24;
  if (d < 14) return `${Math.round(d)} d`;
  if (d < 365) return `${Math.round(d / 7)} ${es ? 'sem' : 'wk'}`;
  return `${Math.round(d / 365)} ${es ? 'a' : 'y'}`;
}

export interface Look {
  label: Localized;
  color: string;
  /** Sort order: broken first. */
  rank: number;
}

/** How each pipeline status is called and coloured; `rank` puts what's broken first. */
export function pipelineLook(status: PipelineStatus | null, colors: { alert: string; warn: string; info: string; ok: string; inkDim: string }): Look {
  switch (status) {
    case 'FAILED': return { label: { en: 'failed', es: 'falla' }, color: colors.alert, rank: 0 };
    case 'RUNNING': return { label: { en: 'running', es: 'en curso' }, color: colors.info, rank: 1 };
    case 'PENDING': case 'CREATED': case 'PREPARING': case 'WAITING_FOR_RESOURCE': case 'SCHEDULED': return { label: { en: 'queued', es: 'en cola' }, color: colors.warn, rank: 2 };
    case 'MANUAL': return { label: { en: 'manual', es: 'manual' }, color: colors.warn, rank: 3 };
    case 'SUCCESS': return { label: { en: 'passed', es: 'ok' }, color: colors.ok, rank: 4 };
    case 'CANCELED': return { label: { en: 'canceled', es: 'cancelado' }, color: colors.inkDim, rank: 5 };
    case 'SKIPPED': return { label: { en: 'skipped', es: 'saltado' }, color: colors.inkDim, rank: 5 };
    default: return { label: { en: 'no CI', es: 'sin CI' }, color: colors.inkDim, rank: 6 };
  }
}

/** Sample data for the gallery: made-up projects and people. */
export function demoMergeRequests(now: number): MyMergeRequests {
  const ago = (h: number) => new Date(now - h * 3_600_000).toISOString();
  const mr = (reference: string, title: string, pipeline: PipelineStatus | null, createdH: number, extra: Partial<MergeRequest> = {}): MergeRequest => ({
    reference, title, draft: false, createdAt: ago(createdH), updatedAt: ago(createdH / 3), author: 'you', approvedBy: [], pipeline, ...extra,
  });
  return {
    me: 'you',
    authored: [
      mr('acme/web-app!412', 'Fix the flaky login test', 'FAILED', 30),
      mr('acme/api!88', 'Rate-limit the public endpoints', 'RUNNING', 6),
      mr('acme/docs!31', 'Update the onboarding guide', 'PENDING', 50),
      mr('acme/web-app!405', 'Dark mode toggle in settings', 'SUCCESS', 120),
      mr('acme/mobile!17', 'Offline sync for drafts', 'MANUAL', 200, { draft: true }),
    ],
    toReview: [
      mr('acme/api!91', 'Cache user permissions per request', 'RUNNING', 26, { author: 'sam' }),
      mr('acme/infra!12', 'Rotate the staging certificates', 'FAILED', 3, { author: 'jordan' }),
      mr('acme/web-app!398', 'Move the charts to the new library', 'SUCCESS', 130, { author: 'alex', approvedBy: ['you'] }),
    ],
  };
}
