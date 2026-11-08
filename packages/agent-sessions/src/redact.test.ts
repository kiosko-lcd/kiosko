import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from './redact.ts';

test('Hook: the secret disappears; the label showing up is not enough', () => {
  // The check is that **the secret is gone**. Looking only for "<hidden>" lets
  // through the case where the neighbouring word is hidden instead: that is how
  // "Bearer" got hidden while the whole token stayed in sight, with the test green.
  const cases: [string, string][] = [
    [
      'curl https://calendar.google.com/calendar/ical/x%40gmail.com/private-0f1e2d3c4b5a69788796a5b4c3d2e1f0/basic.ics',
      '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
    ],
    ['curl -H "Authorization: Bearer abc123def456ghi789"', 'abc123def456ghi789'],
    ['curl -H "Authorization: abc123def456ghi789"', 'abc123def456ghi789'],
    ['curl --header "X-Auth: Bearer abc123def456ghi789"', 'abc123def456ghi789'],
    ['export API_KEY=sk-abcdefghijklmnopqrstuvwx', 'sk-abcdefghijklmnopqrstuvwx'],
    ['psql https://user:hunter2pass@db.example.com/x', 'hunter2pass'],
    ['git push https://ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345@github.com/x', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'],
    ['aws --key AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
    ['TOKEN=ghs_verylongandsecrethere1234 npm publish', 'ghs_verylongandsecrethere1234'],
  ];
  for (const [input, secret] of cases) {
    const output = redact(input);
    assert.ok(!output.includes(secret), `the secret survived: ${output}`);
    assert.ok(output.includes('<hidden>'), `the redaction was not marked: ${output}`);
  }
});

test('Hook: does not over-redact — the panel must stay readable', () => {
  // Over-redacting turns the messages into noise and defeats the point of the panel.
  for (const clean of [
    'Edit src/render.ts',
    'Bash: npm run build && systemctl --user restart aimonitor.service',
    'Read /srv/notes/private-notes.md',
    'Grep "registerFromPath" in src/',
  ]) {
    assert.equal(redact(clean), clean, `hid something it should not have: ${clean}`);
  }
});

test('Hook: redacts before truncating, so half a secret cannot slip through', async () => {
  const long = `curl ${'x'.repeat(300)} private-0f1e2d3c4b5a69788796a5b4c3d2e1f0`;
  assert.ok(!redact(long).includes('0f1e2d3c4b5a69788796a5b4c3d2e1f0'));
});
