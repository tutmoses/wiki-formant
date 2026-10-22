import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  registryAuthRecord,
  agentCard,
  skillsFromTools,
  AGENT_CARD_CACHE_CONTROL,
} from 'wiki-formant/well-known';

test('no configured key means no record, so the caller can 404', () => {
  assert.equal(registryAuthRecord(undefined), null);
  assert.equal(registryAuthRecord(''), null);
});

test('the record is the MCPv1 line the registry parses', () => {
  const r = registryAuthRecord('AAAAC3NzaC1lZDI1NTE5');
  assert.equal(r.body, 'v=MCPv1; k=ed25519; p=AAAAC3NzaC1lZDI1NTE5\n');
  assert.equal(r.contentType, 'text/plain; charset=utf-8');
  assert.equal(r.cacheControl, 'no-store');
});

test('a P-384 key can override the default key type', () => {
  assert.match(registryAuthRecord('k', 'p384').body, /k=p384;/);
});

const TOOLS = [
  { name: 'search_pages', description: 'Search.', skill: { id: 'search', tags: ['search'], examples: ['find x'] } },
  { name: 'read_page', description: 'Read.', skill: { id: 'read', tags: ['read'] } },
  { name: 'edit_page', description: 'Edit.', skill: { id: 'edit', tags: ['write'] }, auth: { type: 'rola' } },
  { name: 'internal_thing', description: 'Not a skill.' },
];

test('only tools that declare a skill become skills', () => {
  const s = skillsFromTools(TOOLS);
  assert.deepEqual(s.map(x => x.id), ['search', 'read', 'edit']);
});

test('a tool name becomes a title-cased skill name', () => {
  assert.equal(skillsFromTools(TOOLS)[0].name, 'Search Pages');
});

test('examples and authentication appear only when the tool has them', () => {
  const [search, read, edit] = skillsFromTools(TOOLS);
  assert.deepEqual(search.examples, ['find x']);
  assert.equal('examples' in read, false);
  assert.equal('authentication' in read, false);
  assert.deepEqual(edit.authentication, { type: 'rola' });
});

const BASE = { name: 'Test Wiki', description: 'A wiki.', url: 'https://test.example', version: '1.2.3', skills: [] };

test('the card derives its urls from the origin', () => {
  const c = agentCard(BASE);
  assert.equal(c.documentationUrl, 'https://test.example/llms.txt');
  assert.equal(c.mcpEndpoint, 'https://test.example/api/mcp');
  assert.deepEqual(c.provider, { organization: 'Test Wiki', url: 'https://test.example' });
});

test('an origin with no MCP server omits the endpoint entirely', () => {
  assert.equal('mcpEndpoint' in agentCard({ ...BASE, mcpEndpoint: null }), false);
});

test('capabilities and the mode lists are the same on every card', () => {
  const c = agentCard(BASE);
  assert.deepEqual(c.capabilities, { streaming: false, pushNotifications: false });
  assert.deepEqual(c.defaultInputModes, ['text/plain', 'application/json']);
  assert.deepEqual(c.defaultOutputModes, ['text/plain', 'application/json', 'text/markdown']);
});

test('extra fields are carried through for what one origin advertises alone', () => {
  const c = agentCard({ ...BASE, extra: { securitySchemes: { rola: { type: 'custom' } }, openapiUrl: '/openapi.json' } });
  assert.deepEqual(c.securitySchemes, { rola: { type: 'custom' } });
  assert.equal(c.openapiUrl, '/openapi.json');
});

test('extra cannot clobber the mode lists that define the card contract', () => {
  const c = agentCard({ ...BASE, extra: { defaultInputModes: ['nope'] } });
  assert.deepEqual(c.defaultInputModes, ['text/plain', 'application/json']);
});

test('a licence is omitted rather than emitted empty', () => {
  assert.equal('license' in agentCard(BASE), false);
  const c = agentCard({ ...BASE, license: { name: 'CC-BY-4.0', url: 'https://x', scope: 'content' } });
  assert.equal(c.license.name, 'CC-BY-4.0');
});

test('the cache header is a day at the edge, a week stale', () => {
  assert.match(AGENT_CARD_CACHE_CONTROL, /s-maxage=86400/);
  assert.match(AGENT_CARD_CACHE_CONTROL, /stale-while-revalidate=604800/);
});

test('a card carries the fields a spec-current A2A client requires', () => {
  const card = agentCard({
    name: 'Test Wiki',
    description: 'A wiki.',
    url: 'https://example.com',
    version: '1.0.0',
    skills: [],
  });
  for (const key of [
    'protocolVersion', 'name', 'description', 'url', 'preferredTransport',
    'version', 'capabilities', 'skills', 'defaultInputModes', 'defaultOutputModes',
  ]) {
    assert.ok(card[key] !== undefined, `a card without ${key} is rejected by a v0.3 client`);
  }
  // `url` is where a client sends its first call. The homepage answers HTML.
  assert.equal(card.url, 'https://example.com/api/mcp');
  assert.equal(card.preferredTransport, 'JSONRPC');
  assert.equal(card.provider.url, 'https://example.com');
});

test('an origin with no MCP server still names a callable url', () => {
  const card = agentCard({
    name: 'Test', description: 'x', url: 'https://example.com', version: '1.0.0',
    skills: [], mcpEndpoint: null,
  });
  assert.equal(card.mcpEndpoint, undefined);
  assert.equal(card.url, 'https://example.com');
});

test('one route serves the card at both paths, the manifest, the spec and the proof', async () => {
  const { wellKnownHandler } = await import('wiki-formant/well-known');
  const GET = wellKnownHandler({ agentCard: { a: 1 }, mcpManifest: { m: 1 }, openapi: { o: 1 }, registryAuth: { publicKey: 'k' } });
  const get = doc => GET(new Request(`https://x.test/.well-known/${doc}`), { params: Promise.resolve({ doc }) });
  assert.deepEqual(await (await get('agent.json')).json(), { a: 1 });
  assert.deepEqual(await (await get('agent-card.json')).json(), { a: 1 });
  assert.deepEqual(await (await get('mcp.json')).json(), { m: 1 });
  assert.deepEqual(await (await get('openapi.json')).json(), { o: 1 });
  assert.match(await (await get('mcp-registry-auth')).text(), /k/);
  assert.equal((await get('toString')).status, 404);
  const tenant = wellKnownHandler({ agentCard: {}, mcpManifest: {}, openapi: {}, registryAuth: null });
  assert.equal((await tenant(new Request('https://x.test/'), { params: Promise.resolve({ doc: 'mcp-registry-auth' }) })).status, 404);
});
