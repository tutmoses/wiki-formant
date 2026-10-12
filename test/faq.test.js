import { test } from 'node:test';
import assert from 'node:assert/strict';
import { faqPageLd, questionPairs } from '../dist/metadata.js';

const html =
  '<p>Intro.</p><h2>What is a caper?</h2><p>A caper is a DAO anyone can launch on Radix in one transaction.</p>' +
  '<h2>Protocol fees</h2><p>Statement headings are never made into questions, however long the section is.</p>' +
  '<h3 id="leave">How do I leave &amp; take my share? <a href="#leave" class="anchor">#</a></h3><p>Any member who has voted can <a href="/x">leave</a> with their share of the treasury.</p>' +
  '<h2>Why?</h2><p>Too short.</p>';

test('questionPairs keeps question headings with a real answer', () => {
  const pairs = questionPairs(html);
  assert.deepEqual(pairs.map(p => p.q), ['What is a caper?', 'How do I leave & take my share?']);
  assert.match(pairs[1].a, /^Any member who has voted can leave with their share/);
});

test('faqPageLd needs two pairs', () => {
  assert.equal(faqPageLd(questionPairs(html).slice(0, 1), 'https://x.test/a'), null);
  const ld = faqPageLd(questionPairs(html), 'https://x.test/a');
  assert.equal(ld['@type'], 'FAQPage');
  assert.equal(ld.mainEntity.length, 2);
  assert.equal(ld.mainEntity[0].acceptedAnswer['@type'], 'Answer');
});
