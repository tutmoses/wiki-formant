import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AI_CRAWLERS, aiCrawlerRules, aiCrawlerTokens, detectAiBot } from '../dist/crawlers.js';

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
  const rules = aiCrawlerRules({ allow: '/', disallow: ['/api/'], aiAllow: ['/', '/llms.txt'] });
  assert.equal(rules[0].userAgent, '*');
  for (const rule of rules) {
    assert.ok(rule.disallow, `${rule.userAgent} has no disallow`);
  }
  assert.equal(rules.length, AI_CRAWLERS.length + 1);
  assert.deepEqual(rules[1], { userAgent: 'GPTBot', allow: ['/', '/llms.txt'], disallow: ['/api/'] });
});
