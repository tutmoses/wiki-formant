import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mcpResponse, mcpGet, mcpOptions, handleMcp, McpToolError, MCP_PROTOCOL_VERSION,
} from '../dist/mcp.js';

const config = {
  serverInfo: { name: 'test-server', version: '1.0.0' },
  instructions: 'Call search first.',
  docsUrl: 'https://example.com/llms.txt',
  tools: [
    {
      name: 'search',
      description: 'Search the corpus.',
      inputSchema: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'query' },
          limit: { type: 'number', description: 'max rows' },
          scope: { type: 'string', description: 'where', enum: ['all', 'kb'] },
          tags: { type: 'array', description: 'tags', items: { type: 'string' } },
        },
        required: ['q'],
      },
      annotations: { readOnlyHint: true, title: 'Search' },
      handler: async args => ({ ok: true, args }),
    },
    {
      name: 'boom',
      description: 'Always fails in a caller-fixable way.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        throw new McpToolError('Page not found', { tried: 'x' });
      },
    },
  ],
};

const post = body =>
  mcpResponse(new Request('https://x/api/mcp', { method: 'POST', body: JSON.stringify(body) }), config);
const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });

test('initialize advertises only capabilities the config populates', async () => {
  const res = await post(rpc('initialize'));
  const { result } = await res.json();
  assert.equal(result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.deepEqual(Object.keys(result.capabilities), ['tools']);
  assert.equal(result.instructions, 'Call search first.');
});

test('prompts and resources appear in capabilities only when supplied', async () => {
  const withPrompts = {
    ...config,
    prompts: [{ name: 'p', description: 'd', text: 'Call search, then get_page.' }],
  };
  const res = await mcpResponse(
    new Request('https://x', { method: 'POST', body: JSON.stringify(rpc('initialize')) }),
    withPrompts,
  );
  const { result } = await res.json();
  assert.deepEqual(Object.keys(result.capabilities).sort(), ['prompts', 'tools']);

  const got = await mcpResponse(
    new Request('https://x', { method: 'POST', body: JSON.stringify(rpc('prompts/get', { name: 'p' })) }),
    withPrompts,
  );
  const body = await got.json();
  assert.equal(body.result.messages[0].content.text, 'Call search, then get_page.');
});

test('tools/list carries annotations but never the handler', async () => {
  const res = await post(rpc('tools/list'));
  const { result } = await res.json();
  const tool = result.tools.find(t => t.name === 'search');
  assert.deepEqual(tool.annotations, { readOnlyHint: true, title: 'Search' });
  assert.equal(tool.handler, undefined);
});

test('malformed JSON is -32700 and 400, never a 500', async () => {
  const res = await mcpResponse(
    new Request('https://x', { method: 'POST', body: '{not json' }),
    config,
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, -32700);
});

test('a notification-only POST gets a bare 202, not a 200 with null', async () => {
  const res = await post(rpc('notifications/initialized', {}, null));
  assert.equal(res.status, 202);
  assert.equal(await res.text(), '');
});

test('an unknown method is -32601 and lists what does exist', async () => {
  const { error } = await (await post(rpc('tools/explode'))).json();
  assert.equal(error.code, -32601);
  assert.ok(error.data.supportedMethods.includes('tools/call'));
  // Undeclared capabilities must not be advertised in the method list either.
  assert.ok(!error.data.supportedMethods.includes('prompts/list'));
});

test('a caller-fixable argument mistake is a tool result, not -32603', async () => {
  const { result, error } = await (
    await post(rpc('tools/call', { name: 'search', arguments: { limit: 'lots', nope: 1 } }))
  ).json();
  assert.equal(error, undefined, 'must not be a protocol error');
  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.match(text, /Missing required parameter "q"/);
  assert.match(text, /Unknown parameter "nope"/);
  assert.match(text, /must be a number/);
  assert.match(text, /Expected schema/);
});

test('every problem is reported at once so one retry can fix them all', async () => {
  const { result } = await (
    await post(rpc('tools/call', { name: 'search', arguments: { q: 1, scope: 'bad', tags: [2] } }))
  ).json();
  const lines = result.content[0].text.split('\n').filter(l => l.startsWith('- '));
  assert.equal(lines.length, 3);
});

test('a numeric string is accepted for a number param', async () => {
  const { result } = await (
    await post(rpc('tools/call', { name: 'search', arguments: { q: 'x', limit: '5' } }))
  ).json();
  assert.equal(result.isError, undefined);
});

test('McpToolError surfaces as isError with its details', async () => {
  const { result } = await (await post(rpc('tools/call', { name: 'boom', arguments: {} }))).json();
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), { error: 'Page not found', tried: 'x' });
});

test('an unknown tool names the tools that do exist', async () => {
  const { error } = await (await post(rpc('tools/call', { name: 'nope' }))).json();
  assert.equal(error.code, -32602);
  assert.deepEqual(error.data.availableTools, ['search', 'boom']);
});

test('batches are capped, and the cap is stated', async () => {
  const big = Array.from({ length: 21 }, (_, i) => rpc('ping', {}, i));
  const { error } = await (await post(big)).json();
  assert.equal(error.code, -32600);
  assert.match(error.message, /max 20/);
});

test('a batch under the cap answers per request', async () => {
  const res = await post([rpc('ping', {}, 1), rpc('ping', {}, 2)]);
  const body = await res.json();
  assert.equal(body.length, 2);
  assert.deepEqual(body.map(r => r.id), [1, 2]);
});

test('GET is a readable 405 with CORS, not a framework 405', async () => {
  const res = mcpGet(config.docsUrl);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('allow'), 'POST, OPTIONS');
  assert.match((await res.json()).error.message, /Docs: https:\/\/example\.com/);
});

test('OPTIONS preflight allows the headers MCP clients actually send', async () => {
  const h = mcpOptions().headers.get('access-control-allow-headers');
  for (const needed of ['Accept', 'Mcp-Protocol-Version', 'Content-Type']) {
    assert.ok(h.includes(needed), `${needed} missing from preflight allow-list`);
  }
});

test('onCall fires once per request with the parsed body', async () => {
  const seen = [];
  await mcpResponse(
    new Request('https://x', { method: 'POST', body: JSON.stringify(rpc('ping')) }),
    { ...config, onCall: (_req, body) => seen.push(body) },
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'ping');
});

test('handleMcp is usable without the HTTP layer', async () => {
  assert.equal(await handleMcp(rpc('notifications/initialized', {}, null), config), null);
  const pong = await handleMcp(rpc('ping'), config);
  assert.deepEqual(pong.result, {});
});
