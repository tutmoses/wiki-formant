import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  manifestParity,
  rowParity,
  twinParity,
  roundTrip,
  openapiWriteParity,
  rolaOriginCheck,
  editReadChecks,
  pluginParity,
} from 'wiki-formant/conformance';

// A Tester that records checks and answers tool calls from a table, so the
// drift checks run without a server.
const tester = (calls = {}) => {
  const results = [];
  const answer = (name, args) => {
    const v = typeof calls[name] === 'function' ? calls[name](args) : calls[name];
    return v && v.result ? v : { result: { content: [{ text: JSON.stringify(v) }] } };
  };
  return {
    base: 'https://example.org',
    endpoint: 'https://example.org/api/mcp',
    results,
    check: (tool, ok, note) => results.push({ tool, ok, note }),
    payload: r => (r.result?.content?.[0]?.text ? JSON.parse(r.result.content[0].text) : r.result),
    rpc: async method => (method === 'tools/list' ? { result: { tools: calls['tools/list'] ?? [] } } : {}),
    call: async (name, args) => answer(name, args),
    callAt: async (_, name, args) => answer(name, args),
  };
};
const ok = t => Object.fromEntries(t.results.map(r => [r.tool, r.ok]));

const realFetch = globalThis.fetch;
const serve = routes => {
  globalThis.fetch = async url => {
    const body = routes[String(url)];
    if (body === undefined) return new Response('', { status: 404 });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  };
};
afterEach(() => { globalThis.fetch = realFetch; });

test('rowParity: identical rows pass, empty ones never do', () => {
  const t = tester();
  rowParity(t, 'same', [{ a: 1 }], [{ a: 1 }]);
  rowParity(t, 'differ', [{ a: 1 }], [{ a: 2 }]);
  rowParity(t, 'empty', [], []);
  rowParity(t, 'null', null, null);
  assert.deepEqual(ok(t), { same: true, differ: false, empty: false, null: false });
  assert.match(t.results[1].note, /at char/);
});

test('twinParity strips frontmatter, and the title only where the text has no h1', async () => {
  serve({
    'https://example.org/a.md': '---\ntitle: A\n---\n\n# A\n\nBody **text**.\n',
    'https://example.org/b.md': '---\ntitle: B\n---\n\n# Hero\n\nWords.\n',
  });
  const t = tester();
  await twinParity(t, 'titled', 'a.md', 'Body **text**.');
  await twinParity(t, 'own h1', '/b.md', '# Hero\n\nWords.');
  await twinParity(t, 'flattened', 'a.md', 'Body text.');
  await twinParity(t, 'missing', 'c.md', 'x');
  await twinParity(t, 'empty', 'a.md', '');
  assert.deepEqual(ok(t), { titled: true, 'own h1': true, flattened: false, missing: false, empty: false });
});

test('roundTrip: a write that takes its read back and changes nothing passes', async () => {
  let page = { path: 'x', content: [{ id: '1', type: 'content' }] };
  const t = tester();
  await roundTrip(t, 'kept', { read: async () => page, write: async () => ({ result: {} }) });
  await roundTrip(t, 'changed', { read: async () => page, write: async v => { page = { ...v, content: [] }; return { result: {} }; } });
  await roundTrip(t, 'refused', { read: async () => page, write: async () => ({ result: { isError: true, content: [{ text: '"bad"' }] } }) });
  await roundTrip(t, 'empty', { read: async () => ({}), write: async () => ({ result: {} }) });
  assert.deepEqual(ok(t), { kept: true, changed: false, refused: false, empty: false });
});

test('manifestParity: equal tools, the endpoint by path, write auth only with writes', async () => {
  const tools = [{ name: 'read', annotations: { readOnlyHint: true } }, { name: 'edit', annotations: { readOnlyHint: false } }];
  serve({ 'https://example.org/.well-known/mcp.json': { tools, mcp: { endpoint: 'https://canonical.org/api/mcp' }, auth: { writes: 'ROLA' } } });
  const t = tester({ 'tools/list': tools });
  await manifestParity(t, { writeAuth: true });
  assert.deepEqual(ok(t), { 'mcp.json is tools/list': true, 'mcp.json names the endpoint': true, 'mcp.json write auth': true });

  // Auth stated with no write tool listed, and a description that drifted.
  serve({ 'https://example.org/.well-known/mcp.json': { tools: [{ name: 'read', annotations: { readOnlyHint: true }, description: 'old' }], mcp: { endpoint: '/api/mcp' }, auth: { writes: 'ROLA' } } });
  const u = tester({ 'tools/list': [tools[0]] });
  await manifestParity(u);
  assert.deepEqual(ok(u), { 'mcp.json is tools/list': false, 'mcp.json names the endpoint': true, 'mcp.json write auth': false });
});

