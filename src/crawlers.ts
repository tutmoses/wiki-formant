// crawlers.ts — one roster of AI crawler tokens, for both surfaces that need it.
//
// Every wiki in the workspace kept this list twice: once in the proxy, keyed by
// user-agent substring, to count an "AI Bot Visit"; and once in `robots.ts`, as
// the set of agents that get their own group. The two copies were each
// byte-identical across all three repos — and they were different lists.
//
// Only one direction of that difference was deliberate. `Applebot-Extended`
// never fetches a page: it is a robots.txt-only token that Applebot consults
// before using already-crawled data for AI, so counting it would count nothing.
// That belongs in robots and not in the matcher, and it is declared here.
//
// The other direction was not deliberate. Bytespider, CCBot, cohere-ai,
// Claude-Web and Meta-ExternalFetcher were matched by every proxy and named by
// no robots.txt — and a crawler obeys only its most-specific matching group, so
// an agent with no group of its own falls through to `*` and is granted
// whatever that grants. The wikis were measuring five crawlers they had never
// addressed. One roster makes that a property of the data rather than of which
// file you happened to edit.

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
 * The wildcard group followed by one group per crawler.
 *
 * Every named agent gets an explicit `disallow`. Omitting it is the failure the
 * comment in all three `robots.ts` files warned about and all three then
 * committed for five agents: a named group that disallows nothing grants that
 * agent everything, because it stops matching `*` the moment it matches itself.
 */
export function aiCrawlerRules(opts: {
  allow: string | string[];
  disallow: string | string[];
  aiAllow: string | string[];
}): RobotsGroup[] {
  return [
    { userAgent: '*', allow: opts.allow, disallow: opts.disallow },
    ...aiCrawlerTokens().map(userAgent => ({
      userAgent,
      allow: opts.aiAllow,
      disallow: opts.disallow,
    })),
  ];
}
