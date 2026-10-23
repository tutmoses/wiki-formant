import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wellKnownHandler } from 'wiki-formant/well-known';

const GET = wellKnownHandler({ agentCard: { name: 'card' }, openapi: { openapi: '3.1.0' }, registryAuth: null });
const get = doc => GET(new Request(`https://x.test/.well-known/${doc}`), { params: Promise.resolve({ doc }) });

test('both card paths serve the one card, with a validator', async () => {
  const a = await get('agent.json');
  const b = await get('agent-card.json');
  assert.equal(a.status, 200);
  assert.deepEqual(await a.json(), await b.json());
  assert.ok(a.headers.get('etag'));
});

test('a document the app did not pass is a 404, and so is a stray path', async () => {
  assert.equal((await get('mcp.json')).status, 404);
  assert.equal((await get('mcp-registry-auth')).status, 404);
  assert.equal((await get('constructor')).status, 404);
  assert.equal((await get('openapi.json')).status, 200);
});
