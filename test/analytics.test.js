import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcpCallProps, plausibleDomain } from '../dist/analytics.js';

const req = (headers = {}, url = 'https://x.test/api/mcp') => ({
  url,
  headers: { get: (k) => headers[k] ?? null },
});

test('a tool call is attributed to its method and tool name', () => {
  const props = mcpCallProps(
    req({ 'user-agent': 'ClaudeBot' }),
    { method: 'tools/call', params: { name: 'search_wiki' } },
    'radix-wiki',
  );
  assert.deepEqual(props, {
    server: 'radix-wiki',
    method: 'tools/call',
    tool: 'search_wiki',
    ua: 'ClaudeBot',
  });
});

test('a batch is attributed to its first member, not counted once per member', () => {
  const props = mcpCallProps(
    req(),
    [
      { method: 'tools/call', params: { name: 'get_ledger' } },
      { method: 'tools/call', params: { name: 'get_page' } },
    ],
    'caper',
  );
  assert.equal(props.tool, 'get_ledger');
});

test('an untrusted body never throws and never omits a prop', () => {
  for (const body of [null, undefined, [], 'nonsense', 42, { params: { name: 7 } }]) {
    const props = mcpCallProps(req(), body, 's');
    assert.equal(props.method, 'unknown');
    assert.equal(props.server, 's');
    assert.equal(props.ua, 'unknown');
    assert.equal('tool' in props, false);
  }
});

test('a long user agent is truncated rather than sent whole', () => {
  const props = mcpCallProps(req({ 'user-agent': 'x'.repeat(500) }), {}, 's');
  assert.equal(props.ua.length, 80);
});

test('a single-server site records no server prop to disambiguate', () => {
  const props = mcpCallProps(req(), { method: 'initialize' });
  assert.equal('server' in props, false);
  assert.equal(props.method, 'initialize');
});

test('the domain is the hostname, and a bad URL falls back rather than throwing', () => {
  assert.equal(plausibleDomain('https://radix.wiki/some/path', 'fallback.test'), 'radix.wiki');
  assert.equal(plausibleDomain(undefined, 'https://caper.network'), 'caper.network');
  assert.equal(plausibleDomain('not a url', 'acuiq.com'), 'acuiq.com');
});
