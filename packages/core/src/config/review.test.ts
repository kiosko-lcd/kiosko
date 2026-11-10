import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffConfigs, summarizeDiff } from './diff.ts';
import { plugins } from './fixtures.test.ts';
import { newPage, newScreen, newTile, newWidget, type Config } from './model.ts';
import { normalize } from './normalize.ts';
import { isPlaceholder, listRisks, mergeSecrets, planImport, riskOf } from './review.ts';
import { configSchema } from './schema.ts';

const schema = configSchema(plugins);

const feed = (id: string, options: Record<string, unknown>) => ({ id, type: 'demo/feed', options });
const withWidgets = (widgets: object[], extra: object = {}) =>
  normalize({ ...extra, screens: [{ id: 's', pages: [{ id: 'p', tiles: widgets.map((w, i) => ({ id: `t${i}`, x: i * 6, y: 0, w: 6, h: 3, widgets: [w] })) }] }] });

test('placeholders: empty, <…>, ${…}, TODO, CHANGEME, your-token…', () => {
  for (const v of ['', '  ', '<token>', 'https://x/<id>/cal.ics', '${GITLAB_TOKEN}', 'TODO', 'CHANGEME', 'your-api-key', 'YOUR_TOKEN', 'xxxx', 'https://outlook.office365.com/owa/calendar/…/calendar.ics', undefined]) assert.ok(isPlaceholder(v), String(v));
  for (const v of ['glpat-abc123', 'https://todoist.com/feed', 'sk-1234', 'changeme-not-really-but-lowercase']) assert.ok(!isPlaceholder(v), v);
});

test('risky values are found by kind, with secrets hidden and new ones marked', () => {
  const before = withWidgets([feed('w1', { url: 'https://old.example/feed', cmd: 'tool' })]);
  const after = withWidgets(
    [
      feed('w1', { url: 'https://new.example/feed', cmd: 'tool', file: '~/notes.md', src: 'https://cams.example/a.jpg', token: 'abc' }),
      feed('w2', { src: '/home/me/pic.png', url: '<feed url>' }),
    ],
    { sources: { 'demo/remote': { host: 'api.example', urls: ['https://cal.example/private/SECRET.ics', ''] } } },
  );
  const risks = listRisks(after, schema, before);
  const rows = risks.map((r) => [r.risk, r.path, r.shown, r.isNew]);
  assert.deepEqual(rows, [
    ['network', 'sources["demo/remote"].host', 'api.example', true],
    ['network', 'sources["demo/remote"].urls[0]', 'https://cal.example/… (secret, rest hidden)', true],
    ['network', 'screens[0].pages[0].tiles[0].widgets[0].options.url', 'https://new.example/feed', true],
    ['exec', 'screens[0].pages[0].tiles[0].widgets[0].options.cmd', 'tool', false],
    ['path', 'screens[0].pages[0].tiles[0].widgets[0].options.file', '~/notes.md', true],
    ['network', 'screens[0].pages[0].tiles[0].widgets[0].options.src', 'https://cams.example/a.jpg', true],
    ['path', 'screens[0].pages[0].tiles[1].widgets[0].options.src', '/home/me/pic.png', true],
  ]);
  assert.equal(risks.find((r) => r.risk === 'exec')!.isDefault, true);
  assert.equal(risks.find((r) => r.risk === 'exec')!.context, 'demo/feed');
  // Top-level values are risky too: where frames go, background images.
  const top = listRisks(normalize({ screens: [{ device: { driver: 'file', dir: '/srv/frames' }, pages: [{ background: { image: 'https://x.example/bg.png' } }] }] }), schema);
  assert.deepEqual(
    top.map((r) => [r.risk, r.path]),
    [
      ['path', 'screens[0].device.dir'],
      ['network', 'screens[0].pages[0].background.image'],
    ],
  );
  assert.equal(riskOf(['network', 'path'], 'file:///etc/passwd'), 'path');
  assert.equal(riskOf(['exec', 'network'], 'https://x'), 'exec');
});

