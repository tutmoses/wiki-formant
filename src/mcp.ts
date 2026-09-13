// mcp.ts — a minimal Model Context Protocol server over Streamable HTTP
// (JSON-RPC), serving both protocol eras from one endpoint.
// Spec: https://modelcontextprotocol.io/specification/2026-07-28
//
// Web-standard `Request`/`Response` only, so this runs unchanged on Next route
// handlers (NextResponse extends Response), Hono, Bun, Deno and workers.
//
// Two things exist here purely so a caller that gets it wrong gets it right on
// the retry: `inputSchema` is a shape this module actually validates against —
// naming the bad field and enumerating the legal values rather than coercing
// junk and returning an empty result — and `instructions` rides on `initialize`
// so an agent learns the intended call sequence before it has to guess.
//
// A caller-fixable mistake is a tool result with `isError`, never a -32603.
// That split is the one most implementations get wrong.

/**
 * The modern era: every request carries its own version and client
 * capabilities in `params._meta`. No handshake, no session, no `ping`, no batch.
 */
export const MCP_MODERN_VERSIONS = ['2026-07-28'] as const;

/**
 * The legacy era, negotiated by an `initialize` handshake.
 *
 * Served beside the modern era rather than replaced by it. The spec lets one
 * endpoint speak both, and a legacy client meeting a dual-era server works;
 * going modern-only would fail the handshake of every client in the field.
 */
export const MCP_LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

/**
 * Every version this transport speaks, newest first. It is the `supported` list
 * a `-32022` names and the `supportedVersions` of `server/discover`, so a modern
 * client that cannot use the newest still learns a legacy fallback exists.
 */
export const MCP_PROTOCOL_VERSIONS = [...MCP_MODERN_VERSIONS, ...MCP_LEGACY_VERSIONS] as const;
export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];
type LegacyVersion = (typeof MCP_LEGACY_VERSIONS)[number];

/** The newest version spoken here. */
export const MCP_PROTOCOL_VERSION: McpProtocolVersion = MCP_PROTOCOL_VERSIONS[0];

/**
 * The newest version `initialize` can negotiate, and what an unrecognised ask is
 * offered. A handshake cannot land on a modern version — the modern era has no
 * handshake — so this, not `MCP_PROTOCOL_VERSION`, is what a legacy client gets.
 */
export const MCP_LEGACY_PROTOCOL_VERSION: LegacyVersion = MCP_LEGACY_VERSIONS[0];

/** The reserved `_meta` keys the modern era is spelled in. */
export const MCP_META = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
} as const;

/** What a legacy request carrying no `MCP-Protocol-Version` header means, per the spec. */
const ASSUMED_VERSION: LegacyVersion = '2025-03-26';

const member =
  <T extends string>(list: readonly T[]) =>
  (v: unknown): v is T =>
    (list as readonly unknown[]).includes(v);
const speaksLegacy = member(MCP_LEGACY_VERSIONS);
const speaksModern = member(MCP_MODERN_VERSIONS);

/**
 * Echo the client's version when it is one we speak, else offer the newest.
 * Answering a constant instead is legal and still wrong: it silently held every
 * caller below the version that carries structured output and `_meta`.
 */
function negotiateProtocol(requested: unknown): LegacyVersion {
  return speaksLegacy(requested) ? requested : MCP_LEGACY_PROTOCOL_VERSION;
}

/** The version a post-initialize request is operating under. */
function requestProtocol(request: Request): LegacyVersion {
  const header = request.headers.get('mcp-protocol-version');
  return speaksLegacy(header) ? header : ASSUMED_VERSION;
}

/** JSON-RPC batching was removed in 2025-06-18 and stays removed; it is legal only below that. */
const allowsBatch = (v: LegacyVersion) => v === '2025-03-26' || v === '2024-11-05';

import { clientKey, rateLimit, rateLimitHeaders, withRateLimit, type RateLimitOptions } from './rate-limit.js';

export type ToolParam = {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  enum?: string[];
  items?: { type: 'string' | 'number' | 'object' };
};

