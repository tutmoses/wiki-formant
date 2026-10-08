import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AI_CRAWLERS, crawlerRules, aiCrawlerTokens, detectAiBot, RSC_DISALLOW, SEARCH_ENGINES, trackAiBot } from 'wiki-formant/crawlers';

test('the matcher returns the label the proxies used', () => {
  assert.equal(detectAiBot('Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)'), 'GPTBot');
  assert.equal(detectAiBot('ClaudeBot/1.0'), 'ClaudeBot');
  // Two tokens, one label, deliberately.
  assert.equal(detectAiBot('Claude-Web/1.0'), 'ClaudeBot');
  assert.equal(detectAiBot('Mozilla/5.0'), null);
  assert.equal(detectAiBot(null), null);
  assert.equal(detectAiBot(''), null);
});

test('tokens that are substrings of each other resolve to the longer one', () => {
  // The roster is order-sensitive, so this is a property of the list, not luck.
  assert.equal(detectAiBot('Claude-SearchBot/1.0'), 'ClaudeSearchBot');
  assert.equal(detectAiBot('Claude-User/1.0'), 'ClaudeUser');
  assert.equal(detectAiBot('Perplexity-User/1.0'), 'PerplexityUser');
  assert.equal(detectAiBot('PerplexityBot/1.0'), 'PerplexityBot');
});

test('a robots-only token is never counted as a visit', () => {
  // Applebot-Extended does not fetch: it is the token Applebot consults before
  // using crawled data for AI. Counting it would count a request that cannot
  // happen. It still needs its robots group, which is the next test.
  assert.equal(detectAiBot('Applebot-Extended/1.0'), null);
  assert.ok(aiCrawlerTokens().includes('Applebot-Extended'));
});

test('BUG: every measured crawler now has a robots group', () => {
  // Bytespider, CCBot, cohere-ai, Claude-Web and Meta-ExternalFetcher were
  // matched by every proxy in the workspace and named by no robots.txt. A named
  // agent with no group falls through to `*`; these five had neither.
  const tokens = aiCrawlerTokens();
  for (const missing of ['Bytespider', 'CCBot', 'cohere-ai', 'Claude-Web', 'Meta-ExternalFetcher']) {
    assert.ok(tokens.includes(missing), `${missing} has no robots group`);
  }
  // And the converse: nothing the proxy can match is absent from robots.
  for (const c of AI_CRAWLERS) assert.ok(tokens.includes(c.token));
});

test('BUG: a named group always carries a disallow', () => {
  // A group that disallows nothing grants that agent everything, because it
  // stops matching `*` the moment it matches itself. This is the failure all
  // three robots.txt files warned about in a comment.
  const rules = crawlerRules({ allow: '/', disallow: ['/api/'], aiAllow: ['/', '/llms.txt'] });
  assert.equal(rules[0].userAgent, '*');
  for (const rule of rules) {
    assert.ok(rule.disallow, `${rule.userAgent} has no disallow`);
  }
  assert.equal(rules.length, AI_CRAWLERS.length + 1 + SEARCH_ENGINES.length);
  assert.deepEqual(rules[1], {
    userAgent: 'GPTBot',
    allow: ['/', '/llms.txt', '/api/mcp', '/llms-index.txt', '/llms-full.txt', '/openapi.json', '/.well-known/'],
    disallow: ['/api/', ...RSC_DISALLOW],
  });
});

test('the default group can reach everything the descriptors advertise', () => {
  const [star] = crawlerRules({
    allow: '/',
    disallow: ['/api/', '/admin/'],
    aiAllow: ['/', '/api/mcp', '/llms.txt'],
  });
  assert.equal(star.userAgent, '*');
  // A card naming /api/mcp beside a robots.txt disallowing it tells two stories
  // to the same caller; longest-match then resolves it the wrong way.
  assert.ok(star.allow.includes('/api/mcp'));
  assert.ok(star.disallow.includes('/admin/'), 'the disallows still apply');
  // `allow` and `aiAllow` both normally start with '/', and a group listing the
  // same path twice reads as a mistake in a file people inspect by eye.
  assert.equal(star.allow.filter(a => a === '/').length, 1);
});

test('search engines get the HTML site and none of its twins', () => {
  const rules = crawlerRules({ allow: '/', disallow: ['/api/upload'], aiAllow: ['/api/wiki/'], searchDisallow: '/api/wiki/' });
  const google = rules.find(r => r.userAgent === 'Googlebot');
  // The third origin never wrote this group, so Google crawled every .md twin.
  assert.deepEqual(google, { userAgent: 'Googlebot', allow: '/', disallow: ['/api/upload', ...RSC_DISALLOW, '/*.md$', '/api/wiki/'] });
  assert.ok(rules.find(r => r.userAgent === 'Bingbot'));
});

test('the RSC prefetch payload is refused in every group without being asked', () => {
  for (const group of crawlerRules({ allow: '/', disallow: [] })) {
    for (const p of RSC_DISALLOW) assert.ok([group.disallow].flat().includes(p), `${group.userAgent} ${p}`);
  }
});

test('a bot visit is counted off the response path, a person is not', async () => {
  const waited = [];
  const recorded = [];
  const event = { waitUntil: p => waited.push(p) };
  const load = async () => ({ trackEvent: async (...args) => { recorded.push(args); } });
  const req = ua => ({ url: 'https://w.test/x', headers: new Headers({ 'user-agent': ua }) });
  assert.equal(trackAiBot(req('Mozilla/5.0 Firefox'), event, load), null);
  assert.equal(waited.length, 0);
  assert.equal(trackAiBot(req('Mozilla/5.0 (compatible; GPTBot/1.2)'), event, load), 'GPTBot');
  await Promise.all(waited);
  assert.deepEqual(recorded[0].slice(0, 3), ['AI Bot Visit', 'https://w.test/x', { bot: 'GPTBot' }]);
});
