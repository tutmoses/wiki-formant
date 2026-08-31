import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcpCallProps, plausibleDomain, searchQueryProps } from '../dist/analytics.js';

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

test('a search query is normalised so the same question aggregates as one row', () => {
  assert.deepEqual(searchQueryProps({ query: '  How   Do I  Vote ', results: 3 }), {
    q: 'how do i vote',
    results: '3',
  });
});

test('a zero-result query is recorded, because that is the row worth having', () => {
  const props = searchQueryProps({ query: 'how do i get my money out', results: 0 });
  assert.equal(props.results, '0');
  assert.equal(props.q, 'how do i get my money out');
});

test('an empty or whitespace-only field cannot fire an event', () => {
  assert.equal(searchQueryProps({ query: '', results: 0 }), null);
  assert.equal(searchQueryProps({ query: '   ', results: 0 }), null);
  assert.equal(searchQueryProps({ query: undefined, results: 0 }), null);
});

test('the query is bounded to the same 64 characters search itself applies', () => {
  const props = searchQueryProps({ query: 'a'.repeat(500), results: 1 });
  assert.equal(props.q.length, 64);
});

test('the surface is recorded only when a site names one', () => {
  assert.equal('surface' in searchQueryProps({ query: 'x', results: 1 }), false);
  assert.equal(searchQueryProps({ query: 'x', results: 1, surface: 'wiki' }).surface, 'wiki');
});

test('a nonsense result count cannot leave a nonsense prop', () => {
  assert.equal(searchQueryProps({ query: 'x', results: -4 }).results, '0');
  assert.equal(searchQueryProps({ query: 'x', results: 2.7 }).results, '2');
  assert.equal(searchQueryProps({ query: 'x', results: NaN }).results, '0');
});
