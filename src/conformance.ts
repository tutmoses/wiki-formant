// conformance.ts — the half of an MCP conformance run that is not about any one
// server's tools.
//
// All three apps here ship a `scripts/_mcp-test.ts` that hits its live endpoints
// over HTTP exactly as an agent would, and all three had written the same JSON-RPC
// client, the same pass/fail table, and the same transport assertions: the CORS
// preflight, GET→405, a notification answering 202-with-no-body, a parse error
// carrying -32700, the batch cap, and honest `capabilities`.
//
// Those assertions are about the transport, and the transport is `mcp.ts` in this
// same package — so the suite that checks it belongs next to it. What each app
// keeps is its own fixtures: which tools it expects, what a good answer from each
// looks like, and which text surfaces it publishes.

export interface Rpc {
  result?: {
    content?: Array<{ text?: string }>;
    isError?: boolean;
    tools?: Array<{ name: string }>;
    resources?: Array<{ uri: string }>;
    contents?: Array<{ text?: string }>;
    serverInfo?: { version?: string };
    capabilities?: Record<string, unknown>;
    instructions?: string;
  };
  error?: { code: number; message: string; data?: { availableTools?: string[] } };
}

export interface CheckResult {
  tool: string;
  ok: boolean;
  note: string;
}

export interface TesterOptions {
  /** Origin under test, no trailing slash. */
  base: string;
  /** MCP endpoint. Defaults to `${base}/api/mcp`. */
  endpoint?: string;
  /** Sent as clientInfo.name on initialize, and as the User-Agent. */
  clientName: string;
}

export interface Tester {
  base: string;
  endpoint: string;
  /** One JSON-RPC call. Backs off once and retries on a 429. */
  rpc(method: string, params?: unknown): Promise<Rpc>;
  /** `tools/call` shorthand. */
  call(name: string, args?: Record<string, unknown>): Promise<Rpc>;
  /** The decoded body of a tool result: parsed JSON, raw text, or the error. */
  payload(r: Rpc): unknown;
  /** Record an assertion and print it as it happens. */
  check(label: string, ok: boolean, note: string): void;
  results: CheckResult[];
  /** JSON-RPC calls made so far. */
  callCount(): number;
  /**
   * Count a call this tester did not make. A surface with more than one MCP
   * endpoint drives the others itself; without this the tally under-reports.
   */
  recordCall(): void;
  /** Print the tally and return the process exit code. */
  summary(): number;
}

export function createTester(opts: TesterOptions): Tester {
  const base = opts.base.replace(/\/$/, '');
  const endpoint = opts.endpoint ?? `${base}/api/mcp`;
  const results: CheckResult[] = [];
  let calls = 0;

  const rpc = async (method: string, params?: unknown): Promise<Rpc> => {
    calls++;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': opts.clientName },
      body: JSON.stringify({ jsonrpc: '2.0', id: calls, method, params }),
    });
    // The server's own rate limit is part of what is under test elsewhere; here
    // it is just noise, so wait it out once rather than failing the run.
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 5000));
      return rpc(method, params);
    }
    return (await res.json()) as Rpc;
  };

  return {
    base,
    endpoint,
    rpc,
    call: (name, args = {}) => rpc('tools/call', { name, arguments: args }),
    payload(r) {
      const text = r.result?.content?.[0]?.text;
      if (text == null) return r.error ? { _error: r.error } : r.result;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
    check(tool, ok, note) {
      results.push({ tool, ok, note });
      console.log(`${ok ? '  PASS' : '  FAIL'}  ${tool.padEnd(24)} ${note}`);
    },
    results,
    callCount: () => calls,
    recordCall: () => { calls++; },
    summary() {
      const failed = results.filter(r => !r.ok);
      console.log(`\n──────── ${results.length - failed.length}/${results.length} passed, ${calls} JSON-RPC calls ────────`);
      for (const f of failed) console.log(`FAILED: ${f.tool} — ${f.note}`);
      return failed.length ? 1 : 0;
    },
  };
}

/**
 * The transport edges every spec-correct MCP server over HTTP must get right,
 * independent of what tools it exposes. Returns the `initialize` response, since
 * callers go on to assert against its serverInfo.
 */
