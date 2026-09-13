import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mcpResponse, mcpGet, mcpOptions, handleMcp, McpToolError,
  MCP_LEGACY_PROTOCOL_VERSION, MCP_META, MCP_MODERN_VERSIONS, MCP_PROTOCOL_VERSIONS,
} from 'wiki-formant/mcp';
import { resetRateLimits } from 'wiki-formant/rate-limit';

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
  assert.equal(result.protocolVersion, MCP_LEGACY_PROTOCOL_VERSION);
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
  // Undeclared capabilities must not advertise the method that reads them.
  assert.ok(!error.data.supportedMethods.includes('prompts/get'));
});

test('every method the list advertises is actually dispatched', async () => {
  const { error } = await (await post(rpc('tools/explode'))).json();
  for (const method of error.data.supportedMethods) {
    if (method === 'initialize' || method === 'tools/call') continue;
    const res = await (await post(rpc(method))).json();
    assert.notEqual(
      res.error?.code,
      -32601,
      `"${method}" is advertised but answers -32601`,
    );
  }
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

test('object params and arrays of objects validate', async () => {
  const cfg = {
    ...config,
    tools: [{
      name: 'create_page',
      description: 'Write a page.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'array', description: 'blocks', items: { type: 'object' } },
          metadata: { type: 'object', description: 'key-value metadata' },
        },
        required: ['content'],
      },
      handler: async args => ({ ok: true, blocks: args.content.length }),
    }],
  };
  const send = args => mcpResponse(
    new Request('https://x', { method: 'POST', body: JSON.stringify(rpc('tools/call', { name: 'create_page', arguments: args })) }),
    cfg,
  );

  const good = await (await send({ content: [{ id: '1', type: 'content' }], metadata: { a: 'b' } })).json();
  assert.equal(good.result.isError, undefined);

  // An array where an object is required, and a null inside an object array —
  // `typeof` calls both "object", which is why the item check cannot use it.
  const bad = await (await send({ content: [null], metadata: ['not', 'an', 'object'] })).json();
  assert.equal(bad.result.isError, true);
  const text = bad.result.content[0].text;
  assert.match(text, /"content" must contain only objects/);
  assert.match(text, /"metadata" must be a object; received array/);
});

// --- protocol negotiation ----------------------------------------------------

test('initialize echoes a version we speak, and offers the newest otherwise', async () => {
  const spoken = await (await post(rpc('initialize', { protocolVersion: '2025-03-26' }))).json();
  assert.equal(spoken.result.protocolVersion, '2025-03-26');

  const unknown = await (await post(rpc('initialize', { protocolVersion: '1999-01-01' }))).json();
  assert.equal(unknown.result.protocolVersion, MCP_LEGACY_PROTOCOL_VERSION);

  // A handshake cannot land on a modern version: that era has no handshake.
  const modern = await (await post(rpc('initialize', { protocolVersion: MCP_MODERN_VERSIONS[0] }))).json();
  assert.equal(modern.result.protocolVersion, MCP_LEGACY_PROTOCOL_VERSION);
});

const postAt = (body, version) =>
  mcpResponse(
    new Request('https://x/api/mcp', {
      method: 'POST',
      headers: version ? { 'MCP-Protocol-Version': version } : {},
      body: JSON.stringify(body),
    }),
    config,
  );

test('the negotiated version comes back on every response', async () => {
  assert.equal((await postAt(rpc('ping'), '2025-06-18')).headers.get('MCP-Protocol-Version'), '2025-06-18');
  // No header means 2025-03-26, which is what the spec says to assume.
  assert.equal((await postAt(rpc('ping'))).headers.get('MCP-Protocol-Version'), '2025-03-26');
});

test('batching is refused at 2025-06-18 and honoured below it', async () => {
  const removed = await postAt([rpc('ping')], '2025-06-18');
  assert.equal(removed.status, 400);
  assert.equal((await removed.json()).error.code, -32600);

  const kept = await postAt([rpc('ping')], '2025-03-26');
  assert.equal(kept.status, 200);
  assert.equal((await kept.json()).length, 1);
});

test('CORS exposes the headers a browser client has to read', async () => {
  const expose = mcpOptions().headers.get('Access-Control-Expose-Headers');
  assert.match(expose, /Mcp-Protocol-Version/);
  assert.match(expose, /Retry-After/);
});

// --- structured output, _meta and the envelope gate --------------------------

const richConfig = {
  ...config,
  tools: [
    {
      name: 'lookup',
      title: 'Look something up',
      description: 'Returns a shaped answer.',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object', properties: { hits: { type: 'number', description: 'count' } } },
      handler: async (_args, ctx) => {
        ctx.setMeta('x402/payment-response', { settled: true, saw: ctx.meta.token ?? null });
        return { hits: 2 };
      },
    },
  ],
};

