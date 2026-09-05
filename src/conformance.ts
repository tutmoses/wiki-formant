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
    structuredContent?: unknown;
    isError?: boolean;
    tools?: Array<{
      name: string;
      description?: string;
      annotations?: Record<string, unknown>;
    }>;
    resources?: Array<{ uri: string }>;
    resourceTemplates?: Array<{ uriTemplate?: string }>;
    contents?: Array<{ text?: string }>;
    serverInfo?: { version?: string };
    protocolVersion?: string;
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

  // The version a server answers is the version its clients get. Asking for one
  // and never looking at the reply is how three servers sat pinned to
  // 2025-03-26 — forfeiting structured output, tool titles and `_meta` — while
  // every suite reported green.
  const echoed = await t.rpc('initialize', {
    protocolVersion: CURRENT_PROTOCOL,
    capabilities: {},
    clientInfo: { name: clientName, version: '1' },
  });
  t.check(
    'protocol negotiated',
    echoed.result?.protocolVersion === CURRENT_PROTOCOL,
    `asked ${CURRENT_PROTOCOL}, got ${echoed.result?.protocolVersion}`,
  );
  t.check(
    'downgrades gracefully',
    (init.result?.protocolVersion ?? '').length > 0,
    `asked 2024-11-05, got ${init.result?.protocolVersion}`,
  );

  console.log(`\n=== transport ===`);

  const opt = await fetch(t.endpoint, { method: 'OPTIONS' });
  t.check(
    'OPTIONS preflight',
    opt.status === 204 &&
      opt.headers.get('access-control-allow-origin') === '*' &&
      (opt.headers.get('access-control-allow-headers') ?? '').includes('Mcp-Protocol-Version'),
    `${opt.status} ACAO=${opt.headers.get('access-control-allow-origin')}`,
  );
  // Allow-Headers governs what a browser may send; Expose-Headers what it may
  // read. Without the second, a browser client cannot see `Retry-After` on a
  // 429 and a rate limit reads to it as a hang.
  t.check(
    'CORS exposes response headers',
    ['Mcp-Protocol-Version', 'Retry-After'].every(h =>
      (opt.headers.get('access-control-expose-headers') ?? '').includes(h),
    ),
    `expose=${opt.headers.get('access-control-expose-headers')}`,
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

  // Declaring `resources` makes a client ask for templates. -32601 to a method
  // the capability implies reads as a broken server, not as "none registered".
  if ('resources' in caps) {
    const templates = await t.rpc('resources/templates/list');
    t.check(
      'resources/templates/list',
      Array.isArray(templates.result?.resourceTemplates),
      templates.error ? `-${templates.error.code}` : `${templates.result?.resourceTemplates?.length} templates`,
    );
  }

  const versioned = await fetch(t.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'MCP-Protocol-Version': CURRENT_PROTOCOL },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  t.recordCall();
  t.check(
    'MCP-Protocol-Version echoed',
    versioned.headers.get('mcp-protocol-version') === CURRENT_PROTOCOL,
    `sent ${CURRENT_PROTOCOL}, got ${versioned.headers.get('mcp-protocol-version')}`,
  );

  // Batching was removed in 2025-06-18. A server that keeps honouring it under
  // a version that forbids it is telling the client something untrue.
  const batched = await fetch(t.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'MCP-Protocol-Version': CURRENT_PROTOCOL },
    body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]),
  });
  t.recordCall();
  t.check('batch refused at 2025-06-18', batched.status === 400, `${batched.status}`);

  return init;
}

/** The newest protocol revision `wiki-formant/mcp` speaks. */
export const CURRENT_PROTOCOL = '2025-06-18';

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
    fetch(`${t.base}/.well-known/agent-card.json`).then(r => r.json() as Promise<Record<string, unknown>>),
    fetch(`${t.base}/.well-known/agent.json`).then(r => r.json() as Promise<Record<string, unknown>>),
  ]);
  t.check('agent card parity', JSON.stringify(a) === JSON.stringify(b), 'agent.json === agent-card.json');

  // A card missing a required field is a card a spec-current client rejects, and
  // parity alone happily reports two identical unusable ones.
  const required = [
    'protocolVersion',
    'name',
    'description',
    'url',
    'preferredTransport',
    'version',
    'capabilities',
    'skills',
    'defaultInputModes',
    'defaultOutputModes',
  ];
  const missing = required.filter(k => a[k] === undefined);
  t.check('agent card complete', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `A2A ${a.protocolVersion}`);

  // `url` is where a client sends its first call. Pointed at the homepage it
  // gets HTML back, which is the failure that looks like a broken agent.
  const endpoint = String(a.url ?? '');
  const probe = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  t.recordCall();
  t.check(
    'agent card url is callable',
    (probe.headers.get('content-type') ?? '').includes('json'),
    `POST ${endpoint} -> ${probe.status} ${probe.headers.get('content-type')}`,
  );
}

