import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMapEmbedUrl, extractCoordsFromUrl, isShortMapUrl } from '../dist/maps.js';

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
