import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderBlockTree,
  codeTabsToMarkdown,
  bannerToMarkdown,
  referencesToMarkdown,
  statsToMarkdown,
  linkGridToMarkdown,
  linkList,
} from '../dist/blocks.js';

// ---- the container walk ----

const atomic = (b) => b.text ?? '';

test('containers flatten in document order', () => {
  const out = renderBlockTree(
    [
      { text: 'lead' },
      { columns: [[{ text: 'left' }], [{ text: 'right' }]] },
      { text: 'tail' },
    ],
    { atomic, containers: (b) => b.columns ?? null },
  );
  assert.equal(out, 'lead\n\nleft\n\nright\n\ntail');
});

test('an empty block is dropped rather than leaving a gap', () => {
  const out = renderBlockTree([{ text: 'a' }, { text: '' }, { text: 'b' }], { atomic });
  assert.equal(out, 'a\n\nb');
});

test('an empty container contributes nothing', () => {
  const out = renderBlockTree(
    [{ text: 'a' }, { columns: [[{ text: '' }], [{ text: '' }]] }, { text: 'b' }],
    { atomic, containers: (b) => b.columns ?? null },
  );
  assert.equal(out, 'a\n\nb');
});

test('runs of blank lines collapse and the document is trimmed', () => {
  const out = renderBlockTree([{ text: '\n\na\n\n\n\nb\n\n' }], { atomic });
  assert.equal(out, 'a\n\nb');
});

test('a tree with no renderable content is the empty string, not whitespace', () => {
  assert.equal(renderBlockTree([{ text: '' }, { text: '  ' }], { atomic }), '');
});

// ---- the leaf renderers ----

test('code tabs lose their syntax highlighting before the fence goes on', () => {
  const out = codeTabsToMarkdown([
    { label: 'Rust', language: 'rust', code: '<span class="k">let</span> x = &amp;1;' },
  ]);
  assert.equal(out, '**Rust**\n\n```rust\nlet x = &1;\n```');
});

test('a code tab with no language still fences', () => {
  assert.equal(codeTabsToMarkdown([{ label: 'Shell', code: 'ls' }]), '**Shell**\n\n```\nls\n```');
});

test('a banner is a blockquote, with or without an override', () => {
  assert.equal(bannerToMarkdown('Stub'), '> **[Stub]**');
  assert.equal(bannerToMarkdown('Stub', '<em>needs work</em>'), '> **[Stub]** _needs work_');
});

test('references are numbered, and an empty list renders nothing at all', () => {
  assert.equal(
    referencesToMarkdown([{ text: 'A paper', url: 'https://x.test' }, { text: 'A book' }]),
    '### References\n\n1. A paper — https://x.test\n2. A book',
  );
  assert.equal(referencesToMarkdown([]), '');
  assert.match(referencesToMarkdown([{ text: 'x' }], 'Sources'), /^### Sources/);
});

test('stats carry their suffix and drop out when empty', () => {
  assert.equal(
    statsToMarkdown([{ value: '99', suffix: '%', label: 'uptime' }, { value: 12, label: 'nodes' }]),
    '- **99%** — uptime\n- **12** — nodes',
  );
  assert.equal(statsToMarkdown([]), '');
});

test('a link grid keeps its headings, optional descriptions and links', () => {
  const out = linkGridToMarkdown(
    [
      { heading: 'Docs', description: '<p>Start here.</p>', links: [{ label: 'Guide', href: '/g' }] },
      { heading: 'Code', links: [{ label: 'Repo', href: '/r' }] },
    ],
    'Everything in one place.',
  );
  assert.equal(
    out,
    'Everything in one place.\n\n### Docs\n\nStart here.\n\n- [Guide](/g)\n\n### Code\n\n- [Repo](/r)',
  );
});

test('a flat link list is one bullet per link', () => {
  assert.equal(
    linkList([{ label: 'A', href: '/a' }, { label: 'B', href: '/b' }]),
    '- [A](/a)\n- [B](/b)',
  );
  assert.equal(linkList([]), '');
});
