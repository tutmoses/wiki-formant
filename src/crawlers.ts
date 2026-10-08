// crawlers.ts — one roster of AI crawler tokens, for both surfaces that need it.
//
// The proxy counts an "AI Bot Visit" by user-agent substring, and `robots.ts`
// gives each agent its own group. Both read this one roster.
//
// One difference between the two uses is deliberate. `Applebot-Extended`
// never fetches a page: it is a robots.txt-only token that Applebot consults
// before using already-crawled data for AI, so counting it would count nothing.
// That belongs in robots and not in the matcher, and it is declared here.
//
// Every other token appears in both, because a crawler obeys only its
// most-specific matching group: an agent with no group of its own falls through
// to `*` and is granted whatever that grants.

import type { Tracker } from './analytics.js';
import type { HeaderReader } from './rate-limit.js';

export interface AiCrawler {
  /** Matched as a substring of the User-Agent, and the robots.txt token. */
  token: string;
  /** Event label. Several tokens deliberately share one. */
  label: string;
  /**
   * False for a robots.txt-only token that never issues a request. Such a token
   * still needs its group — that is the entire point of it — but matching it in
   * a proxy counts a visit that cannot happen.
   */
  fetches: boolean;
}

/**
 * Order is significant: `detectAiBot` returns the first token the user agent
 * contains, so a token that is a substring of another must come after it.
 */
export const AI_CRAWLERS: readonly AiCrawler[] = [
  { token: 'GPTBot', label: 'GPTBot', fetches: true },
  { token: 'ChatGPT-User', label: 'ChatGPT', fetches: true },
  { token: 'OAI-SearchBot', label: 'OAISearchBot', fetches: true },
  { token: 'ClaudeBot', label: 'ClaudeBot', fetches: true },
  { token: 'Claude-Web', label: 'ClaudeBot', fetches: true },
  { token: 'Claude-User', label: 'ClaudeUser', fetches: true },
  { token: 'Claude-SearchBot', label: 'ClaudeSearchBot', fetches: true },
  { token: 'PerplexityBot', label: 'PerplexityBot', fetches: true },
  { token: 'Perplexity-User', label: 'PerplexityUser', fetches: true },
  { token: 'Amazonbot', label: 'Amazonbot', fetches: true },
  // Like Applebot-Extended, this is a preference token rather than a fetcher —
  // Googlebot does the crawling. It is kept matchable because every proxy in the
  // workspace already matched it, and a token that never arrives costs nothing.
  { token: 'Google-Extended', label: 'GoogleExtended', fetches: true },
  { token: 'Bytespider', label: 'Bytespider', fetches: true },
  { token: 'CCBot', label: 'CCBot', fetches: true },
  { token: 'cohere-ai', label: 'CohereBot', fetches: true },
  { token: 'Meta-ExternalAgent', label: 'MetaExternalAgent', fetches: true },
  { token: 'Meta-ExternalFetcher', label: 'MetaExternalFetcher', fetches: true },
  { token: 'MistralAI-User', label: 'MistralAI', fetches: true },
  { token: 'DuckAssistBot', label: 'DuckAssistBot', fetches: true },
  { token: 'Applebot-Extended', label: 'AppleExtended', fetches: false },
];

/** The event label for a user agent, or null when it is not a known crawler. */
export function detectAiBot(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  for (const crawler of AI_CRAWLERS) {
    if (crawler.fetches && userAgent.includes(crawler.token)) return crawler.label;
  }
  return null;
}

/** Every token that needs its own robots.txt group — which is all of them. */
export function aiCrawlerTokens(): string[] {
  return AI_CRAWLERS.map(c => c.token);
}

/**
 * Structurally what Next's `MetadataRoute.Robots['rules']` wants, without
 * importing Next: this package has no runtime dependencies and is not going to
 * grow one for a shape that is three optional string fields.
 */
export interface RobotsGroup {
  userAgent: string;
  allow?: string | string[];
  disallow?: string | string[];
}