export type ToolSchema = {
  type: 'object';
  properties: Record<string, ToolParam>;
  required?: string[];
  /**
   * At least one of these must be present. `required` cannot say "query or
   * popular", so a tool needing that checked it in its handler and the caller
   * only learned at execution time — the one class of argument mistake this
   * module was otherwise catching before dispatch.
   */
  requireOneOf?: string[];
};

/**
 * Behavioural hints a client uses to decide what needs a human in the loop.
 * Without them every tool looks alike, so a client that auto-approves read-only
 * calls has no way to tell a lookup from one that reaches a payment processor.
 */
export type ToolAnnotations = {
  /** Does not modify anything. */
  readOnlyHint?: boolean;
  /** May destroy or overwrite state (only meaningful when not read-only). */
  destructiveHint?: boolean;
  /** Repeating the identical call has no additional effect. */
  idempotentHint?: boolean;
  /** Touches systems beyond this server. */
  openWorldHint?: boolean;
};

/**
 * What a handler can see of the call beyond its arguments, and its one channel
 * back out. `_meta` carries everything that is *about* a call rather than in it
 * — a payment receipt, a progress token — and a handler returning a bare value
 * could reach none of it.
 */
export interface ToolContext {
  /** `params._meta` as it arrived. */
  meta: Record<string, unknown>;
  /** Set a key on this result's `_meta`. */
  setMeta: (key: string, value: unknown) => void;
  /** The version negotiated for this request. */
  protocolVersion: McpProtocolVersion;
  /** The HTTP request, where the mount had one to give. */
  request?: Request;
}

export interface McpTool {
  name: string;
  /** Human-facing label. 2025-06-18 promoted this out of `annotations`. */
  title?: string;
  description: string;
  inputSchema: ToolSchema;
  /**
   * Declare it and the result carries `structuredContent` beside the text, so a
   * client reads the answer instead of scraping prose for it.
   */
  outputSchema?: ToolSchema;
  annotations?: ToolAnnotations;
  /** Surfaced as an A2A skill on the agent card. Not sent over MCP. */
  skill?: { id: string; tags: string[]; examples?: string[] };
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

export interface McpResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  read: () => Promise<string | null>;
}

export interface McpPrompt {
  name: string;
  description: string;
  /**
   * The user message the client inserts when someone picks this prompt. Name
   * the tool sequence outright rather than restating the question: the model
   * reading it has the tool list but no reason to prefer one call order over
   * another, which is the same gap `instructions` exists to close.
   */
  text: string;
}

export interface McpServerConfig {
  serverInfo: { name: string; version: string };
  /**
   * Server-level usage guide returned by `initialize`. Say which tool to reach
   * for first and what NOT to do; it is the only text an agent sees before the
   * tool list.
   */
  instructions: string;
  tools: McpTool[];
  resources?: McpResource[];
  /**
   * The entry point a client offers after install. Tools are what an agent
   * reaches for once it already has a question; prompts are what a person
   * clicks when they do not have one yet.
   */
  prompts?: McpPrompt[];
  /** Appended to the GET refusal so a browser that lands here learns where to go. */
  docsUrl?: string;
  /**
   * How long, in ms, a modern client may reuse `server/discover`, a list or a
   * read. The modern era requires the hint on each of those. Defaults to five
   * minutes: tool and prompt lists only change on deploy.
   */
  cacheTtlMs?: number;
  /**
   * Cap on JSON-RPC batch size. The rate limiter charges one token per HTTP
   * request, before the body is parsed — an unbounded batch would let a single
   * token fan out into thousands of concurrent handler executions, each its own
   * query. Keep this aligned with whatever ceiling the batching tools advertise.
   */
  maxBatch?: number;
  /**
   * Per-IP budget for this endpoint.
   *
   * Declared rather than wired: the four routes in this workspace each spelled
   * out the same verdict → refuse → answer → attach-headroom dance through
   * three differently-named local helpers, two of them taking an async detour
   * through the framework's `headers()` to reach a `Request` that was already
   * in hand. A surface that states a budget owes the same four things every
   * time, so stating the budget is now the whole of it — and the headroom
   * header cannot be the part a new surface forgets.
   *
   * Enforced before the body is parsed, deliberately: an unparsed body must not
   * cost a query.
   */
  rateLimit?: RateLimitOptions & {
    /** Bucket namespace. Defaults to `mcp`; endpoints sharing it share a bucket. */
    prefix?: string;
  };
  /** Per-request analytics hook. Runs before dispatch; never blocks the response. */
  onCall?: (request: Request, body: unknown) => void;
  /**
   * Envelope-level middleware: it may withhold entries before dispatch and
   * merge its own responses back in afterwards. A payment gate has to sit here
   * rather than in a handler, because the demand *replaces* the call and the
   * receipt rides on the envelope. Without this hook one surface had rebuilt
   * the whole of `mcpResponse` by hand to wrap it.
   */
  gate?: (body: unknown) => Promise<EnvelopeGate>;
}

