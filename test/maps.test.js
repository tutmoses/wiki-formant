import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMapEmbedUrl, extractCoordsFromUrl, isShortMapUrl, resolveMapHandler, resolveShortMapUrl } from 'wiki-formant/maps';

test('an already-embeddable url passes through untouched', () => {
  const g = 'https://www.google.com/maps/embed?pb=x';
  assert.equal(toMapEmbedUrl(g), g);
  const a = 'https://embed.apple.com/maps?ll=1,2';
  assert.equal(toMapEmbedUrl(a), a);
});

test('coordinates come out of the @lat,lon,zoom path segment', () => {
  assert.deepEqual(extractCoordsFromUrl('https://google.com/maps/@51.5,-0.12,14z'), { lat: 51.5, lon: -0.12, zoom: 14 });
});

test('coordinates come out of the !3d!4d data blob', () => {
  assert.deepEqual(extractCoordsFromUrl('https://google.com/maps/place/x/data=!3d51.5!4d-0.12'), { lat: 51.5, lon: -0.12 });
});

test('coordinates come out of an ll query parameter', () => {
  assert.deepEqual(extractCoordsFromUrl('https://maps.apple.com/?ll=51.5,-0.12'), { lat: 51.5, lon: -0.12 });
});

test('a google place url without coordinates falls back to a q= search', () => {
  const out = toMapEmbedUrl('https://www.google.com/maps/place/British+Museum');
  assert.match(out, /q=British%20Museum/);
  assert.match(out, /output=embed/);
});

test('a non-map url is not a map url', () => {
  assert.equal(toMapEmbedUrl('https://example.com/x'), null);
});

test('shortened map links are flagged for redirect resolution', () => {
  assert.equal(isShortMapUrl('https://maps.app.goo.gl/abc'), true);
  assert.equal(isShortMapUrl('https://google.com/maps/@1,2,3z'), false);
});

test('a shortener is matched on its exact host, never as a substring', () => {
  assert.equal(isShortMapUrl('https://goo.gl/maps/abc'), true);
  assert.equal(isShortMapUrl('https://evil.example/?goo.gl'), false);
  assert.equal(isShortMapUrl('https://maps.app.goo.gl.evil.example/x'), false);
  assert.equal(isShortMapUrl('https://goo.gl/other'), false);
});

const withFetch = async (stub, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
};
const redirectTo = location => async (_url, init) => {
  assert.equal(init.redirect, 'manual');
  return new Response(null, { status: 302, headers: { location } });
};

test('one hop, and only onto a maps host', async () => {
  const ok = await withFetch(redirectTo('https://www.google.com/maps/place/X/@1,2,3z'), () =>
    resolveShortMapUrl('https://maps.app.goo.gl/abc'));
  assert.equal(ok, 'https://www.google.com/maps/place/X/@1,2,3z');
  const off = await withFetch(redirectTo('http://169.254.169.254/latest'), () =>
    resolveShortMapUrl('https://maps.app.goo.gl/abc'));
  assert.equal(off, null);
  const lookalike = await withFetch(redirectTo('https://google.evil.com/maps'), () =>
    resolveShortMapUrl('https://maps.app.goo.gl/abc'));
  assert.equal(lookalike, null);
  let called = false;
  const refused = await withFetch(async () => { called = true; }, () => resolveShortMapUrl('https://evil.example/?goo.gl'));
  assert.equal(refused, null);
  assert.equal(called, false);
});

test('the route refuses the unsigned and the unrecognised before fetching', async () => {
  const locked = resolveMapHandler({ authorize: () => false });
  assert.equal((await locked(new Request('https://w.test/api/resolve-map?url=https://maps.app.goo.gl/a'))).status, 401);
  const open = resolveMapHandler({ authorize: () => true });
  assert.equal((await open(new Request('https://w.test/api/resolve-map?url=https://evil.example/?goo.gl'))).status, 400);
  const res = await withFetch(redirectTo('https://www.google.co.uk/maps/@1,2,3z'), () =>
    open(new Request('https://w.test/api/resolve-map?url=https%3A%2F%2Fmaps.app.goo.gl%2Fa')));
  assert.deepEqual(await res.json(), { resolved: 'https://www.google.co.uk/maps/@1,2,3z' });
});