/**
 * The agent surface an S10 origin serves, allowed in every group. All three
 * `robots.ts` files listed these by hand, and a path missing from one list is
 * an endpoint the origin advertises and then closes to the callers it named.
 */
export const AGENT_SURFACE_PATHS: readonly string[] = [
  '/api/mcp',
  '/llms.txt',
  '/llms-index.txt',
  '/llms-full.txt',
  '/openapi.json',
  '/.well-known/',
];

/**
 * The React Server Components payload a `<Link>` prefetches. A crawler that
 * renders a page runs those prefetches too — 43% of Googlebot's requests on
 * one wiki, against 10% for HTML — and nothing that reads robots.txt can use
 * one. Every group gets it.
 */
export const RSC_DISALLOW: readonly string[] = ['/*?_rsc=', '/*&_rsc='];

/** The search engines that get the HTML site and none of its twins. */
export const SEARCH_ENGINES: readonly string[] = ['Googlebot', 'Bingbot'];

/**
 * Every group robots.txt needs: the wildcard, one per AI crawler, one per
 * search engine.
 *
 * Every named agent gets an explicit `disallow`. Omitting it is the failure the
 * comment in all three `robots.ts` files warned about and all three then
 * committed for five agents: a named group that disallows nothing grants that
 * agent everything, because it stops matching `*` the moment it matches itself.
 *
 * The search-engine groups exist because `*` keeps the machine surface open to
 * an agent the origin has never heard of, which is right for an agent and wrong
 * for Google: a `.md` twin or its JSON is a page it already has in another
 * format. Two origins wrote that group by hand and the third never did, so
 * Google crawled its twins.
 */
export function crawlerRules(opts: {
  allow: string | string[];
  disallow: string | string[];
  /** Beyond `AGENT_SURFACE_PATHS`, which every group gets regardless. */
  aiAllow?: string | string[];
  /** What search engines are refused beyond `disallow`. `/*.md$` always is. */
  searchDisallow?: string | string[];
}): RobotsGroup[] {
  const aiAllow = [...new Set([...[opts.aiAllow ?? []].flat(), ...AGENT_SURFACE_PATHS])];
  const disallow = [...new Set([...[opts.disallow].flat(), ...RSC_DISALLOW])];
  const searchDisallow = [...new Set([...disallow, '/*.md$', ...[opts.searchDisallow ?? []].flat()])];
  return [
    // `aiAllow` rides on the default group too, not only on the named roster.
    // The agent surface an origin advertises has to be reachable by a caller it
    // has never heard of: two origins here disallowed `/api/` under `*` while
    // their own agent card named `/api/mcp`, so an MCP client that identified
    // honestly as itself was told the endpoint was off limits. The roster is
    // for indexing policy, not for hiding a documented endpoint.
    { userAgent: '*', allow: [...new Set([...[opts.allow].flat(), ...aiAllow])], disallow },
    ...aiCrawlerTokens().map(userAgent => ({ userAgent, allow: aiAllow, disallow })),
    ...SEARCH_ENGINES.map(userAgent => ({ userAgent, allow: '/', disallow: searchDisallow })),
  ];
}

/**
 * Count an AI crawler's visit from a proxy, without holding up its response.
 *
 * `load` is a dynamic import of the module that records it, because that
 * module pulls in a database client, and a static import would load it for
 * every request the proxy sees, bots or not. Three proxies wrote these lines.
 * Returns the bot's label, or null.
 */
export function trackAiBot(
  request: { url: string; headers: HeaderReader },
  event: { waitUntil(promise: Promise<unknown>): void },
  load: () => Promise<Pick<Tracker, 'trackEvent'>>,
): string | null {
  const bot = detectAiBot(request.headers.get('user-agent'));
  if (bot) event.waitUntil(load().then(m => m.trackEvent('AI Bot Visit', request.url, { bot }, request.headers)));
  return bot;
}
