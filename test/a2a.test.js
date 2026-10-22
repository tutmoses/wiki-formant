import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcpResponse, McpToolError } from 'wiki-formant/mcp';
import { agentCard } from 'wiki-formant/well-known';

const config = {
  serverInfo: { name: 'test-server', version: '1.0.0' },
  instructions: 'Call search first.',
  answer: { tool: 'search', argument: 'q' },
  tools: [
    {
      name: 'search',
      description: 'Search the corpus.',
      inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'query' } }, required: ['q'] },
      handler: async ({ q }) => {
        if (q === 'nothing') throw new McpToolError('No pages match "nothing".');
        return { results: [{ path: '/a', title: `About ${q}` }] };
      },
    },
  ],
};

const post = (body, cfg = config) =>
  mcpResponse(new Request('https://x/api/mcp', { method: 'POST', body: JSON.stringify(body) }), cfg).then(r => r.json());
const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });

test('a v0.3 message/send is answered with a message carrying the search', async () => {
  const message = { kind: 'message', role: 'user', messageId: 'm1', contextId: 'c1', parts: [{ kind: 'text', text: 'cerberus' }] };
  const { result } = await post(rpc('message/send', { message }));
  assert.equal(result.kind, 'message');
  assert.equal(result.role, 'agent');
  assert.equal(result.contextId, 'c1');
  assert.equal(result.parts[0].kind, 'text');
  assert.match(result.parts[0].text, /About cerberus/);
  assert.deepEqual(result.parts[1], { kind: 'data', data: { results: [{ path: '/a', title: 'About cerberus' }] } });
});

test('a v1.0 SendMessage is answered in the v1.0 shape', async () => {
  const message = { role: 'ROLE_USER', messageId: 'm1', parts: [{ text: 'scrypto' }] };
  const { result } = await post(rpc('SendMessage', { message }));
  assert.equal(result.message.role, 'ROLE_AGENT');
  assert.ok(result.message.contextId);
  assert.match(result.message.parts[0].text, /About scrypto/);
  assert.ok(result.message.parts[1].data);
});

test('without an answer tool, or a caller-fixable miss, the reply orients instead', async () => {
  const message = { parts: [{ text: 'nothing' }] };
  const miss = await post(rpc('message/send', { message }));
  assert.match(miss.result.parts[0].text, /No pages match/);
  assert.match(miss.result.parts[0].text, /tools\/list/);
  const { answer, ...plain } = config;
  const bare = await post(rpc('message/send', { message: { parts: [{ text: 'x' }] } }), plain);
  assert.match(bare.result.parts[0].text, /Call search first\./);
});

test('task methods are TaskNotFound, the rest unsupported, a missing message invalid', async () => {
  for (const m of ['tasks/get', 'GetTask', 'tasks/cancel']) assert.equal((await post(rpc(m, { id: 't' }))).error.code, -32001);
  for (const m of ['message/stream', 'SendStreamingMessage', 'GetExtendedAgentCard']) assert.equal((await post(rpc(m))).error.code, -32004);
  assert.equal((await post(rpc('message/send', {}))).error.code, -32602);
});

test('a name Object.prototype carries is not an A2A method', async () => {
  for (const m of ['toString', 'constructor']) assert.equal((await post(rpc(m, { message: { parts: [{ text: 'x' }] } }))).error.code, -32601);
});

test('the card names the endpoint for both A2A revisions', () => {
  const card = agentCard({ name: 'W', description: 'd', url: 'https://w.test', version: '1', skills: [] });
  assert.deepEqual(card.supportedInterfaces.map(i => [i.url, i.protocolBinding, i.protocolVersion]), [
    ['https://w.test/api/mcp', 'JSONRPC', '1.0'],
    ['https://w.test/api/mcp', 'JSONRPC', '0.3'],
  ]);
  assert.equal('supportedInterfaces' in agentCard({ name: 'W', description: 'd', url: 'https://w.test', version: '1', skills: [], mcpEndpoint: null }), false);
});