/** What a `gate` hands back: the body to dispatch, and how to finish. */
export interface EnvelopeGate {
  body: RpcRequest | RpcRequest[];
  /** Every entry withheld — dispatch nothing rather than an empty batch. */
  empty: boolean;
  finish(dispatched: object | object[] | null): Promise<object | object[] | null>;
}

/**
 * A caller-fixable failure inside a handler (page not found, empty input).
 * Reported as a tool result with `isError` so the model sees the text and can
 * correct itself, per the spec's split between protocol and execution errors.
 */
export class McpToolError extends Error {
  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'McpToolError';
  }
}

/** One entry in a JSON-RPC envelope. Exported because `wiki-formant/x402`
 *  gates the envelope before `handleMcp` ever sees it. */
export type RpcRequest = { jsonrpc: '2.0'; id: string | number | null; method: string; params?: unknown };
type RpcId = string | number | null;

/** How many entries one JSON-RPC batch may carry. Quoted by the conformance suite. */
export const DEFAULT_MAX_BATCH = 20;

const quote = (list: readonly string[]) => list.map(s => `"${s}"`).join(', ');

function typeOf(v: unknown): string {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

const rpcError = (id: RpcId, code: number, message: string, data?: object) => ({
  jsonrpc: '2.0' as const,
  id,
  error: { code, message, ...(data ? { data } : {}) },
});

/**
 * A tool result envelope. Exported because `x402.ts` builds the same shape when
 * it withholds a paid call, and had grown two more copies of it doing so.
 */
export const toolText = (
  id: RpcRequest['id'],
  text: string,
  isError = false,
  extra: Record<string, unknown> = {},
) => ({
  jsonrpc: '2.0' as const,
  id,
  result: { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}), ...extra },
});

/**
 * Every problem with the call at once, each naming the field and its legal
 * values, plus the schema — one retry should be able to fix all of them.
 */
function validateArgs(tool: McpTool, args: Record<string, unknown>): string | null {
  const { properties, required = [], requireOneOf } = tool.inputSchema;
  const allowed = Object.keys(properties);
  const problems: string[] = [];

  for (const key of Object.keys(args)) {
    if (key in properties) continue;
    problems.push(
      allowed.length
        ? `Unknown parameter "${key}". Allowed parameters: ${quote(allowed)}.`
        : `Unknown parameter "${key}". This tool takes no parameters.`,
    );
  }

  for (const key of required) {
    if (args[key] === undefined || args[key] === null) {
      problems.push(`Missing required parameter "${key}". Required: ${quote(required)}.`);
    }
  }

  if (requireOneOf?.length && !requireOneOf.some(k => args[k] !== undefined && args[k] !== null)) {
    problems.push(`Provide at least one of ${quote(requireOneOf)}.`);
  }

  for (const [key, spec] of Object.entries(properties)) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    const actual = typeOf(value);

    if (spec.type === 'number') {
      // A numeric string is accepted — some clients stringify everything.
      const numeric =
        actual === 'number' ||
        (actual === 'string' && String(value).trim() !== '' && Number.isFinite(Number(value)));
      if (!numeric) {
        problems.push(
          `Parameter "${key}" must be a number; received ${actual} (${JSON.stringify(value)}).`,
        );
      }
    } else if (spec.type === 'array') {
      const itemType = spec.items?.type ?? 'string';
      if (actual !== 'array') {
        problems.push(
          `Parameter "${key}" must be an array of ${itemType}s; received ${actual} (${JSON.stringify(value)}).`,
        );
      } else if ((value as unknown[]).some(item => typeOf(item) !== itemType)) {
        problems.push(`Parameter "${key}" must contain only ${itemType}s.`);
      }
    } else if (actual !== spec.type) {
      problems.push(
        `Parameter "${key}" must be a ${spec.type}; received ${actual} (${JSON.stringify(value)}).`,
      );
    } else if (spec.enum && !spec.enum.includes(value as string)) {
      problems.push(
        `Parameter "${key}" must be one of ${quote(spec.enum)}; received ${JSON.stringify(value)}.`,
      );
    }
  }

  if (!problems.length) return null;
  return [
    `Invalid arguments for ${tool.name}:`,
    ...problems.map(p => `- ${p}`),
    '',
    `Expected schema: ${JSON.stringify(tool.inputSchema)}`,
  ].join('\n');
}