test('openapiWriteParity names the fields a tool is missing', async () => {
  serve({
    'https://example.org/.well-known/openapi.json': {
      paths: { '/api/wiki/{path}': { put: { requestBody: { content: { 'application/json': { schema: { properties: { content: {}, baseVersion: {} } } } } } } } },
    },
  });
  const t = tester({ 'tools/list': [{ name: 'edit_page', inputSchema: { properties: { content: {} } } }] });
  await openapiWriteParity(t, [['/api/wiki/{path}', 'put', 'edit_page'], ['/api/nowhere', 'post', 'edit_page']]);
  assert.deepEqual(t.results.map(r => r.ok), [false, false]);
  assert.match(t.results[0].note, /missing: baseVersion/);
  assert.match(t.results[1].note, /documents no body/);
});

test('rolaOriginCheck wants the origin under test, quoted', async () => {
  const t = tester({ get_challenge: { sign: { message: 'blake2b of … + "https://example.org" (utf-8)' } } });
  await rolaOriginCheck(t);
  await rolaOriginCheck(t, { origin: 'http://localhost:3000' });
  assert.deepEqual(t.results.map(r => r.ok), [true, false]);
});

test('editReadChecks: ids on rows, blocks the site accepts, history at the same version', async () => {
  const page = { id: 'p1', version: '1.2.0', content: [{ type: 'content' }], metadata: {} };
  const history = { currentVersion: '1.2.0', revisions: [{ id: 'r1', version: '1.2.0', author: 'a' }] };
  const t = tester({ get_page: page, get_page_history: history });
  await editReadChecks(t, { path: 'x', rows: [{ id: 'p1' }], validate: () => true });
  assert.ok(t.results.every(r => r.ok), JSON.stringify(t.results));

  const u = tester({ get_page: page, get_page_history: { ...history, currentVersion: '1.3.0' } });
  await editReadChecks(u, { path: 'x', rows: [{}], validate: () => 'unknown block type', label: 'kb' });
  assert.deepEqual(u.results.map(r => [r.tool, r.ok]), [['[kb] rows carry the page id', false], ['[kb] get_page(blocks)', false], ['[kb] get_page_history', false]]);
});

test('pluginParity holds the package to the endpoint it names', async () => {
  const hints = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const tool = (name, description = name, annotations = hints) => ({ name, description, annotations });
  const main = [tool('search'), tool('get_page'), tool('save', 'save', { readOnlyHint: false, destructiveHint: true, openWorldHint: false })];
  const read = [tool('search', 'Search, then get_page.'), tool('get_page', 'Read one; edit it with save.')];
  const t = {
    base: 'http://localhost:3000',
    endpoint: 'http://localhost:3000/api/mcp',
    results: [],
    check(tool, ok, note) { this.results.push({ tool, ok, note }); },
    rpc: async method => (method === 'tools/list' ? { result: { tools: main } } : {}),
    rpcAt: async (url, method, params) => {
      assert.equal(url, 'http://localhost:3000/api/mcp/read');
      if (method === 'tools/list') return { result: { tools: read } };
      if (method === 'initialize') return { result: { instructions: 'Call search first.' } };
      if (method === 'prompts/list') return { result: { prompts: [{ name: 'find' }] } };
      if (method === 'prompts/get') return { result: { messages: [{ content: { text: `Call search for ${params.name}.` } }] } };
      return {};
    },
  };
  serve({
    'http://localhost:3000/': 'home',
    'http://localhost:3000/privacy': '<h2 id="contact">Contact</h2>',
    'http://localhost:3000/terms': 'terms',
  });
  const positive = ['search', 'get_page', 'search, get_page', 'search', 'gone_tool'].map(tools_triggered => ({ description: 'd', prompt: 'p', tools_triggered, expected_behavior: 'e' }));
  await pluginParity(t, {
    mcp: { mcpServers: { s: { type: 'streamable-http', url: 'https://example.org/api/mcp/read' } } },
    plugin: { extensions: { 'com.openai': {
      interface: {
        displayName: 'Example', shortDescription: 'An example', longDescription: 'Long.', developerName: 'Ex', category: 'Education',
        capabilities: ['Read'], logo: './assets/logo.png', defaultPrompt: ['One'],
        websiteURL: 'https://example.org', supportURL: 'https://example.org/privacy#contact',
        privacyPolicyURL: 'https://example.org/privacy#missing', termsOfServiceURL: 'https://x.com/example',
      },
      review: { test_cases: { positive, negative: [1, 2, 3].map(() => ({ description: 'd', prompt: 'p' })) } },
    } } },
  });
  assert.deepEqual(ok(t), {
    'plugin names one server': true,
    'plugin endpoint answers': true,
    'review cases name live tools': false,
    'plugin hints are booleans': true,
    'plugin capabilities': true,
    'plugin text names only its tools': false,
    'plugin listing': true,
    'listing websiteURL': true,
    'listing supportURL': true,
    'listing privacyPolicyURL': false,
    'listing termsOfServiceURL': true,
  });
  assert.match(t.results.find(r => r.tool === 'review cases name live tools').note, /gone_tool/);
  assert.equal(t.results.find(r => r.tool === 'plugin text names only its tools').note, 'get_page description names save');
});