/**
 * Any surface an agent recrawls should answer a conditional GET with a 304.
 *
 * Point this at every such surface, not only the corpus exports. Aimed solely
 * at the `llms.*` family — the paths that already had validators — it reported
 * green across three origins whose markdown twins, agent cards and OpenAPI
 * documents carried no ETag at all. A check that only looks where it knows it
 * will pass is a check that measures nothing.
 */
export async function conditionalGetChecks(t: Tester, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    const url = path.startsWith('http') ? path : `${t.base}/${path.replace(/^\//, '')}`;
    const label = path.replace(t.base, '');
    const fresh = await fetch(url);
    const etag = fresh.headers.get('etag');
    // Both validators, not just the one the 304 is driven by. A crawler that
    // sends If-Modified-Since rather than If-None-Match — and several do — gets
    // a full render on every pass from a response that carries no Last-Modified,
    // and the ETag check alone would call that surface conformant.
    const lastModified = fresh.headers.get('last-modified');
    const revalidated = etag ? await fetch(url, { headers: { 'If-None-Match': etag } }) : null;
    t.check(`${label} 304`, !!etag && revalidated?.status === 304, `etag=${etag} revalidate=${revalidated?.status}`);
    t.check(`${label} last-modified`, !!lastModified, `${fresh.status} ${lastModified}`);
    // A list is what a client that holds two revisions actually sends, and the
    // weak prefix is what a proxy adds in transit. Exact string equality passes
    // the check above and fails both of these.
    if (etag) {
      const listed = await fetch(url, { headers: { 'If-None-Match': `W/"stale-x", ${etag}` } });
      t.check(`${label} 304 (etag list)`, listed.status === 304, `${listed.status}`);
    }
  }
}

/**
 * Every tool carries behavioural hints, and the ones that write say so.
 *
 * Without them a client that auto-approves read-only calls has no way to tell a
 * lookup from one that signs a transaction — and two of the three servers here
 * shipped write tools with no annotations at all.
 */
export async function annotationChecks(
  t: Tester,
  opts: { writes?: readonly string[] } = {},
): Promise<void> {
  const tools = (await t.rpc('tools/list')).result?.tools ?? [];
  const writes = new Set(opts.writes ?? []);
  const unannotated = tools.filter(x => x.annotations?.readOnlyHint === undefined);
  t.check(
    'tools annotated',
    unannotated.length === 0,
    unannotated.length ? `missing readOnlyHint: ${unannotated.map(x => x.name).join(', ')}` : `${tools.length} tools`,
  );
  const mislabelled = tools.filter(x => writes.has(x.name) && x.annotations?.readOnlyHint !== false);
  t.check(
    'writes not marked read-only',
    mislabelled.length === 0,
    mislabelled.length ? mislabelled.map(x => x.name).join(', ') : `${writes.size} write tools`,
  );
  const thin = tools.filter(x => (x.description ?? '').length < 120);
  t.check(
    'descriptions carry a usage note',
    thin.length === 0,
    thin.length ? thin.map(x => `${x.name}:${(x.description ?? '').length}ch`).join(' ') : `min ${Math.min(...tools.map(x => (x.description ?? '').length))}ch`,
  );
}

/**
 * The orientation calls stay inside a context window.
 *
 * A tool that passes a metadata column straight through is one stored blob away
 * from returning 350 KB — around 90k tokens — from the first call an agent
 * makes. Nothing in a pass/fail table notices that unless something weighs the
 * answer, so this weighs it.
 */
export async function payloadBudget(
  t: Tester,
  calls: ReadonlyArray<{ name: string; args?: Record<string, unknown> }>,
  maxBytes = 120_000,
): Promise<void> {
  for (const { name, args } of calls) {
    const text = (await t.call(name, args ?? {})).result?.content?.[0]?.text ?? '';
    t.check(
      `${name} within budget`,
      text.length <= maxBytes,
      `${text.length.toLocaleString()} chars (max ${maxBytes.toLocaleString()})`,
    );
  }
}

/**
 * The default `User-agent: *` group may reach everything the descriptors
 * advertise.
 *
 * An origin whose card names an MCP endpoint its own robots.txt disallows to
 * every unnamed crawler is telling two different stories to the same caller.
 */
export async function robotsChecks(t: Tester, paths: readonly string[]): Promise<void> {
  const body = await (await fetch(`${t.base}/robots.txt`)).text();
  const rules: Array<{ allow: boolean; path: string }> = [];
  let inStar = false;
  for (const raw of body.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    const [field, ...rest] = line.split(':');
    if (!field || !rest.length) continue;
    const key = field.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') inStar = value === '*';
    else if (inStar && (key === 'allow' || key === 'disallow') && value) {
      rules.push({ allow: key === 'allow', path: value });
    }
  }
  for (const path of paths) {
    // Longest match wins, Allow breaking a tie — the rule every major crawler
    // implements.
    const match = rules
      .filter(r => path.startsWith(r.path.replace(/\*$/, '')))
      .sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow))[0];
    t.check(`robots allows ${path}`, !match || match.allow, match ? `${match.allow ? 'Allow' : 'Disallow'}: ${match.path}` : 'no matching rule');
  }
}