/** The methods one era has and the other does not. Everything else is shared. */
const ERA_METHODS = {
  legacy: ['initialize', 'ping'],
  modern: ['server/discover'],
} as const;

type Era = keyof typeof ERA_METHODS;

function methodsFor(config: McpServerConfig, era: Era): string[] {
  return [
    ...ERA_METHODS[era],
    'tools/list',
    'tools/call',
    // The list methods answer whether or not anything is registered: an empty
    // list is a better answer to a client that asked than a -32601 it has to
    // interpret.
    'resources/list',
    'resources/templates/list',
    'prompts/list',
    ...(config.resources?.length ? ['resources/read'] : []),
    ...(config.prompts?.length ? ['prompts/get'] : []),
  ];
}

const methodNotFound = (id: RpcId, method: string, config: McpServerConfig, era: Era) => {
  const methods = methodsFor(config, era);
  return rpcError(
    id,
    -32601,
    `Method not found: "${method}". This server implements: ${quote(methods)}.`,
    { supportedMethods: methods },
  );
};

/**
 * Only the capabilities the config actually populates — an advertised
 * `resources` whose list comes back empty reads as a bug to a client, not as
 * honesty. One function, so `initialize` and `server/discover` cannot disagree.
 */
const capabilitiesOf = (config: McpServerConfig) => ({
  tools: {},
  ...(config.resources?.length ? { resources: {} } : {}),
  ...(config.prompts?.length ? { prompts: {} } : {}),
});

/** Everything the dispatcher needs that is not in the JSON-RPC entry itself. */
interface Dispatch {
  protocolVersion: McpProtocolVersion;
  era: Era;
  request?: Request;
}