test('a tool with an outputSchema advertises it and answers structured', async () => {
  const listed = await handleMcp(rpc('tools/list'), richConfig);
  assert.equal(listed.result.tools[0].title, 'Look something up');
  assert.deepEqual(listed.result.tools[0].outputSchema.properties.hits.type, 'number');

  const called = await handleMcp(
    rpc('tools/call', { name: 'lookup', arguments: {}, _meta: { token: 'abc' } }),
    richConfig,
  );
  assert.deepEqual(called.result.structuredContent, { hits: 2 });
  // The text block stays, because a client that ignored outputSchema still has
  // to be able to read the answer.
  assert.match(called.result.content[0].text, /"hits": 2/);
  assert.deepEqual(called.result._meta['x402/payment-response'], { settled: true, saw: 'abc' });
});

test('every object answer carries structuredContent, schema or no schema', async () => {
  // `search` declares no outputSchema. Gating on one is what left thirty-two
  // live tools returning JSON as prose only.
  const called = await handleMcp(rpc('tools/call', { name: 'search', arguments: { q: 'x' } }), config);
  assert.equal(typeof called.result.structuredContent, 'object');
  assert.match(called.result.content[0].text, /\{/);
});

test('a string answer carries no structuredContent', async () => {
  const prose = {
    ...config,
    tools: [{ ...config.tools[0], handler: async () => 'plain text, not a record' }],
  };
  const called = await handleMcp(rpc('tools/call', { name: 'search', arguments: { q: 'x' } }), prose);
  assert.equal(called.result.structuredContent, undefined);
  assert.equal(called.result.content[0].text, 'plain text, not a record');
});

test('requireOneOf is caught before dispatch, not in the handler', async () => {
  let ran = false;
  const either = {
    ...config,
    tools: [{
      name: 'search',
      description: 'Search the corpus.',
      inputSchema: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'query' },
          popular: { type: 'boolean', description: 'trending instead' },
        },
        requireOneOf: ['q', 'popular'],
      },
      handler: async () => { ran = true; return { ok: true }; },
    }],
  };
  const empty = await handleMcp(rpc('tools/call', { name: 'search', arguments: {} }), either);
  assert.equal(empty.result.isError, true);
  assert.match(empty.result.content[0].text, /at least one of "q", "popular"/);
  assert.equal(ran, false);

  const ok = await handleMcp(rpc('tools/call', { name: 'search', arguments: { popular: true } }), either);
  assert.equal(ok.result.isError, undefined);
});

test('a gate can withhold an entry and merge its own answer back', async () => {
  const gated = {
    ...config,
    gate: async body => ({
      body: [],
      empty: true,
      finish: async () => ({ jsonrpc: '2.0', id: body.id, error: { code: 402, message: 'Payment required' } }),
    }),
  };
  const res = await mcpResponse(
    new Request('https://x/api/mcp', { method: 'POST', body: JSON.stringify(rpc('tools/call', { name: 'search' })) }),
    gated,
  );
  assert.equal((await res.json()).error.code, 402);
});

test('a declared budget is enforced, and every answer states the headroom', async () => {
  resetRateLimits();
  const limited = { ...config, rateLimit: { capacity: 2, refillPerSec: 0.01, prefix: 'test-mcp' } };
  const post = () =>
    mcpResponse(
      new Request('https://x/api/mcp', {
        method: 'POST',
        headers: { 'x-forwarded-for': '9.9.9.9' },
        body: JSON.stringify(rpc('ping')),
      }),
      limited,
    );

  const first = await post();
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('RateLimit-Limit'), '2');
  assert.equal(first.headers.get('RateLimit-Remaining'), '1');

  await post();
  const over = await post();
  assert.equal(over.status, 429);
  assert.equal(over.headers.get('RateLimit-Remaining'), '0');
  assert.match(over.headers.get('Retry-After'), /^\d+$/);
  assert.equal((await over.json()).error.code, -32000);
});

test('no declared budget means no limiting and no headroom headers', async () => {
  const res = await mcpResponse(
    new Request('https://x/api/mcp', { method: 'POST', body: JSON.stringify(rpc('ping')) }),
    config,
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('RateLimit-Limit'), null);
});

// --- the modern era ----------------------------------------------------------

const MODERN = MCP_MODERN_VERSIONS[0];
const modern = (method, params = {}, { version = MODERN, headers = {}, cfg = config, meta = {} } = {}) =>
  mcpResponse(
    new Request('https://x/api/mcp', {
      method: 'POST',
      headers: { 'MCP-Protocol-Version': version, 'Mcp-Method': method, ...headers },
      body: JSON.stringify(
        rpc(method, {
          ...params,
          _meta: { [MCP_META.protocolVersion]: version, [MCP_META.clientCapabilities]: {}, ...meta },
        }),
      ),
    }),
    cfg,
  );

test('server/discover answers what initialize answers, in the modern shape', async () => {
  const res = await modern('server/discover');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('MCP-Protocol-Version'), MODERN);
  const { result } = await res.json();
  assert.equal(result.resultType, 'complete');
  assert.deepEqual(result.supportedVersions, [...MCP_PROTOCOL_VERSIONS]);
  assert.deepEqual(result.capabilities, { tools: {} });
  assert.equal(result.instructions, 'Call search first.');
  assert.equal(result.cacheScope, 'public');
  assert.equal(typeof result.ttlMs, 'number');
  // serverInfo moved out of the body and into `_meta`.
  assert.deepEqual(result._meta[MCP_META.serverInfo], config.serverInfo);
  assert.equal(result.serverInfo, undefined);
});

