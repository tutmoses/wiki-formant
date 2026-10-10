import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collect,
  deviceOf,
  digest,
  mcpCallProps,
  normalisePath,
  recordEvent,
  recordView,
  searchQueryProps,
  sourceOf,
} from 'wiki-formant/analytics';

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

// ---- counting ---------------------------------------------------------------

/** A database that records every statement and answers the salt queries. */
function fakeSql() {
  const calls = [];
  const sql = async (query, ...values) => {
    calls.push({ query, values });
    if (query.startsWith('INSERT INTO "Salt"')) return [{ day: values[0] }];
    if (query.startsWith('SELECT value FROM "Salt"')) return [{ value: 'salt' }];
    if (query.includes('json_build_object')) return [{ digest: { visitors: 0 } }];
    return [];
  };
  return { sql, calls, inserts: table => calls.filter(c => c.query.startsWith(`INSERT INTO "${table}"`)) };
}

const headers = (h = {}) => new Headers({ 'user-agent': 'Mozilla/5.0 (iPhone) Mobile', 'x-forwarded-for': '1.2.3.4', host: 'radix.wiki', ...h });

test('a device is a phone, a tablet or a computer', () => {
  assert.equal(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile/15E148'), 'phone');
  assert.equal(deviceOf('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari'), 'phone');
  assert.equal(deviceOf('Mozilla/5.0 (Linux; Android 14; SM-X710) Safari'), 'tablet');
  assert.equal(deviceOf('Mozilla/5.0 (iPad; CPU OS 17_0)'), 'tablet');
  assert.equal(deviceOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'computer');
});

test('a source is the utm tag, else the referring host, never this site', () => {
  assert.equal(sourceOf('https://t.co/abc', 'X', 'radix.wiki'), 'x');
  assert.equal(sourceOf('https://www.google.com/search?q=1', undefined, 'radix.wiki'), 'google.com');
  assert.equal(sourceOf('https://radix.wiki/contents', undefined, 'www.radix.wiki:443'), null);
  assert.equal(sourceOf('', undefined, 'radix.wiki'), null);
  assert.equal(sourceOf('not a url', undefined, 'radix.wiki'), null);
});

test('a path is decoded with one leading slash and no trailing one', () => {
  assert.equal(normalisePath('/'), '/');
  assert.equal(normalisePath('/about/'), '/about');
  assert.equal(normalisePath('//a/b?x=1#h'), '/a/b');
  assert.equal(normalisePath('/caf%C3%A9'), '/café');
  assert.equal(normalisePath('/%E0%A4%A'), null);
});

test('a view stores no address: the visitor is a hash, and the same browser hashes the same', async () => {
  const { sql, inserts } = fakeSql();
  await recordView(sql, { headers: headers({ 'x-vercel-ip-country': 'GB' }), path: '/a/', referrer: 'https://www.google.com/' });
  await recordView(sql, { headers: headers(), path: '/b' });
  const [first, second] = inserts('View');
  assert.deepEqual(first.values.slice(0, 5), ['', '/a', 'google.com', 'GB', 'phone']);
  assert.match(first.values[5], /^[0-9a-f]{32}$/);
  assert.equal(first.values[5], second.values[5]);
  assert.ok(!JSON.stringify(first.values).includes('1.2.3.4'));
});

test('the day that makes a salt deletes the old salts and rows past keeping', async () => {
  const { sql, calls } = fakeSql();
  await recordView(sql, { headers: headers(), path: '/' });
  const deletes = calls.filter(c => c.query.startsWith('DELETE')).map(c => c.query.split(' ')[2]);
  assert.deepEqual(deletes, ['"Salt"', '"View"', '"Event"']);
});

test('a bot and an undecodable path are not counted', async () => {
  const { sql, inserts } = fakeSql();
  await recordView(sql, { headers: headers({ 'user-agent': 'Googlebot/2.1' }), path: '/' });
  await recordView(sql, { headers: headers(), path: '/%E0%A4%A' });
  assert.equal(inserts('View').length, 0);
});

test('an event without a request joins no visitor, and a failed write never rejects', async () => {
  const { sql, inserts } = fakeSql();
  await recordEvent(sql, { name: 'MCP Call', props: { tool: 'search' }, url: 'https://radix.wiki/api/mcp?x=1' });
  const [e] = inserts('Event');
  assert.deepEqual(e.values, ['', 'MCP Call', '/api/mcp', '{"tool":"search"}', null]);
  await recordEvent(async () => { throw new Error('no table'); }, { name: 'x', headers: headers() });
});

test('collect answers 204 and defers a view, an event, or nothing', async () => {
  const { sql, inserts } = fakeSql();
  const tasks = [];
  const opts = { sql, defer: t => tasks.push(t) };
  const post = (body, h = {}) =>
    collect(new Request('https://radix.wiki/api/view', { method: 'POST', body: JSON.stringify(body), headers: headers({ 'x-forwarded-for': `9.9.9.${tasks.length}`, ...h }) }), opts);

  assert.equal((await post({ path: '/x', utm: 'x' })).status, 204);
  assert.equal((await post({ name: 'Outbound Link: Click', path: '/x', props: { url: 'https://x.com/a', bad: {} } })).status, 204);
  assert.equal((await post({ path: '/x' }, { 'user-agent': 'GPTBot/1.0' })).status, 204);
  assert.equal((await post({ nonsense: true })).status, 204);
  assert.equal(tasks.length, 2);
  await Promise.all(tasks.map(t => t()));
  assert.equal(inserts('View')[0].values[2], 'x');
  assert.equal(inserts('Event')[0].values[3], '{"url":"https://x.com/a"}');
});

test('collect drops a beacon its site resolver refuses', async () => {
  const { sql } = fakeSql();
  const tasks = [];
  const request = new Request('https://a.test/api/view', { method: 'POST', body: '{"path":"/missing"}', headers: headers({ 'x-forwarded-for': '7.7.7.7' }) });
  await collect(request, { sql, defer: t => tasks.push(t), site: (_r, path) => (path === '/missing' ? null : 'site-1') });
  assert.equal(tasks.length, 0);
});

test('every placeholder in the digest has a value', async () => {
  const { sql, calls } = fakeSql();
  await digest(sql, { days: 7, handle: 'radixwiki', siblings: ['caper.network'], gaps: [{ event: 'Symptom Miss', prop: 'term' }] });
  const { query, values } = calls.at(-1);
  const highest = Math.max(...[...query.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
  assert.equal(highest, values.length);
});

test('without a handle the digest counts no clicks to X, per day or in all', async () => {
  const { sql, calls } = fakeSql();
  await digest(sql, { days: 7 });
  const { query } = calls.at(-1);
  assert.doesNotMatch(query, /Outbound Link/);
  assert.match(query, /'follow_clicks', NULL/);
});

test('a filter narrows the visits, leaves out the archive and the comparison', async () => {
  const { sql, calls } = fakeSql();
  await digest(sql, { days: 30, handle: 'h', filter: { page: '/a', source: '(none)', country: 'GB' } });
  const { query, values } = calls.at(-1);
  const highest = Math.max(...[...query.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
  assert.equal(highest, values.length);
  assert.match(query, /HAVING bool_or\(path = \$\d+\) AND coalesce\(\(array_agg\(source ORDER BY at, id\)\)\[1\], '\(none\)'\) = \$\d+ AND bool_or\(country = \$\d+\)/);
  assert.match(query, /JOIN visits USING \(visitor, visit\)/);
  assert.match(query, /::date AND false/);
  assert.match(query, /'previous_visitors', NULL/);
  assert.ok(values.includes('/a') && values.includes('(none)') && values.includes('GB'));
});

test('without a filter every view counts and the archive adds in', async () => {
  const { sql, calls } = fakeSql();
  await digest(sql, { days: 30 });
  const { query } = calls.at(-1);
  assert.doesNotMatch(query, /HAVING|JOIN visits|AND false/);
});

// ---- the app binding --------------------------------------------------------

import { createTracker } from 'wiki-formant/analytics';

test('a tracker that is not enabled records nothing and answers the beacon 204', async () => {
  const { sql, calls } = fakeSql();
  const tasks = [];
  const t = createTracker({ sql, defer: f => tasks.push(f), enabled: false });
  await t.trackEvent('X', 'https://a.test/', {});
  t.trackMcpCall(new Request('https://a.test/api/mcp', { headers: headers() }), { method: 'tools/call' });
  t.trackSearch(headers(), 'nothing here', 0, 'wiki');
  const res = await t.viewRoute()(new Request('https://a.test/api/view', { method: 'POST', body: '{"path":"/"}', headers: headers() }));
  assert.equal(res.status, 204);
  assert.equal(tasks.length, 0);
  assert.equal(calls.length, 0);
});

test('the default gate is a Vercel production deployment', async () => {
  const { sql, calls } = fakeSql();
  const before = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = 'preview';
  await createTracker({ sql, defer: () => {} }).trackEvent('X', '/', {});
  assert.equal(calls.length, 0);
  process.env.VERCEL_ENV = 'production';
  await createTracker({ sql, defer: () => {} }).trackEvent('X', '/', {});
  assert.ok(calls.length > 0);
  if (before === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = before;
});

test('a tracker defers the MCP and search events and files a search under its referer', async () => {
  const { sql, inserts } = fakeSql();
  const tasks = [];
  const t = createTracker({ sql, defer: f => tasks.push(f), enabled: true, siteUrl: 'https://a.test' });
  t.trackMcpCall(new Request('https://a.test/api/mcp', { headers: headers() }), { method: 'tools/call', params: { name: 'search' } }, 'kb');
  t.trackSearch(headers({ referer: 'https://a.test/wiki/x' }), '  Nothing  Here ', 0, 'wiki');
  // A reader of headers is called inside the deferred write; a throw drops the event only.
  t.trackSearch(async () => headers(), 'rooted', 3);
  t.trackSearch(() => { throw new Error('outside a request'); }, 'lost', 0);
  t.trackSearch(headers(), '   ', 0);
  assert.equal(tasks.length, 4);
  await Promise.all(tasks.map(f => f()));
  const events = inserts('Event').map(e => [e.values[1], e.values[2], JSON.parse(e.values[3])]);
  assert.deepEqual(events, [
    ['MCP Call', '/api/mcp', { server: 'kb', method: 'tools/call', tool: 'search', ua: 'Mozilla/5.0 (iPhone) Mobile' }],
    ['Search Query', '/wiki/x', { q: 'nothing here', results: '0', surface: 'wiki' }],
    ['Search Query', '/', { q: 'rooted', results: '3' }],
  ]);
});

test('the view route passes a site resolver through to collect', async () => {
  const { sql } = fakeSql();
  const tasks = [];
  const t = createTracker({ sql, defer: f => tasks.push(f), enabled: true });
  const post = path => new Request('https://a.test/api/view', { method: 'POST', body: JSON.stringify({ path }), headers: headers({ 'x-real-ip': `8.8.8.${tasks.length}` }) });
  const route = t.viewRoute({ site: (_r, path) => (path === '/missing' ? null : 'site-1') });
  assert.equal((await route(post('/missing'))).status, 204);
  assert.equal(tasks.length, 0);
  await route(post('/here'));
  assert.equal(tasks.length, 1);
});