const current = withWidgets([feed('w1', { token: 'widget-secret' })], {
  sources: {
    'demo/remote': {
      host: 'git.example.com',
      token: 'source-secret',
      urls: ['https://cal.example/a.ics', 'https://cal.example/b.ics'],
      endpoints: [
        { name: 'box', url: 'http://10.0.0.1:11434', token: 'box-secret' },
        { name: 'gpu', url: 'http://10.0.0.2:8000', token: 'gpu-secret' },
      ],
    },
  },
});
const remote = (cfg: unknown) => (cfg as Config).sources['demo/remote'] as Record<string, any>;

test('secrets left empty or as placeholders keep the current value, matched by id', () => {
  // The widget moved to another tile and page: its id still finds its token.
  const incoming = {
    sources: { 'demo/remote': { host: 'git.example.com', token: '<token>', urls: ['<ICS address>'], endpoints: [{ name: 'box', url: 'http://10.0.0.1:11434', token: '' }] } },
    screens: [{ id: 's', pages: [{ id: 'other', tiles: [{ id: 'x', x: 0, y: 0, w: 6, h: 3, widgets: [feed('w1', { token: 'CHANGEME' })] }] }] }],
  };
  const m = mergeSecrets(incoming, current, schema);
  assert.equal(remote(m.config).token, 'source-secret');
  assert.deepEqual(remote(m.config).urls, ['https://cal.example/a.ics', 'https://cal.example/b.ics']);
  assert.equal(remote(m.config).endpoints[0].token, 'box-secret');
  assert.equal((m.config as any).screens[0].pages[0].tiles[0].widgets[0].options.token, 'widget-secret');
  assert.deepEqual(m.kept.map((k) => k.path).sort(), [
    'screens[0].pages[0].tiles[0].widgets[0].options.token',
    'sources["demo/remote"].endpoints[0].token',
    'sources["demo/remote"].token',
    'sources["demo/remote"].urls[0]',
    'sources["demo/remote"].urls[1]',
  ]);
  assert.deepEqual(m.toFill, []);
  assert.deepEqual(m.provided, []);
});

test('a secret is not kept when the host next to it changed, nor invented when there is none', () => {
  const incoming = {
    sources: {
      'demo/remote': {
        host: 'evil.example',
        token: '',
        // Reordered: the first endpoint is now the gpu box, so box's token must not follow it.
        endpoints: [
          { name: 'gpu', url: 'http://10.0.0.2:8000', token: '<token>' },
          { name: 'new', url: 'http://10.0.0.9:1234', token: '${NEW_TOKEN}' },
        ],
      },
    },
    screens: [{ pages: [{ tiles: [{ widgets: [feed('w9', { token: 'TODO' })] }] }] }],
  };
  const m = mergeSecrets(incoming, current, schema);
  const r = remote(m.config);
  assert.equal(r.token, '');
  assert.equal(r.endpoints[0].token, '');
  assert.equal(r.endpoints[1].token, '');
  assert.equal((m.config as any).screens[0].pages[0].tiles[0].widgets[0].options.token, '');
  // The calendar list was left out of a source that is still there: it is kept whole.
  assert.deepEqual(r.urls, ['https://cal.example/a.ics', 'https://cal.example/b.ics']);
  assert.deepEqual(
    m.kept.map((k) => k.path),
    ['sources["demo/remote"].urls[0]', 'sources["demo/remote"].urls[1]'],
  );
  const fill = Object.fromEntries(m.toFill.map((f) => [f.path, f.note ?? '']));
  assert.match(fill['sources["demo/remote"].token']!, /its host changed \("git\.example\.com" → "evil\.example"\)/);
  assert.match(fill['sources["demo/remote"].endpoints[0].token']!, /its url changed/);
  assert.match(fill['sources["demo/remote"].endpoints[1].token']!, /its url changed \("http:\/\/10\.0\.0\.2:8000" → "http:\/\/10\.0\.0\.9:1234"\)/);
  assert.equal(fill['screens[0].pages[0].tiles[0].widgets[0].options.token'], '');
});

