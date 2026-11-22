import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHttp } from '@kiosko/sdk';
import { kioskoReleaseNotes, NOTES_MAX_CHARS, releasePage, trimNotes, versionsBetween } from './kiosko-release.ts';

const release = (v: string, o: Record<string, unknown> = {}) => ({
  tag_name: `v${v}`,
  name: `Kiosko ${v}`,
  body: `## What's Changed\n* Thing ${v} by @Loksly in https://github.com/kiosko-lcd/kiosko/pull/1`,
  html_url: releasePage(v),
  published_at: '2026-11-22T08:45:59Z',
  assets: [
    { name: `Kiosko-Setup-${v}-x64.exe`, browser_download_url: `https://github.com/kiosko-lcd/kiosko/releases/download/v${v}/Kiosko-Setup-${v}-x64.exe` },
    { name: `Kiosko-Setup-${v}-x64.exe.sha256`, browser_download_url: `https://github.com/kiosko-lcd/kiosko/releases/download/v${v}/Kiosko-Setup-${v}-x64.exe.sha256` },
  ],
  ...o,
});

const github = (answer: () => Response) => createHttp({ fetch: (async () => answer()) as typeof fetch });

test('kioskoReleaseNotes: the releases after the running one up to the newest, newest first, with the installer of the newest', async () => {
  const list = [release('0.3.0'), release('0.2.9'), release('0.2.8'), release('0.3.1-beta.1', { prerelease: true }), release('0.2.10', { draft: true }), { tag_name: 'nightly' }];
  const n = await kioskoReleaseNotes('0.2.8', '0.3.0', { http: github(() => new Response(JSON.stringify(list))), npmVersions: ['0.2.9', '0.3.0'] });
  assert.equal(n.from, 'github');
  assert.deepEqual(n.releases.map((r) => r.version), ['0.3.0', '0.2.9'], 'not the running one, no drafts, no pre-releases');
  assert.match(n.releases[0]!.body!, /Thing 0\.3\.0/);
  assert.equal(n.releases[0]!.url, 'https://github.com/kiosko-lcd/kiosko/releases/tag/v0.3.0');
  assert.deepEqual(n.windows, {
    name: 'Kiosko-Setup-0.3.0-x64.exe',
    exe: 'https://github.com/kiosko-lcd/kiosko/releases/download/v0.3.0/Kiosko-Setup-0.3.0-x64.exe',
    sha256: 'https://github.com/kiosko-lcd/kiosko/releases/download/v0.3.0/Kiosko-Setup-0.3.0-x64.exe.sha256',
  });
});

test('kioskoReleaseNotes: GitHub unreachable (mainland China) → npm\'s versions with links, never a failure', async () => {
  const n = await kioskoReleaseNotes('0.2.8', '0.3.0', { http: github(() => { throw new Error('connect ETIMEDOUT'); }), npmVersions: ['0.3.0', '0.2.9', '0.2.8', '0.2.7'] });
  assert.equal(n.from, 'npm');
  assert.match(n.error!, /ETIMEDOUT/);
  assert.deepEqual(n.releases, [{ version: '0.3.0', url: releasePage('0.3.0') }, { version: '0.2.9', url: releasePage('0.2.9') }]);
  assert.equal(n.windows, undefined);
  // Not JSON, or not a list (an error page): the same.
  assert.equal((await kioskoReleaseNotes('0.2.8', '0.3.0', { http: github(() => new Response('{"message":"API rate limit exceeded"}')) })).from, 'npm');
  assert.equal((await kioskoReleaseNotes('0.2.8', '0.3.0', { http: github(() => new Response('<html>')) })).from, 'npm');
});

test('kioskoReleaseNotes: a version npm has but GitHub has no release for is still listed; foreign links and assets are not trusted', async () => {
  const list = [release('0.3.0', { html_url: 'https://evil.example/x', assets: [{ name: 'Kiosko-Setup-0.3.0-x64.exe', browser_download_url: 'https://evil.example/k.exe' }, { name: 'Kiosko-Setup-0.3.0-x64.exe.sha256', browser_download_url: 'https://evil.example/k.sha256' }] })];
  const n = await kioskoReleaseNotes('0.2.8', '0.3.0', { http: github(() => new Response(JSON.stringify(list))), npmVersions: ['0.2.9', '0.3.0'] });
  assert.deepEqual(n.releases.map((r) => r.version), ['0.3.0', '0.2.9']);
  assert.equal(n.releases[0]!.url, releasePage('0.3.0'));
  assert.equal(n.releases[1]!.body, undefined);
  assert.equal(n.windows, undefined);
});

test('trimNotes: long notes are cut at a line end and say so; template comments go', () => {
  const long = Array.from({ length: 400 }, (_, i) => `* change number ${i}`).join('\n');
  const t = trimNotes(`<!-- hidden -->\r\n${long}`);
  assert.equal(t.truncated, true);
  assert.ok(t.body.length <= NOTES_MAX_CHARS);
  assert.ok(t.body.endsWith(t.body.split('\n').at(-1)!) && /\d$/.test(t.body), 'ends at a whole line');
  assert.ok(!t.body.includes('hidden'));
  assert.deepEqual(trimNotes('short'), { body: 'short', truncated: false });
});

test('versionsBetween: stable versions after the running one up to the newest', () => {
  assert.deepEqual(versionsBetween(['0.2.7', '0.2.8', '0.2.9', '0.2.10-rc.1', '0.2.10', '0.3.0'], '0.2.8', '0.2.10'), ['0.2.10', '0.2.9']);
});
