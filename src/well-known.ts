// well-known.ts — the descriptors an agent finds before it knows anything else
// about an origin: the A2A Agent Card and the MCP registry's domain proof.
//
// All three apps here serve both, and all three had written them out. The
// registry-auth handler was identical bar a domain named in a comment; the
// agent cards shared an envelope, a skills mapping and a cache header, and
// differed only in the fields a card is *supposed* to differ in.
//
// Nothing here touches a framework: these return plain values, and the caller
// wraps them in whatever its router wants. That keeps this package free of a
// Next dependency and keeps each app's route a two-liner.

// ---- MCP registry domain proof ---------------------------------------------

export interface RegistryAuthRecord {
  body: string;
  contentType: string;
  cacheControl: string;
}

/**
 * The `v=MCPv1` record the official MCP registry fetches from
 * `/.well-known/mcp-registry-auth` to prove domain ownership. `mcp-publisher
 * login http --domain=<host>` checks the key here against the private key
 * signing the login, which is what grants publish rights over the reversed-
 * domain namespace the server's name sits in.
 *
 * Returns null when no key is configured, so the caller can 404 rather than
 * serve a malformed record — a missing key should read as "not configured",
 * not as a verification failure nobody can explain.
 *
 * The key material belongs in an env var rather than the repo: the public half
 * is harmless to serve but pointless to commit, and keeping it out gives the
 * private half an obvious home too (a keychain, never git).
 *
 *   openssl genpkey -algorithm Ed25519 -out key.pem
 *   openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64
 */
export function registryAuthRecord(publicKey?: string, keyType?: string): RegistryAuthRecord | null {
  if (!publicKey) return null;
  return {
    // ed25519 unless a P-384 key was used instead (the LibreSSL-friendly path).
    body: `v=MCPv1; k=${keyType || 'ed25519'}; p=${publicKey}\n`,
    contentType: 'text/plain; charset=utf-8',
    cacheControl: 'no-store',
  };
}

// ---- A2A Agent Card ---------------------------------------------------------

/** A day at the edge, a week stale-while-revalidate. A card changes rarely. */
export const AGENT_CARD_CACHE_CONTROL = 'public, s-maxage=86400, stale-while-revalidate=604800';

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  authentication?: unknown;
}

/** The shape a tool needs to carry to become a skill. */
export interface SkillSource {
  name: string;
  description: string;
  skill?: { id: string; tags: string[]; examples?: string[] } | undefined;
  auth?: unknown;
}

/**
 * Skills derived from the MCP tool manifest, so a card can never advertise a
 * capability the server does not have. `search_pages` becomes "Search Pages".
 */
export function skillsFromTools(tools: readonly SkillSource[]): AgentSkill[] {
  return tools
    .filter(t => t.skill)
    .map(t => ({
      id: t.skill!.id,
      name: t.name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      description: t.description,
      tags: t.skill!.tags,
      ...(t.skill!.examples ? { examples: t.skill!.examples } : {}),
      ...(t.auth ? { authentication: t.auth } : {}),
    }));
}

export interface AgentCardLicense {
  name: string;
  url: string;
  spdx?: string;
  /** What the licence covers, e.g. `'content'`. */
  scope?: string;
}

/**
 * The A2A revision these cards are written to. Required since v0.3 — a card
 * without it is not a card a spec-current client will accept, and all three
 * origins here were serving one.
 */
export const A2A_PROTOCOL_VERSION = '0.3.0';

export interface AgentCardConfig {
  name: string;
  description: string;
  /** Origin, no trailing slash. Every derived URL below hangs off it. */
  url: string;
  version: string;
  skills: AgentSkill[];
  license?: AgentCardLicense;
  /** Defaults to `name`. */
  organization?: string;
  /** Defaults to `${url}/llms.txt`. */
  documentationUrl?: string;
  /** Defaults to `${url}/api/mcp`. Pass null for an origin with no MCP server. */
  mcpEndpoint?: string | null;
  /** Anything this origin advertises that the others do not. */
  extra?: Record<string, unknown>;
}

/**
 * An A2A Agent Card. Serve the same object at both `/.well-known/agent.json`
 * and `/.well-known/agent-card.json`: v0.3 renamed the path and defined no
 * fallback in either direction, so a spec-current client probes only the new
 * one and a client on an older SDK probes only the old one. Serving one path
 * means half the callers conclude the origin has no agent at all.
 */
export function agentCard(config: AgentCardConfig): Record<string, unknown> {
  const { name, description, url, version, skills, license, organization, documentationUrl, mcpEndpoint, extra } = config;
  const endpoint = mcpEndpoint === null ? url : (mcpEndpoint ?? `${url}/api/mcp`);
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name,
    description,
    // The endpoint, not the homepage. A card's `url` is where a client sends
    // its first call, and every card here pointed at an HTML page — so a client
    // that believed the card got markup back, or a 405. MCP is JSON-RPC over
    // HTTP POST, so an A2A caller arriving at it is answered in a shape it can
    // parse: a -32601 naming every method the server does implement.
    url: endpoint,
    preferredTransport: 'JSONRPC',
    version,
    capabilities: { streaming: false, pushNotifications: false },
    skills,
    provider: { organization: organization ?? name, url },
    documentationUrl: documentationUrl ?? `${url}/llms.txt`,
    ...(mcpEndpoint === null ? {} : { mcpEndpoint: endpoint }),
    ...(license ? { license } : {}),
    ...extra,
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json', 'text/markdown'],
  };
}

// ---- MCP Server Card --------------------------------------------------------

/** The registry manifest (`server.json`) fields a card projects. */
export interface ServerManifest {
  name: string;
  title?: string;
  description?: string;
  version: string;
  websiteUrl?: string;
  remotes?: ReadonlyArray<Record<string, unknown>>;
}

export const SERVER_CARD_SCHEMA =
  'https://static.modelcontextprotocol.io/schemas/draft/server-card.schema.json';

/**
 * The card served at `<mcp-url>/server-card`.
 *
 * Status: the Server Card extension is a DRAFT (SEP-1649 / SEP-2127) whose
 * location has already moved once, from `/.well-known/mcp.json` to that path.
 * It costs nothing to keep correct, because every field is projected from the
 * registry manifest that already single-sources the version. If the draft moves
 * again, move the route; if it dies, delete it.
 *
 * Projection is the point. One repo retyped `title` and `description` as
 * literals beside the manifest it was already importing, so it carried two
 * copies of its own description with nothing comparing them; a third retyped
 * them again in a different route. Passing the manifest makes that unspellable.
 *
 * Cards deliberately omit tool listings — that is what `tools/list` is for.
 */
export function serverCard(
  manifest: ServerManifest,
  /** Every version the transport speaks, not just the newest it prefers. */
  protocolVersions: string | readonly string[],
): Record<string, unknown> {
  const supported = typeof protocolVersions === 'string' ? [protocolVersions] : [...protocolVersions];
  return {
    $schema: SERVER_CARD_SCHEMA,
    name: manifest.name,
    ...(manifest.title ? { title: manifest.title } : {}),
    ...(manifest.description ? { description: manifest.description } : {}),
    version: manifest.version,
    ...(manifest.websiteUrl ? { websiteUrl: manifest.websiteUrl } : {}),
    ...(manifest.remotes
      ? { remotes: manifest.remotes.map(r => ({ ...r, supportedProtocolVersions: supported })) }
      : {}),
  };
}