async function handleRpc(
  req: RpcRequest,
  config: McpServerConfig,
  dispatch: Dispatch,
): Promise<object | null> {
  const { id, method, params } = req;
  const p = (params ?? {}) as Record<string, unknown>;
  const resources = config.resources ?? [];
  const prompts = config.prompts ?? [];

  // A method the other era owns is not found in this one, however well the
  // server knows it: a modern `ping` is a removed method, not a pong.
  const foreign: readonly string[] = ERA_METHODS[dispatch.era === 'modern' ? 'legacy' : 'modern'];
  if (foreign.includes(method)) return methodNotFound(id, method, config, dispatch.era);

  try {
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: negotiateProtocol(p.protocolVersion),
            capabilities: capabilitiesOf(config),
            serverInfo: config.serverInfo,
            instructions: config.instructions,
          },
        };

      // What `initialize` tells a legacy client, asked the modern way. The
      // transport adds `resultType`, the cache hints and `_meta` serverInfo.
      case 'server/discover':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            supportedVersions: [...MCP_PROTOCOL_VERSIONS],
            capabilities: capabilitiesOf(config),
            instructions: config.instructions,
          },
        };

      // Notifications have no response at all.
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: config.tools.map(
              ({ name, title, description, inputSchema, outputSchema, annotations }) => ({
                name,
                ...(title ? { title } : {}),
                description,
                inputSchema,
                ...(outputSchema ? { outputSchema } : {}),
                ...(annotations ? { annotations } : {}),
              }),
            ),
          },
        };

      case 'resources/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            resources: resources.map(({ uri, name, description, mimeType }) => ({
              uri,
              name,
              description,
              mimeType,
            })),
          },
        };

      // Declared `resources` makes a client ask for templates too. There are
      // none to give — every resource here is a fixed URI — but an empty list
      // is the answer to that question, where -32601 reads as a broken server.
      case 'resources/templates/list':
        return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } };

      case 'resources/read': {
        const { uri } = p as { uri?: string };
        const resource = uri ? resources.find(r => r.uri === uri) : undefined;
        const content = resource ? await resource.read() : null;
        if (content == null) {
          const uris = resources.map(r => r.uri);
          const lead = uri ? `Unknown resource "${uri}".` : 'Missing "uri" in params.';
          return rpcError(
            id,
            -32602,
            `${lead} This server exposes: ${uris.length ? quote(uris) : 'no resources'}.`,
            { availableResources: uris },
          );
        }
        return {
          jsonrpc: '2.0',
          id,
          result: { contents: [{ uri, mimeType: resource!.mimeType, text: content }] },
        };
      }

      case 'prompts/list':
        return {
          jsonrpc: '2.0',
          id,
          result: { prompts: prompts.map(({ name, description }) => ({ name, description })) },
        };

      case 'prompts/get': {
        const { name } = p as { name?: string };
        const prompt = name ? prompts.find(x => x.name === name) : undefined;
        if (!prompt) {
          const names = prompts.map(x => x.name);
          const lead = name ? `Unknown prompt "${name}".` : 'Missing "name" in params.';
          return rpcError(
            id,
            -32602,
            `${lead} This server exposes: ${names.length ? quote(names) : 'no prompts'}.`,
            { availablePrompts: names },
          );
        }
        return {
          jsonrpc: '2.0',
          id,
          result: {
            description: prompt.description,
            messages: [{ role: 'user', content: { type: 'text', text: prompt.text } }],
          },
        };
      }

      case 'tools/call': {
        const { name, arguments: rawArgs = {} } = p as { name?: string; arguments?: unknown };
        const names = config.tools.map(t => t.name);
        const tool = name ? config.tools.find(t => t.name === name) : undefined;
        if (!tool) {
          const lead = name ? `Unknown tool "${name}".` : 'Missing "name" in params.';
          return rpcError(id, -32602, `${lead} This server exposes: ${quote(names)}.`, {
            availableTools: names,
          });
        }
        if (typeOf(rawArgs) !== 'object') {
          return toolText(
            id,
            `"arguments" must be an object; received ${typeOf(rawArgs)}. Expected schema: ${JSON.stringify(tool.inputSchema)}`,
            true,
          );
        }
        const args = rawArgs as Record<string, unknown>;
        const invalid = validateArgs(tool, args);
        if (invalid) return toolText(id, invalid, true);

        const out: Record<string, unknown> = {};
        const ctx: ToolContext = {
          meta: (p._meta ?? {}) as Record<string, unknown>,
          setMeta: (key, value) => {
            out[key] = value;
          },
          protocolVersion: dispatch.protocolVersion,
          request: dispatch.request,
        };

        try {
          const data = await tool.handler(args, ctx);
          const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
          // Every object answer, not only the schema-bearing ones. Gated on
          // `outputSchema`, a JSON-returning tool without one would carry no
          // `structuredContent`, and agents would parse prose to reach data the
          // server has in hand. A declared `outputSchema` is the stronger
          // contract (a client validates against it), not the price of
          // admission. The text block stays regardless:
          // the spec asks for the serialised twin, and a client that reads only
          // content still has to be able to read the answer.
          const structured =
            data !== null && typeof data === 'object' && !Array.isArray(data)
              ? { structuredContent: data }
              : {};
          return toolText(id, text, false, {
            ...structured,
            ...(Object.keys(out).length ? { _meta: out } : {}),
          });
        } catch (err) {
          if (!(err instanceof McpToolError)) throw err;
          return toolText(id, JSON.stringify({ error: err.message, ...err.details }, null, 2), true);
        }
      }

      default:
        return methodNotFound(id, method, config, dispatch.era);
    }
  } catch (err) {
    console.error('[MCP]', method, err);
    return rpcError(id, -32603, 'Internal error');
  }
}

