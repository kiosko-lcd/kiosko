import { test } from 'node:test';
import assert from 'node:assert/strict';
import { age, demoMergeRequests, graphqlUrl, parseMergeRequests, pipelineLook, shortRef } from './gitlab.ts';
import plugin from './index.ts';

const node = (ref: string, status: string | null, extra = {}) => ({
  reference: ref, title: 'Draft: a fix', draft: false, createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-02T10:00:00Z',
  author: { username: 'ana' }, approvedBy: { nodes: [] }, headPipeline: status ? { status } : null, ...extra,
});

test('merge requests: own and to review from one query', () => {
  const d = parseMergeRequests(JSON.stringify({ data: { currentUser: { username: 'me', authoredMergeRequests: { nodes: [node('g/web-app!1740', 'FAILED')] }, reviewRequestedMergeRequests: { nodes: [node('g/integration-tests!120', null, { approvedBy: { nodes: [{ username: 'me' }] } })] } } } }));
  assert.equal(d.me, 'me');
  assert.equal(d.authored[0]!.title, 'a fix', 'without the Draft: prefix');
  assert.equal(d.authored[0]!.pipeline, 'FAILED');
  assert.equal(d.toReview[0]!.pipeline, null);
  assert.deepEqual(d.toReview[0]!.approvedBy, ['me']);
  assert.throws(() => parseMergeRequests(JSON.stringify({ errors: [{ message: 'forbidden' }] })), /forbidden/);
  assert.throws(() => parseMergeRequests(JSON.stringify({ data: { currentUser: null } })), /not logged in/);
});

test('short references, age and pipeline looks', () => {
  assert.equal(shortRef('g/web-app!1740'), 'web-app!1740');
  assert.equal(shortRef('g/integration-tests!120'), 'integrati…!120');
  assert.equal(shortRef('g/integration-tests!120', { 'integration-tests': 'itest' }), 'itest!120');
  const now = Date.parse('2026-10-11T10:00:00Z');
  const times = ['2026-10-11T07:00:00Z', '2026-10-08T10:00:00Z', '2026-09-20T10:00:00Z', '2025-07-30T10:00:00Z'];
  assert.deepEqual(times.map((t) => age(t, now, 'es')), ['3 h', '3 d', '3 sem', '1 a']);
  assert.deepEqual(times.map((t) => age(t, now, 'en')), ['3 h', '3 d', '3 wk', '1 y']);
  const colors = { alert: 'r', warn: 'a', info: 'b', ok: 'v', inkDim: 'g' };
  assert.ok(pipelineLook('FAILED', colors).rank < pipelineLook('RUNNING', colors).rank && pipelineLook('RUNNING', colors).rank < pipelineLook('SUCCESS', colors).rank);
  assert.deepEqual(pipelineLook(null, colors).label, { en: 'no CI', es: 'sin CI' });
  assert.equal(pipelineLook('WAITING_FOR_RESOURCE', colors).color, 'a');
});

test('GraphQL endpoint from the host option', () => {
  assert.equal(graphqlUrl(''), 'https://gitlab.com/api/graphql');
  assert.equal(graphqlUrl('gitlab.example.com/'), 'https://gitlab.example.com/api/graphql');
  assert.equal(graphqlUrl('http://localhost:8080'), 'http://localhost:8080/api/graphql');
});

test('plugin: both widgets read the shared source and have demo data for it', () => {
  const demo = demoMergeRequests(Date.now());
  assert.ok(demo.authored.length && demo.toReview.length);
  assert.equal(plugin.sources?.[0]?.id, 'merge-requests');
  for (const w of plugin.widgets ?? []) {
    assert.deepEqual(w.sources, ['gitlab/merge-requests']);
    assert.ok(w.icon && w.category && w.size?.preferred, w.id);
    assert.ok(w.demo!({ options: w.options!.default, now: Date.now(), locale: "en" }).sources?.['gitlab/merge-requests'], w.id);
  }
  const token = (plugin.sources?.[0]?.options as { props: Record<string, { secret?: boolean }> }).props.token;
  assert.equal(token?.secret, true);
});
