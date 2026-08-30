import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  safeLinkHref,
  okUrl,
  validateReferenceItems,
  validateLinkGroups,
  createBlockValidator,
  duplicateBlockIds,
} from '../dist/validation.js';

test('safe schemes pass, unsafe ones do not', () => {
  assert.equal(safeLinkHref('https://example.com'), 'https://example.com');
  assert.equal(safeLinkHref('/relative'), '/relative');
  assert.equal(safeLinkHref('#anchor'), '#anchor');
  assert.equal(safeLinkHref('mailto:a@b.c'), 'mailto:a@b.c');
  assert.equal(safeLinkHref('javascript:alert(1)'), null);
  assert.equal(safeLinkHref('data:text/html,<script>'), null);
  assert.equal(safeLinkHref('vbscript:x'), null);
  assert.equal(safeLinkHref('//evil.com'), null);
  assert.equal(safeLinkHref(null), null);
});

test('control characters cannot smuggle a scheme past the check', () => {
  // This is why the C0 strip happens BEFORE the scheme match.
  const NL = String.fromCharCode(10);
  const TAB = String.fromCharCode(9);
  assert.equal(safeLinkHref('java' + NL + 'script:alert(1)'), null);
  assert.equal(safeLinkHref('java' + TAB + 'script:alert(1)'), null);
  assert.equal(safeLinkHref(' javascript:alert(1)'), null);
  assert.equal(safeLinkHref('JaVaScRiPt:alert(1)'), null);
});

test('an unset url is acceptable, a dangerous one is not', () => {
  assert.equal(okUrl(''), true);
  assert.equal(okUrl('https://x.com'), true);
  assert.equal(okUrl('javascript:x'), false);
  assert.equal(okUrl(undefined), false);
});

test('reference items need an id and text, and a safe url when present', () => {
  assert.equal(validateReferenceItems([{ id: 'a', text: 't' }]), true);
  assert.equal(validateReferenceItems([{ id: 'a', text: 't', url: 'https://x.com' }]), true);
  assert.equal(validateReferenceItems([{ id: 'a', text: 't', url: 'javascript:x' }]), false);
  assert.equal(validateReferenceItems([{ text: 'no id' }]), false);
  assert.equal(validateReferenceItems('not an array'), false);
});

test('link groups validate their nested links', () => {
  const ok = [{ id: 'g', heading: 'H', links: [{ label: 'L', href: '/x' }] }];
  assert.equal(validateLinkGroups(ok), true);
  assert.equal(validateLinkGroups([{ id: 'g', heading: 'H', links: [{ label: 'L', href: 'javascript:x' }] }]), false);
  assert.equal(validateLinkGroups([{ id: 'g', heading: 'H' }]), false);
});

const V = createBlockValidator({
  isKnownType: t => ['content', 'columns', 'infobox', 'banner'].includes(t),
  isAtomicType: t => ['content', 'banner'].includes(t),
  validateAtomic: b => (b.type === 'content' ? typeof b.text === 'string' : typeof b.variant === 'string'),
});

test('a flat tree of valid leaves passes', () => {
  assert.equal(V.validateBlocks([{ id: '1', type: 'content', text: 'x' }]), true);
});

test('an unknown type is rejected', () => {
  assert.equal(V.validateBlocks([{ id: '1', type: 'nope' }]), false);
});

test('a container nested inside a container is rejected', () => {
  // columns is known but not atomic, so it cannot sit inside an infobox.
  assert.equal(V.validateBlocks([{ id: '1', type: 'infobox', blocks: [{ id: '2', type: 'columns', columns: [] }] }]), false);
});

test('a bad leaf inside a column fails the whole tree', () => {
  const tree = [{ id: '1', type: 'columns', columns: [{ id: 'c', blocks: [{ id: '2', type: 'content', text: 5 }] }] }];
  assert.equal(V.validateBlocks(tree), false);
});

test('a column without an id is rejected', () => {
  assert.equal(V.validateBlocks([{ id: '1', type: 'columns', columns: [{ blocks: [] }] }]), false);
});

test('non-arrays and non-objects are rejected, not thrown on', () => {
  assert.equal(V.validateBlocks(null), false);
  assert.equal(V.validateBlocks([null]), false);
  assert.equal(V.validateBlocks(['string']), false);
});

test('duplicating a container mints a fresh id at every level', () => {
  let n = 0;
  const id = () => `new-${++n}`;
  const out = duplicateBlockIds({ id: 'a', type: 'columns', columns: [{ id: 'c', blocks: [{ id: 'b', type: 'content' }] }] }, id);
  assert.equal(out.id, 'new-1');
  assert.equal(out.columns[0].id, 'new-2');
  assert.equal(out.columns[0].blocks[0].id, 'new-3');
  assert.equal(out.columns[0].blocks[0].type, 'content');
});

test('duplicating an infobox refreshes its children too', () => {
  let n = 0;
  const out = duplicateBlockIds({ id: 'a', type: 'infobox', blocks: [{ id: 'b', type: 'content' }] }, () => `n${++n}`);
  assert.equal(out.id, 'n1');
  assert.equal(out.blocks[0].id, 'n2');
});

test('duplicating a leaf just changes its id', () => {
  const out = duplicateBlockIds({ id: 'a', type: 'content', text: 'keep' }, () => 'z');
  assert.deepEqual(out, { id: 'z', type: 'content', text: 'keep' });
});
