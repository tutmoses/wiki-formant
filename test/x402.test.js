import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatePaidCalls } from '../dist/x402.js';

const PAID = {
  kind: 'tool',
  resource: 'mcp://tool/get_catalogue',
  price: '$0.01',
  mimeType: 'application/json',
  description: 'The whole catalogue.',
  unpaidMessage: 'Payment required. Everything else here is free.',
  discovery: { toolName: 'get_catalogue' },
  context: { toolName: 'tools/call:get_catalogue' },
};

const resolve = entry =>
  entry.method === 'tools/call' && entry.params?.name === 'get_catalogue' ? PAID : null;

const stubServer = (over = {}) => ({
  buildPaymentRequirements: async () => ({ accepts: true }),
  createPaymentRequiredResponse: async (_a, _r, error) => ({ x402Version: 2, error }),
  findMatchingRequirements: () => ({ requirements: true }),
  verifyPayment: async () => ({ isValid: true }),
  settlePayment: async () => ({ success: true, transaction: '0xdead' }),
  ...over,
});

const base = server => ({
  server: async () => server,
  resolve,
  network: 'eip155:84532',
  payTo: '0xpay',
  maxTimeoutSeconds: 120,
  serviceName: 'Test',
  tags: ['test'],
  maxBatch: 20,
  declareDiscovery: async d => ({ bazaar: d }),
});

const call = (id, name, meta) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, ...(meta ? { _meta: meta } : {}) },
});

test('a free envelope never touches the facilitator', async () => {
  let built = false;
  const gate = await gatePaidCalls(call(1, 'search'), base(stubServer({
    buildPaymentRequirements: async () => { built = true; return {}; },
  })));
  assert.equal(built, false);
  assert.equal(gate.empty, false);
  assert.deepEqual(gate.body, call(1, 'search'));
});

test('an unpaid call is withheld before dispatch and answered as an isError result', async () => {
  const gate = await gatePaidCalls([call(1, 'search'), call(2, 'get_catalogue')], base(stubServer()));
  // Only the free call reaches handleMcp.
  assert.deepEqual(gate.body, [call(1, 'search')]);
  assert.equal(gate.empty, false);

  const out = await gate.finish([{ jsonrpc: '2.0', id: 1, result: { ok: true } }]);
  assert.equal(out.length, 2);
  // Rebuilt in the caller's original order, challenge spliced back in.
  assert.equal(out[0].id, 1);
  assert.equal(out[1].id, 2);
  assert.equal(out[1].result.isError, true);
  assert.equal(out[1].result.structuredContent.error, PAID.unpaidMessage);
});

test('a single unpaid call leaves nothing to dispatch', async () => {
  const gate = await gatePaidCalls(call(9, 'get_catalogue'), base(stubServer()));
  assert.equal(gate.empty, true);
  const out = await gate.finish(null);
  assert.equal(out.id, 9);
  assert.equal(out.result.isError, true);
});

test('a paid call dispatches and carries its receipt back in result._meta', async () => {
  const paid = call(3, 'get_catalogue', { 'x402/payment': { x402Version: 2, payload: {} } });
  const gate = await gatePaidCalls(paid, base(stubServer()));
  assert.deepEqual(gate.body, paid);

  const out = await gate.finish({ jsonrpc: '2.0', id: 3, result: { content: [] } });
  assert.deepEqual(out.result._meta['x402/payment-response'], { success: true, transaction: '0xdead' });
});

test('a handler that errored is not settled', async () => {
  let settled = false;
  const paid = call(4, 'get_catalogue', { 'x402/payment': { x402Version: 2, payload: {} } });
  const gate = await gatePaidCalls(paid, base(stubServer({
    settlePayment: async () => { settled = true; return { success: true }; },
  })));

  const out = await gate.finish({ jsonrpc: '2.0', id: 4, result: { content: [], isError: true } });
  assert.equal(settled, false);
  assert.equal(out.result._meta, undefined);
});

test('settlement that fails withholds the bytes it would have paid for', async () => {
  const paid = call(5, 'get_catalogue', { 'x402/payment': { x402Version: 2, payload: {} } });
  const gate = await gatePaidCalls(paid, base(stubServer({
    settlePayment: async () => ({ success: false }),
  })));
  const out = await gate.finish({ jsonrpc: '2.0', id: 5, result: { content: [{ secret: true }] } });
  assert.equal(out.result.isError, true);
  assert.match(out.result.content[0].text, /settlement failed/i);
});

test('an unreachable facilitator withholds only the paid entry', async () => {
  const gate = await gatePaidCalls([call(1, 'search'), call(2, 'get_catalogue')], {
    ...base(null),
    server: async () => { throw new Error('facilitator down'); },
  });
  assert.deepEqual(gate.body, [call(1, 'search')]);
  const out = await gate.finish([{ jsonrpc: '2.0', id: 1, result: { ok: true } }]);
  assert.equal(out[1].result.isError, true);
  assert.match(out[1].result.content[0].text, /temporarily unavailable/i);
});

test('an oversized batch passes through untouched, so handleMcp can reject it whole', async () => {
  const raw = Array.from({ length: 21 }, (_, i) => call(i, 'get_catalogue'));
  const gate = await gatePaidCalls(raw, base(stubServer()));
  assert.equal(gate.body.length, 21);
  assert.equal(gate.empty, false);
});

test('enabled:false is a pure passthrough', async () => {
  const raw = call(1, 'get_catalogue');
  const gate = await gatePaidCalls(raw, { ...base(stubServer()), enabled: false });
  assert.deepEqual(gate.body, raw);
  assert.deepEqual(await gate.finish({ id: 1 }), { id: 1 });
});