test('secrets the file leaves out are kept; secrets it carries are reported', () => {
  const m = mergeSecrets({ sources: { 'demo/remote': { host: 'git.example.com', endpoints: [] } }, screens: [] }, current, schema);
  assert.equal(remote(m.config).token, 'source-secret');
  assert.ok(m.kept.some((k) => k.path === 'sources["demo/remote"].token'));
  const p = mergeSecrets({ sources: { 'demo/remote': { token: 'glpat-from-the-file' } } }, current, schema);
  assert.deepEqual(
    p.provided.map((x) => x.path),
    ['sources["demo/remote"].token'],
  );
  assert.equal(remote(p.config).token, 'glpat-from-the-file');
});

test('the diff summary names screens, pages, tiles and sources', () => {
  const s = newScreen('Desk', 1920, 462);
  s.id = 'desk';
  const home = s.pages[0]!;
  home.id = 'home';
  home.name = 'Home';
  home.tiles = [newTile({ x: 0, y: 0, w: 6, h: 3 }, [newWidget('demo/clock')]), newTile({ x: 6, y: 0, w: 6, h: 3 }, [newWidget('demo/feed')])];
  const before = normalize({ theme: 'midnight', sources: { 'demo/remote': { host: 'a' } }, screens: [s, newScreen('Old', 480, 480)] });
  const after = structuredClone(before);
  after.theme = 'paper';
  after.sources['demo/remote'] = { host: 'b' };
  after.screens.pop();
  const desk = after.screens[0]!;
  desk.pages[0]!.tiles.splice(1, 1);
  desk.pages[0]!.tiles[0]!.w = 12;
  desk.pages[0]!.tiles.push(newTile({ x: 0, y: 3, w: 6, h: 3 }, [newWidget('demo/feed', { url: 'https://x' })]));
  const news = newPage('News', 1920, 462, [newTile({ x: 0, y: 0, w: 24, h: 6 }, [newWidget('demo/feed')])]);
  desk.pages.push(news);
  const lines = diffConfigs(before, after).map((l) => `${'  '.repeat(l.depth)}${l.op} ${l.text}`);
  assert.deepEqual(lines, [
    '~ theme: "midnight" → "paper"',
    '~ source demo/remote: host changed',
    '- screen "Old" 480×480 (1 page)',
    '~ screen "Desk"',
    '  + page "News": 1 tile (demo/feed)',
    '  ~ page "Home"',
    '    - tile 6×3 at 6,0: demo/feed',
    '    + tile 6×3 at 0,3: demo/feed',
    '    ~ tile 12×3 at 0,0: moved/resized from 6×3 at 0,0',
  ]);
  assert.equal(summarizeDiff(diffConfigs(before, after)), '1 setting changed, 1 source changed, 1 screen removed, 1 screen changed, 1 page added, 1 page changed, 1 tile removed, 1 tile added, 1 tile changed');
  assert.equal(summarizeDiff(diffConfigs(before, before)), 'no changes');
});

test('planImport keeps what the file leaves out and validates what it has', () => {
  const cur = normalize({ ...current, location: { latitude: 1, longitude: 2 }, server: { host: '127.0.0.1', port: 7500 } });
  const plan = planImport({ theme: 'paper', screens: [{ id: 's', pages: [{ id: 'p', tiles: [] }] }] }, cur, plugins, schema);
  assert.deepEqual(plan.report.errors, []);
  assert.deepEqual(plan.carried, ['locale', 'timeFormat', 'location', 'workday', 'plugins', 'server', 'sources["demo/remote"]']);
  assert.equal(plan.config.server.port, 7500);
  assert.deepEqual(plan.config.location, { latitude: 1, longitude: 2 });
  assert.equal(remote(plan.config).token, 'source-secret');
  assert.equal(plan.config.theme, 'paper');
  // Values carried over were already there: none is new.
  assert.ok(plan.risks.every((r) => !r.isNew));
  assert.ok(plan.diff.some((l) => l.text.startsWith('theme:')));
  const bad = planImport({ screens: [{ pages: [{ tiles: [{ widgets: [{ type: 'demo/clock', options: { format: 'x' } }] }] }] }] }, cur, plugins, schema);
  assert.equal(bad.report.errors.length, 1);
});
