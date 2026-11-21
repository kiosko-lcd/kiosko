import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { editorCommand, editorUrl } from './editor-cli.ts';

test('the editor address: the config, the flags over it, a wildcard host reached locally', () => {
  assert.equal(editorUrl({ host: '127.0.0.1', port: 7420 }), 'http://127.0.0.1:7420/');
  assert.equal(editorUrl({ host: '0.0.0.0', port: 7420 }, { port: '8000' }), 'http://127.0.0.1:8000/');
  assert.equal(editorUrl({ host: '::', port: 7420 }), 'http://[::1]:7420/');
  assert.equal(editorUrl({ host: '127.0.0.1', port: 7420 }, { host: 'kiosko.lan' }), 'http://kiosko.lan:7420/');
});

test('kiosko editor: opens the running one, explains when none answers', async () => {
  const srv = createServer((req, res) => {
    res.writeHead(req.url === '/api/state' ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version: '9.9.9' }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  try {
    const run = async (flags: { print: boolean; port?: string }) => {
      const opened: string[] = [], lines: string[] = [];
      const code = await editorCommand({ server: { host: '127.0.0.1', port }, flags, open: (u) => opened.push(u), log: (l) => lines.push(l) });
      return { code, opened, lines };
    };
    const up = await run({ print: false });
    assert.equal(up.code, 0);
    assert.deepEqual(up.opened, [`http://127.0.0.1:${port}/`]);
    assert.match(up.lines[0]!, /Kiosko 9\.9\.9/);
    assert.deepEqual((await run({ print: true })).opened, [], '--print opens nothing');
    srv.close();
    await new Promise((r) => srv.once('close', r));
    const down = await run({ print: false });
    assert.equal(down.code, 1);
    assert.deepEqual(down.opened, []);
    assert.match(down.lines.join('\n'), /isn't running[\s\S]*kiosko start --open[\s\S]*kiosko service install/);
  } finally {
    srv.close();
  }
});