export async function transportChecks(
  t: Tester,
  clientName: string,
  /**
   * The capability keys this server actually implements. The assertion is that
   * a server declares what it has — which keys those are is the server's own
   * business, so it is a parameter rather than one surface's set hardcoded here.
   */
  expectedCapabilities: readonly string[] = ['tools'],
): Promise<Rpc> {
  console.log(`\n=== MCP server  ${t.endpoint} ===`);
  const init = await t.rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: clientName, version: '1' },
  });
  t.check('initialize', !!init.result?.serverInfo && !!init.result?.instructions, JSON.stringify(init.result?.serverInfo ?? init.error));

  console.log(`\n=== transport ===`);

  const opt = await fetch(t.endpoint, { method: 'OPTIONS' });
  t.check(
    'OPTIONS preflight',
    opt.status === 204 &&
      opt.headers.get('access-control-allow-origin') === '*' &&
      (opt.headers.get('access-control-allow-headers') ?? '').includes('Mcp-Protocol-Version'),
    `${opt.status} ACAO=${opt.headers.get('access-control-allow-origin')}`,
  );

  const get = await fetch(t.endpoint);
  t.check(
    'GET→405',
    get.status === 405 && get.headers.get('access-control-allow-origin') === '*',
    `${get.status} Allow=${get.headers.get('allow')} ACAO=${get.headers.get('access-control-allow-origin')}`,
  );

  // A notification has no id, so it must be acknowledged with no body at all —
  // a JSON-RPC response to one is a protocol error.
  const notif = await fetch(t.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  const notifBody = await notif.text();
  t.check('notification→202', notif.status === 202 && notifBody === '', `${notif.status} body="${notifBody}"`);

  const bad = await fetch(t.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json' });
  const badJson = (await bad.json()) as Rpc;
  t.check('parse error→400', bad.status === 400 && badJson.error?.code === -32700, `${bad.status} code=${badJson.error?.code}`);

  const over = await fetch(t.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Array.from({ length: 21 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' }))),
  });
  const overJson = (await over.json()) as Rpc;
  t.check('batch cap (21)', overJson.error?.code === -32600, `code=${overJson.error?.code}: ${(overJson.error?.message ?? '').slice(0, 80)}`);

  const caps = init.result?.capabilities ?? {};
  t.check(
    'capabilities honest',
    expectedCapabilities.every(k => k in caps),
    `${JSON.stringify(caps)} expected=[${expectedCapabilities.join(', ')}]`,
  );

  return init;
}

/**
 * One service, many descriptors — server.json, the two agent-card paths, the
 * OpenAPI document, the MCP server card, and `initialize` — should never
 * disagree about the version. Pass the URLs this origin actually serves.
 */
export async function versionCoherence(
  t: Tester,
  expected: string,
  sources: Record<string, { url: string; at: (json: Record<string, unknown>) => unknown }>,
  initVersion?: string,
): Promise<void> {
  const found: Record<string, unknown> = { init: initVersion };
  for (const [label, { url, at }] of Object.entries(sources)) {
    try {
      found[label] = at((await (await fetch(url)).json()) as Record<string, unknown>);
    } catch {
      found[label] = '<unreachable>';
    }
  }
  const all = Object.values(found).filter(v => v !== undefined);
  t.check(
    'version coherence',
    all.every(v => v === expected),
    `expected=${expected} ` + Object.entries(found).map(([k, v]) => `${k}=${v}`).join(' '),
  );
}

/**
 * Both A2A well-known paths must serve the identical card. v0.3 renamed
 * agent.json to agent-card.json and defined no fallback either way, so an origin
 * that lets them drift answers two different questions to two halves of its
 * callers.
 */
export async function agentCardParity(t: Tester): Promise<void> {
  const [a, b] = await Promise.all([
    fetch(`${t.base}/.well-known/agent-card.json`).then(r => r.json()),
    fetch(`${t.base}/.well-known/agent.json`).then(r => r.json()),
  ]);
  t.check('agent card parity', JSON.stringify(a) === JSON.stringify(b), 'agent.json === agent-card.json');
}

/**
 * A corpus export that costs a full render should answer a conditional GET with
 * a 304. Checks each path serves an ETag and honours it on the way back.
 */
export async function conditionalGetChecks(t: Tester, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    const fresh = await fetch(`${t.base}/${path}`);
    const etag = fresh.headers.get('etag');
    const revalidated = etag ? await fetch(`${t.base}/${path}`, { headers: { 'If-None-Match': etag } }) : null;
    t.check(`${path} 304`, !!etag && revalidated?.status === 304, `etag=${etag} revalidate=${revalidated?.status}`);
  }
}
