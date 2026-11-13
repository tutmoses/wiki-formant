import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BannerArt, PageBanner } from 'wiki-formant/banner';
import { hashStr, seededRandom } from 'wiki-formant/seeded';

const html = (c, p) => renderToStaticMarkup(createElement(c, p));

// radix-wiki's generator as it drew before the art moved here: the lifted art
// must draw the same shapes at the same places, so no page's banner moves.
function before(seed) {
  const rand = seededRandom(hashStr(seed));
  const out = { angle: Math.floor(rand() * 360), shapes: [] };
  for (let i = 0; i < 3; i++) out.shapes.push([rand() * 800, rand() * 200, 60 + rand() * 120, 0.15 + rand() * 0.2].map(n => +n.toFixed(2)));
  const count = 5 + Math.floor(rand() * 4);
  for (let i = 0; i < count; i++) {
    const x = rand() * 800, y = rand() * 200, opacity = 0.12 + rand() * 0.25, kind = Math.floor(rand() * 4);
    if (kind === 0) rand();
    else if (kind === 1) { rand(); rand(); rand(); rand(); }
    else if (kind === 2) { rand(); for (let k = 0; k < 6; k++) rand(); }
    else { rand(); rand(); }
    out.shapes.push([x, y, kind, opacity].map(n => +n.toFixed(2)));
  }
  out.dots = Array.from({ length: 4 }, () => [rand() * 800, rand() * 200, 2 + rand() * 6, 0.4 + rand() * 0.4].map(n => Math.round(n)));
  return out;
}

test('the art draws what radix-wiki drew, from the same sequence', () => {
  const seed = 'Xi\'an Wallcontents/tech';
  const out = html(BannerArt, { seed });
  const was = before(seed);
  assert.match(out, new RegExp(`gradientTransform="rotate\\(${was.angle}\\)"`));
  const count = (out.match(/<(circle|rect|path) class="banner-art__/g) ?? []).length;
  assert.equal(count, 3 + (was.shapes.length - 3) + 4);
  const dots = [...out.matchAll(/<circle class="banner-art__ink" cx="(\d+)" cy="(\d+)" r="(\d+)"/g)].slice(-4).map(m => m.slice(1, 4).map(Number));
  assert.deepEqual(dots, was.dots.map(d => d.slice(0, 3)));
});

test('the art is the same on every render, and differs by seed', () => {
  assert.equal(html(BannerArt, { seed: 'a' }), html(BannerArt, { seed: 'a' }));
  assert.notEqual(html(BannerArt, { seed: 'a' }), html(BannerArt, { seed: 'b' }));
});

test('a gradient id is the seed\'s, so two banners on a page do not share one', () => {
  const a = html(BannerArt, { seed: 'a' }).match(/id="([^"]+)"/)[1];
  const b = html(BannerArt, { seed: 'b' }).match(/id="([^"]+)"/)[1];
  assert.notEqual(a, b);
  assert.match(html(BannerArt, { seed: 'a' }), new RegExp(`fill="url\\(#${a}\\)"`));
});

test('a mark replaces the triangle', () => {
  let seed = 0;
  // Find a seed whose art has a mark.
  while (!html(BannerArt, { seed: String(seed) }).includes('<path')) seed++;
  const out = html(BannerArt, { seed: String(seed), mark: (x, y) => `M${Math.round(x)} ${Math.round(y)}h1z` });
  assert.match(out, /<path class="banner-art__(mid|ink)" d="M\d+ \d+h1z"/);
});

test('the banner shows its picture, else its art, and its words over either', () => {
  const art = html(PageBanner, { seed: 's', children: createElement('h1', null, 'T') });
  assert.match(art, /^<div class="page-banner"><svg class="banner-art"/);
  assert.match(art, /<div class="page-banner__body"><h1>T<\/h1><\/div><\/div>$/);
  const pic = html(PageBanner, { seed: 's', picture: createElement('img', { src: '/b.png', alt: '' }), className: 'x' });
  assert.match(pic, /<div class="page-banner x"><img src="\/b.png" alt=""\/><\/div>$/);
});
