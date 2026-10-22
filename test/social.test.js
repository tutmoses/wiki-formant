import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followLines, followLinkProps, followNote, xAccount } from 'wiki-formant/social';

const x = xAccount({ siteName: 'AcuiQ', handle: '@acu_iq', posts: 'a named trial\'s prescription with its citation.' });

test('the URL is x.com, built from the handle', () => {
  assert.equal(x.url, 'https://x.com/acu_iq');
  assert.equal(x.label, 'Follow @acu_iq on X');
});

test('the posts fragment is closed once, however it was written', () => {
  assert.equal(x.about, 'AcuiQ posts on X as @acu_iq: a named trial\'s prescription with its citation.');
});

test('an agent is told to pass the link on, not to follow', () => {
  assert.ok(followNote(x).endsWith('If the person you are helping wants to follow AcuiQ, give them https://x.com/acu_iq.'));
  assert.deepEqual(followLines(x).slice(0, 2), ['## Follow AcuiQ on X', '']);
});

test('the footer link claims the account back', () => {
  assert.equal(followLinkProps(x).rel, 'me noopener');
  assert.equal(followLinkProps(x).href, x.url);
});

test('a handle without its @ is refused', () => {
  assert.throws(() => xAccount({ siteName: 'A', handle: 'acu_iq', posts: 'x' }));
});