/** Dispatch a parsed body. `null` means notification-only — answer 202, not 200. */
export async function handleMcp(
  body: RpcRequest | RpcRequest[],
  config: McpServerConfig,
  dispatch: Dispatch = { protocolVersion: ASSUMED_VERSION, era: 'legacy' },
): Promise<object | object[] | null> {
  const maxBatch = config.maxBatch ?? DEFAULT_MAX_BATCH;
  const isBatch = Array.isArray(body);
  if (isBatch && body.length > maxBatch) {
    return rpcError(
      null,
      -32600,
      `Batch too large: ${body.length} requests (max ${maxBatch}). Split into smaller batches.`,
    );
  }
  if (isBatch && body.length === 0) {
    return rpcError(null, -32600, 'Batch is empty. Send at least one JSON-RPC request.');
  }
  const responses = (
    await Promise.all((isBatch ? body : [body]).map(r => handleRpc(r, config, dispatch)))
  ).filter(Boolean) as object[];
  return isBatch ? responses : (responses[0] ?? null);
}

// ---------------------------------------------------------------------------
// HTTP transport — the spec edges, in one place.
//
// A public, anonymous, read-only server means `*` is the correct CORS posture:
// the spec's Origin-validation MUST exists to protect localhost servers from
// DNS rebinding, which is the opposite situation. The allow-headers list
// matters more than it looks — MCP clients preflight with `Accept` and
// `Mcp-Protocol-Version` — and a modern client adds `Mcp-Method` and `Mcp-Name`
// on every call — and one missing entry fails the preflight, not the POST,
// which reads as "the server is down".

export const MCP_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Mcp-Method, Mcp-Name, Last-Event-ID',
  // Allow-Headers governs what a browser may send; without Expose-Headers it
  // may read none of what comes back. A browser client could not see the
  // negotiated version, and could not see `Retry-After` on the 429 telling it
  // how long to wait — which reads as a hang, not as a limit.
  'Access-Control-Expose-Headers':
    'Mcp-Session-Id, Mcp-Protocol-Version, Retry-After, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset',
  'Access-Control-Max-Age': '86400',
};

export function withMcpCors<T extends Response>(res: T): T {
  for (const [k, v] of Object.entries(MCP_CORS)) res.headers.set(k, v);
  return res;
}

export function mcpOptions(): Response {
  return new Response(null, { status: 204, headers: MCP_CORS });
}

/**
 * Streamable HTTP lets a server decline the SSE leg by answering GET with 405.
 * A framework's automatic 405 carries no CORS headers, so a browser client
 * could not even read the refusal — answer it here, and say what to do instead.
 */
export function mcpGet(docsUrl?: string): Response {
  const message =
    'This server speaks JSON-RPC over POST only (no SSE stream). Send your request as an HTTP POST.' +
    (docsUrl ? ` Docs: ${docsUrl}` : '');
  return Response.json(rpcError(null, -32600, message), {
    status: 405,
    headers: { ...MCP_CORS, Allow: 'POST, OPTIONS' },
  });
}

/**
 * The 429 an MCP endpoint owes a caller that is over budget.
 *
 * Every surface here answered with a bare `{error: "..."}` — a string where the
 * client's parser expects `{code, message}` — on the one response an agent
 * meets precisely when it is working hard, and the one it most needs to read to
 * back off correctly. It needs the CORS headers for the same reason the GET
 * refusal does. The id is null because the limiter runs before the body is
 * parsed, which is deliberate: an unparsed body cannot cost a query.
 */
export function mcpRateLimited(retryAfterSec: number, message?: string): Response {
  return Response.json(
    rpcError(
      null,
      -32000,
      message ?? `Rate limit exceeded. Retry in ${retryAfterSec} seconds.`,
      { retryAfterSec },
    ),
    { status: 429, headers: { ...MCP_CORS, 'Retry-After': String(retryAfterSec) } },
  );
}

