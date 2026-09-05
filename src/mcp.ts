// mcp.ts — a minimal Model Context Protocol server over Streamable HTTP
// (JSON-RPC). Spec: https://modelcontextprotocol.io/specification/2025-06-18
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
 * The versions this transport speaks, newest first.
 *
 * This was a constant answered unconditionally, which is legal and still wrong:
 * a client asking for 2025-06-18 was told 2025-03-26 and silently gave up tool
 * titles, structured output and `_meta`. The last one is where a payment
 * receipt rides, so the one surface that needed it rebuilt this module's HTTP
 * shell by hand to reach it.
 */
export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];

/** The newest version spoken here, and what an unrecognised ask falls back to. */
export const MCP_PROTOCOL_VERSION: McpProtocolVersion = MCP_PROTOCOL_VERSIONS[0];

/** What a request carrying no `MCP-Protocol-Version` header means, per the spec. */
const ASSUMED_VERSION: McpProtocolVersion = '2025-03-26';

const speaks = (v: unknown): v is McpProtocolVersion =>
  (MCP_PROTOCOL_VERSIONS as readonly unknown[]).includes(v);

/** Echo the client's version when it is one we speak, else offer the newest. */
export function negotiateProtocol(requested: unknown): McpProtocolVersion {
  return speaks(requested) ? requested : MCP_PROTOCOL_VERSION;
}

/** The version a post-initialize request is operating under. */
export function requestProtocol(request: Request): McpProtocolVersion {
  const header = request.headers.get('mcp-protocol-version');
  return speaks(header) ? header : ASSUMED_VERSION;
}

/** JSON-RPC batching was removed in 2025-06-18; it stays legal below that. */
const allowsBatch = (v: McpProtocolVersion) => v !== '2025-06-18';

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
};

/**
 * Behavioural hints a client uses to decide what needs a human in the loop.
 * Without them every tool looks alike, so a client that auto-approves read-only
 * calls has no way to tell a lookup from one that reaches a payment processor.
 */
export type ToolAnnotations = {
  /** Human-facing label for the tool. */
  title?: string;
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
   * Cap on JSON-RPC batch size. The rate limiter charges one token per HTTP
   * request, before the body is parsed — an unbounded batch would let a single
   * token fan out into thousands of concurrent handler executions, each its own
   * query. Keep this aligned with whatever ceiling the batching tools advertise.
   */
  maxBatch?: number;
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

const DEFAULT_MAX_BATCH = 20;

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

const toolText = (
  id: RpcId,
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
  const { properties, required = [] } = tool.inputSchema;
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

const BASE_METHODS = ['initialize', 'ping', 'tools/list', 'tools/call'];

function methodsFor(config: McpServerConfig): string[] {
  return [
    ...BASE_METHODS,
    // The list methods answer whether or not anything is registered: an empty
    // list is a better answer to a client that asked than a -32601 it has to
    // interpret. This enumeration used to omit them while the dispatch below
    // answered them, so the error message contradicted the server describing
    // itself.
    'resources/list',
    'resources/templates/list',
    'prompts/list',
    ...(config.resources?.length ? ['resources/read'] : []),
    ...(config.prompts?.length ? ['prompts/get'] : []),
  ];
}

/** Everything the dispatcher needs that is not in the JSON-RPC entry itself. */
interface Dispatch {
  protocolVersion: McpProtocolVersion;
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

  try {
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            // Echo what the client asked for when we speak it. Answering a
            // constant is what silently held every caller at 2025-03-26.
            protocolVersion: negotiateProtocol(p.protocolVersion),
            // Only advertise capabilities the config actually populates — an
            // advertised `resources` whose list comes back empty reads as a bug
            // to a client, not as honesty.
            capabilities: {
              tools: {},
              ...(resources.length ? { resources: {} } : {}),
              ...(prompts.length ? { prompts: {} } : {}),
            },
            serverInfo: config.serverInfo,
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
          // `structuredContent` only where a schema says what its shape is; the
          // text block stays either way, because a client that never looked at
          // outputSchema still has to be able to read the answer.
          const structured =
            tool.outputSchema && data !== null && typeof data === 'object' && !Array.isArray(data)
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

      default: {
        const methods = methodsFor(config);
        return rpcError(
          id,
          -32601,
          `Method not found: "${method}". This server implements: ${quote(methods)}.`,
          { supportedMethods: methods },
        );
      }
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
  dispatch: Dispatch = { protocolVersion: ASSUMED_VERSION },
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
// `Mcp-Protocol-Version`, and one missing entry fails the preflight, not the
// POST, which reads as "the server is down".

export const MCP_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  // Allow-Headers governs what a browser may send; without Expose-Headers it
  // may read none of what comes back. A browser client could not see the
  // negotiated version, and could not see `Retry-After` on the 429 telling it
  // how long to wait — which reads as a hang, not as a limit.
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, Mcp-Protocol-Version, Retry-After',
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
  const protocolVersion = requestProtocol(request);
  // Echoed on every response so a client can see which version it is actually
  // being answered under, rather than inferring it from the initialize it sent
  // some requests ago.
  const headers = { ...MCP_CORS, 'MCP-Protocol-Version': protocolVersion };

  let body: RpcRequest | RpcRequest[];
  try {
    body = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, 'Parse error: request body is not valid JSON.'), {
      status: 400,
      headers,
    });
  }

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

  // Tracked on the original body, before a gate withholds anything: a call an
  // agent walked away from is exactly the one worth counting.
  config.onCall?.(request, body);

  const gate = await config.gate?.(body);
  const dispatched = gate?.empty
    ? null
    : await handleMcp(gate ? gate.body : body, config, { protocolVersion, request });
  const result = gate ? await gate.finish(dispatched) : dispatched;

  // Notification-only input produces no response bodies; the spec requires a
  // bare 202 there, not a 200 carrying a JSON `null`.
  if (result == null || (Array.isArray(result) && !result.length)) {
    return new Response(null, { status: 202, headers });
  }
  return Response.json(result, { headers });
}
