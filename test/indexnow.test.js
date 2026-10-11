import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sitemapEntries, changedUrls, submitIndexNow, INDEXNOW_BATCH, INDEXNOW_ENDPOINT } from 'wiki-formant/indexnow';

const recorder = (status = 200) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(null, { status });
  };
  return { calls, fetchImpl };
};

test('a sitemap reads as its locs and lastmods, entities decoded', () => {
  const xml = `<?xml version="1.0"?><urlset>
<url><loc>https://x.test/a?b=1&amp;c=2</loc><lastmod>2026-10-11T00:00:00.000Z</lastmod></url>
<url>
  <loc>https://x.test/b</loc>
  <changefreq>yearly</changefreq>
</url>
</urlset>`;
  assert.deepEqual(sitemapEntries(xml), [
    { url: 'https://x.test/a?b=1&c=2', lastModified: '2026-10-11T00:00:00.000Z' },
    { url: 'https://x.test/b' },
  ]);
});

test('only rows modified inside the window count as changed', () => {
  const entries = [
    { url: 'https://x.test/a', lastModified: new Date(2_000).toISOString() },
    { url: 'https://x.test/b', lastModified: new Date(500).toISOString() },
    { url: 'https://x.test/c' },
  ];
  assert.deepEqual(changedUrls(entries, 1_000), ['https://x.test/a']);
});

test('nothing to submit makes no request', async () => {
  const { calls, fetchImpl } = recorder();
  assert.deepEqual(await submitIndexNow('k', [], fetchImpl), []);
  assert.equal(calls.length, 0);
});

test('a submission names the host and splits at the protocol cap', async () => {
  const { calls, fetchImpl } = recorder();
  const urls = Array.from({ length: INDEXNOW_BATCH + 1 }, (_, i) => `https://x.test/${i}`);
  assert.deepEqual(await submitIndexNow('k', urls, fetchImpl), [200, 200]);
  assert.equal(calls[0].url, INDEXNOW_ENDPOINT);
  assert.equal(calls[0].body.host, 'x.test');
  assert.equal(calls[0].body.key, 'k');
  assert.equal(calls[0].body.urlList.length, INDEXNOW_BATCH);
  assert.equal(calls[1].body.urlList.length, 1);
});