/** The whole POST leg: parse, gate, track, dispatch, and answer with the right status. */
export async function mcpResponse(
  request: Request,
  config: McpServerConfig,
): Promise<Response> {
  // Before `request.json()`: an unparsed body must not cost a query, which is
  // also why the refusal carries a null id.
  let headroom: Record<string, string> = {};
  if (config.rateLimit) {
    const verdict = rateLimit(
      clientKey(config.rateLimit.prefix ?? 'mcp', request.headers),
      config.rateLimit,
    );
    if (!verdict.ok) {
      return withRateLimit(mcpRateLimited(verdict.retryAfterSec), verdict, config.rateLimit);
    }
    headroom = rateLimitHeaders(verdict, config.rateLimit);
  }

  // The headroom rides on every answer, not only on the 429 — a budget
  // discoverable only by exceeding it is one an agent meets when it is least
  // able to act on it.
  const base = { ...MCP_CORS, ...headroom };

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, 'Parse error: request body is not valid JSON.'), {
      status: 400,
      headers: { ...base, 'MCP-Protocol-Version': requestProtocol(request) },
    });
  }

  // Tracked before either era refuses anything: a probe the server turns away,
  // and a call an agent walked away from behind a gate, are exactly the ones
  // worth counting.
  config.onCall?.(request, body);

  return isModern(request, body)
    ? modernResponse(request, body as RpcRequest, config, base)
    : legacyResponse(request, body as RpcRequest | RpcRequest[], config, base);
}

/**
 * Which era a POST belongs to. The spec's rule: modern `_meta` selects the modern
 * era and `initialize` selects the legacy one. A modern version header and
 * `server/discover` can only mean one thing too. Anything else is legacy,
 * because a body without `_meta` is exactly what every client in the field sends.
 */
function isModern(request: Request, body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const { method, params } = body as { method?: unknown; params?: { _meta?: unknown } };
  if (method === 'initialize') return false;
  const meta = params?._meta;
  return (
    (!!meta && typeof meta === 'object' && MCP_META.protocolVersion in meta) ||
    method === 'server/discover' ||
    speaksModern(request.headers.get('mcp-protocol-version'))
  );
}

async function dispatchThroughGate(
  body: RpcRequest | RpcRequest[],
  config: McpServerConfig,
  dispatch: Dispatch,
): Promise<object | object[] | null> {
  const gate = await config.gate?.(body);
  const dispatched = gate?.empty ? null : await handleMcp(gate ? gate.body : body, config, dispatch);
  return gate ? gate.finish(dispatched) : dispatched;
}

async function legacyResponse(
  request: Request,
  body: RpcRequest | RpcRequest[],
  config: McpServerConfig,
  base: Record<string, string>,
): Promise<Response> {
  const protocolVersion = requestProtocol(request);
  // Echoed on every response so a client can see which version it is actually
  // being answered under, rather than inferring it from the initialize it sent
  // some requests ago.
  const headers = { ...base, 'MCP-Protocol-Version': protocolVersion };

  if (Array.isArray(body) && !allowsBatch(protocolVersion)) {
    return Response.json(
      rpcError(
        null,
        -32600,
        `JSON-RPC batching was removed in MCP ${protocolVersion}. Send one request per POST, or negotiate ${ASSUMED_VERSION} to keep batching.`,
      ),
      { status: 400, headers },
    );
  }

  const result = await dispatchThroughGate(body, config, { protocolVersion, era: 'legacy', request });

  // Notification-only input produces no response bodies; the spec requires a
  // bare 202 there, not a 200 carrying a JSON `null`.
  if (result == null || (Array.isArray(result) && !result.length)) {
    return new Response(null, { status: 202, headers });
  }
  return Response.json(result, { headers });
}

/** The modern era maps a protocol error to an HTTP status; the legacy era answered 200. */
const MODERN_STATUS: Record<number, number> = {
  [-32601]: 404,
  [-32602]: 400,
  [-32020]: 400,
  [-32021]: 400,
  [-32022]: 400,
};

/** The results a modern client may cache. A call or a prompt is never among them. */
const CACHEABLE = new Set([
  'server/discover',
  'tools/list',
  'prompts/list',
  'resources/list',
  'resources/templates/list',
  'resources/read',
]);

const DEFAULT_CACHE_TTL_MS = 300_000;

