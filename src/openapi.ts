// openapi.ts — the OpenAPI 3.1 frame every agent surface serves at
// /.well-known/openapi.json.
//
// What is per-site is the paths only it has. The frame, the body and response
// shapes, the conditional GET, the MCP endpoint and /llms.txt read the same on
// every site, so they are built here and a spec carries only its own paths.

import { openApiLicense, type License } from './license.js';
import { DEFAULT_MAX_BATCH, MCP_PROTOCOL_VERSIONS, type ToolSchema } from './mcp.js';
import { MCP_RATE_LIMIT_TEXT } from './rate-limit.js';

type Schema = Record<string, unknown>;

export interface OpenApiInfo {
  title: string;
  /** The server version, the number the agent card and MCP `initialize` carry. */
  version: string;
  description: string;
  license: License;
  siteUrl: string;
  contact?: { name: string; url: string };
}

/** The document: version, info, the one server, the paths, and components when there are any. */
export function openApiDocument<P extends object, C extends object>(info: OpenApiInfo, paths: P, components?: C) {
  const { title, version, description, license, siteUrl, contact } = info;
  return {
    openapi: '3.1.0' as const,
    info: { title, version, description, ...(contact ? { contact } : {}), license: openApiLicense(license) },
    servers: [{ url: siteUrl }],
    paths,
    ...(components ? { components } : {}),
  };
}

/** A required JSON request body. */
export const jsonBody = (schema: Schema) => ({ required: true, content: { 'application/json': { schema } } });

/** A JSON response, its schema left open when none is given. */
export const jsonResponse = (description: string, schema: Schema = {}) => ({
  description,
  content: { 'application/json': { schema } },
});

/**
 * A tool's input schema as a REST body, less the fields the path carries. A
 * property whose `items` is one of `refs` points at its component instead of
 * inlining it, so a block schema is written once.
 */
export function toolBody(
  input: Pick<ToolSchema, 'properties' | 'required'>,
  { inPath = [], refs = {} }: { inPath?: readonly string[]; refs?: Record<string, Schema> } = {},
) {
  const kept = (k: string) => !inPath.includes(k);
  const ref = (items: unknown) => Object.entries(refs).find(([, s]) => s === items)?.[0];
  return jsonBody({
    type: 'object',
    required: input.required?.filter(kept),
    properties: Object.fromEntries(
      Object.entries(input.properties)
        .filter(([k]) => kept(k))
        .map(([k, v]) => {
          const name = ref((v as { items?: unknown }).items);
          return [k, name ? { ...v, items: { $ref: `#/components/schemas/${name}` } } : v];
        }),
    ),
  });
}

/** The validator a recrawling agent sends: a match costs a 304 rather than the body. */
export const IF_NONE_MATCH = {
  name: 'If-None-Match',
  in: 'header',
  required: false,
  schema: { type: 'string' },
  description: 'ETag from an earlier fetch. A match returns 304 with no body.',
};

export const NOT_MODIFIED = { description: 'Unchanged since the supplied validator' };

/** `/llms.txt`, answered from one corpus validator. */
export const llmsTxtPath = (summary: string) => ({
  get: {
    summary,
    parameters: [IF_NONE_MATCH],
    responses: { '200': { description: 'OK', content: { 'text/plain': {} } }, '304': NOT_MODIFIED },
  },
});

/** An MCP endpoint: the tools it serves, and what every endpoint `mcpResponse` serves has in common. */
export function mcpPath(tools: readonly string[], opts: { summary?: string; note?: string } = {}) {
  return {
    post: {
      summary: opts.summary ?? 'MCP server (JSON-RPC 2.0, Streamable HTTP)',
      description:
        `Model Context Protocol ${MCP_PROTOCOL_VERSIONS.join(', ')}. Tools: ${tools.join(', ')}. ` +
        `${opts.note ? `${opts.note} ` : ''}Batches are capped at ${DEFAULT_MAX_BATCH}; rate limit ${MCP_RATE_LIMIT_TEXT}.`,
      requestBody: jsonBody({ type: 'object', description: 'JSON-RPC 2.0 request or batch' }),
      responses: { '200': jsonResponse('JSON-RPC 2.0 response') },
    },
  };
}