test('a modern request missing its _meta fields is -32602 and says how to fix it', async () => {
  const bare = await mcpResponse(
    new Request('https://x/api/mcp', { method: 'POST', body: JSON.stringify(rpc('server/discover')) }),
    config,
  );
  assert.equal(bare.status, 400);
  const { error } = await bare.json();
  assert.equal(error.code, -32602);
  assert.match(error.message, /initialize/);

  const noCaps = await modern('tools/list', {}, { meta: { [MCP_META.clientCapabilities]: undefined } });
  assert.equal(noCaps.status, 400);
  assert.match((await noCaps.json()).error.message, /clientCapabilities/);
});

test('an unsupported version is -32022 and names every version spoken', async () => {
  const res = await modern('tools/list', {}, { version: '1999-01-01' });
  assert.equal(res.status, 400);
  const { error } = await res.json();
  assert.equal(error.code, -32022);
  assert.deepEqual(error.data, { supported: [...MCP_PROTOCOL_VERSIONS], requested: '1999-01-01' });
});

test('the routing headers must agree with the body, encoded or not', async () => {
  const wrongMethod = await modern('tools/list', {}, { headers: { 'Mcp-Method': 'prompts/list' } });
  assert.equal(wrongMethod.status, 400);
  assert.equal((await wrongMethod.json()).error.code, -32020);

  const call = { name: 'search', arguments: { q: 'x' } };
  const noName = await modern('tools/call', call);
  assert.equal(noName.status, 400);
  assert.match((await noName.json()).error.message, /Mcp-Name/);

  const encoded = await modern('tools/call', call, { headers: { 'Mcp-Name': `=?base64?${btoa('search')}?=` } });
  assert.equal(encoded.status, 200);
});

test('methods the modern era removed are 404 there and still work in the legacy era', async () => {
  const ping = await modern('ping');
  assert.equal(ping.status, 404);
  const { error } = await ping.json();
  assert.equal(error.code, -32601);
  assert.ok(!error.data.supportedMethods.includes('ping'));
  assert.ok(error.data.supportedMethods.includes('server/discover'));

  assert.deepEqual((await (await post(rpc('ping'))).json()).result, {});
});

test('a modern tool result carries resultType beside the handler _meta', async () => {
  const res = await modern('tools/call', { name: 'lookup', arguments: {} }, {
    cfg: richConfig,
    headers: { 'Mcp-Name': 'lookup' },
  });
  const { result } = await res.json();
  assert.equal(result.resultType, 'complete');
  assert.deepEqual(result.structuredContent, { hits: 2 });
  assert.equal(result.ttlMs, undefined, 'a call is not cacheable');
  assert.equal(result._meta['x402/payment-response'].settled, true);
  assert.deepEqual(result._meta[MCP_META.serverInfo], config.serverInfo);

  const unknown = await modern('tools/call', { name: 'nope' }, { headers: { 'Mcp-Name': 'nope' } });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error.code, -32602);
});

test('a result a gate builds is shaped for the modern era too', async () => {
  const gated = {
    ...config,
    gate: async body => ({
      body: [],
      empty: true,
      finish: async () => ({
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [{ type: 'text', text: 'pay first' }], isError: true },
      }),
    }),
  };
  const res = await modern('tools/call', { name: 'search' }, { cfg: gated, headers: { 'Mcp-Name': 'search' } });
  assert.equal((await res.json()).result.resultType, 'complete');
});

test('lists are cacheable publicly and a read only privately', async () => {
  const withResource = {
    ...config,
    resources: [{ uri: 'wiki://a', name: 'a', description: 'd', mimeType: 'text/plain', read: async () => 'hello' }],
  };
  const list = await (await modern('resources/list', {}, { cfg: withResource })).json();
  assert.equal(list.result.cacheScope, 'public');

  const read = await (
    await modern('resources/read', { uri: 'wiki://a' }, { cfg: withResource, headers: { 'Mcp-Name': 'wiki://a' } })
  ).json();
  assert.equal(read.result.cacheScope, 'private');
  assert.equal(read.result.contents[0].text, 'hello');
});

test('a legacy request carrying other _meta stays legacy', async () => {
  const res = await postAt(
    rpc('tools/call', { name: 'search', arguments: { q: 'x' }, _meta: { progressToken: 1 } }),
    '2025-06-18',
  );
  assert.equal(res.status, 200);
  const { result } = await res.json();
  assert.equal(result.resultType, undefined);
  assert.equal(res.headers.get('MCP-Protocol-Version'), '2025-06-18');

  // 2025-11-25 is legacy and still forbids batching.
  assert.equal((await postAt([rpc('ping')], '2025-11-25')).status, 400);
});
