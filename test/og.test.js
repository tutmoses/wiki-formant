import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidElement } from 'react';
import { SocialCard, bannerField, bubbles, cardRandom } from 'wiki-formant/og';

const colors = { text: '#fff', muted: '#ccc', accent: '#f99' };

// satori throws on a style key set to undefined, so no element may carry one.
function undefinedStyles(node, found = []) {
  if (Array.isArray(node)) node.forEach(n => undefinedStyles(n, found));
  else if (isValidElement(node)) {
    for (const [k, v] of Object.entries(node.props.style ?? {})) if (v === undefined) found.push(k);
    undefinedStyles(node.props.children, found);
  }
  return found;
}

test('a card with only a title sets no undefined style', () => {
  assert.deepEqual(undefinedStyles(SocialCard({ title: 'Reading a point code', colors, background: '#000' })), []);
});

test('a card with every part, art and a scrim sets no undefined style', () => {
  const { background, art } = bubbles(cardRandom('t'), { field: ['#000', '#111'], colors: ['#f00', '#0f0'] });
  const card = SocialCard({ title: 't', eyebrow: 'e', description: 'd', mark: 'm', colors, background, art, scrim: true, fontFamily: 'Inter', children: 'x' });
  assert.deepEqual(undefinedStyles(card), []);
  assert.deepEqual(undefinedStyles(art), []);
});

test('the same text draws the same card', () => {
  const a = bubbles(cardRandom('Lung', 'Meridian'), { field: ['#000', '#111'], colors: ['#f00'] });
  const b = bubbles(cardRandom('Lung', 'Meridian'), { field: ['#000', '#111'], colors: ['#f00'] });
  assert.equal(a.background, b.background);
  assert.deepEqual(a.art.map(e => e.props.style), b.art.map(e => e.props.style));
});

test('a long title is fitted at a word, never cut mid-word', () => {
  const title = 'Pneumothorax after acupuncture and which points carry the risk, and why needling depth matters more than the point chosen';
  const card = SocialCard({ title, colors, background: '#000' });
  const text = card.props.children[1].props.children[1].props.children;
  assert.ok(text.length <= 90 && text.endsWith('…') && title.startsWith(text.slice(0, -1)), text);
});

test('a banner off the allowed hosts, or none, leaves the generated field to draw', async () => {
  const hosts = /\.public\.blob\.vercel-storage\.com$/;
  assert.equal(await bannerField(null, hosts), null);
  assert.equal(await bannerField('https://example.com/a.webp', hosts), null);
  assert.equal(await bannerField('http://x.public.blob.vercel-storage.com/a.webp', hosts), null);
  assert.equal(await bannerField('not a url', hosts), null);
});