/** `Mcp-Name` carries the target of the three calls that have one, for a gateway to route on. */
const NAME_PARAM: Record<string, string> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
};

/** A header value, decoded from the `=?base64?…?=` form a client uses for non-ASCII. */
function headerValue(raw: string | null): string | null {
  const encoded = raw?.match(/^=\?base64\?(.*)\?=$/i)?.[1];
  if (encoded === undefined) return raw;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(encoded), c => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** The first routing header that disagrees with the body, described. */
function headerMismatch(
  request: Request,
  method: string,
  params: Record<string, unknown>,
  version: string,
): string | null {
  const expected: Array<[string, unknown]> = [
    ['MCP-Protocol-Version', version],
    ['Mcp-Method', method],
  ];
  const nameKey = NAME_PARAM[method];
  // A call missing its name is reported by the dispatcher, which can list the names.
  if (nameKey && typeof params[nameKey] === 'string') expected.push(['Mcp-Name', params[nameKey]]);
  for (const [name, want] of expected) {
    const got = headerValue(request.headers.get(name));
    if (got !== want) {
      return `Header ${name} must equal ${JSON.stringify(want)}; received ${got === null ? 'none' : JSON.stringify(got)}.`;
    }
  }
  return null;
}

/**
 * A modern result: `resultType` on every one, cache hints on the cacheable ones,
 * and serverInfo in `_meta` now that no handshake carries it. Applied after the
 * gate, so an answer a gate builds in place of a call is shaped the same way.
 */
function modernResult(response: object, method: string, config: McpServerConfig): object {
  if (!('result' in response)) return response;
  const result = (response as { result: Record<string, unknown> }).result;
  return {
    ...response,
    result: {
      resultType: 'complete',
      ...result,
      ...(CACHEABLE.has(method)
        ? {
            ttlMs: config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
            // Nothing here varies by caller, except a read a gate may have
            // charged for, which a shared cache must not hand to the next one.
            cacheScope: method === 'resources/read' ? 'private' : 'public',
          }
        : {}),
      _meta: { ...(result._meta as object | undefined), [MCP_META.serverInfo]: config.serverInfo },
    },
  };
}

async function modernResponse(
  request: Request,
  body: RpcRequest,
  config: McpServerConfig,
  base: Record<string, string>,
): Promise<Response> {
  const params = (body.params ?? {}) as Record<string, unknown>;
  const meta = (params._meta ?? {}) as Record<string, unknown>;
  const requested = meta[MCP_META.protocolVersion];
  const headers = {
    ...base,
    'MCP-Protocol-Version': speaksModern(requested) ? requested : MCP_MODERN_VERSIONS[0],
  };
  const refuse = (code: number, message: string, data?: object) =>
    Response.json(rpcError(body.id ?? null, code, message, data), {
      status: MODERN_STATUS[code] ?? 400,
      headers,
    });

  if (typeof requested !== 'string') {
    return refuse(
      -32602,
      `Missing params._meta["${MCP_META.protocolVersion}"]. A ${MCP_MODERN_VERSIONS[0]} request carries its version and client capabilities on every call; to use ${MCP_LEGACY_PROTOCOL_VERSION} instead, send "initialize".`,
    );
  }
  if (!speaksModern(requested)) {
    return refuse(-32022, 'Unsupported protocol version', {
      supported: [...MCP_PROTOCOL_VERSIONS],
      requested,
    });
  }
  const capabilities = meta[MCP_META.clientCapabilities];
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    return refuse(
      -32602,
      `Missing params._meta["${MCP_META.clientCapabilities}"]. Send {} when the client declares none.`,
    );
  }
  const mismatch = headerMismatch(request, body.method, params, requested);
  if (mismatch) return refuse(-32020, mismatch);

  const result = await dispatchThroughGate(body, config, {
    protocolVersion: requested,
    era: 'modern',
    request,
  });
  if (result == null) return new Response(null, { status: 202, headers });

  const response = modernResult(result, body.method, config) as { error?: { code: number } };
  const code = response.error?.code;
  return Response.json(response, {
    status: (code !== undefined && MODERN_STATUS[code]) || 200,
    headers,
  });
}
