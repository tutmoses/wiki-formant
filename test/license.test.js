import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ccBy40, licenseBlock, licenseLines, licenseNote } from '../dist/license.js';
import { serverCard, SERVER_CARD_SCHEMA } from '../dist/well-known.js';

const license = ccBy40({ siteName: 'AcuiQ', siteUrl: 'https://acuiq.com' });

test('the grant is the same one in every repo, credited to the caller', () => {
  assert.equal(license.spdx, 'CC-BY-4.0');
  assert.equal(license.url, 'https://creativecommons.org/licenses/by/4.0/');
  assert.equal(license.attribution, 'Source: AcuiQ (https://acuiq.com), CC BY 4.0');
  assert.equal(licenseNote(license), 'Creative Commons Attribution 4.0 International (CC-BY-4.0): https://creativecommons.org/licenses/by/4.0/');
});

test('scope is stated rather than implied', () => {
  // Every consumer grants over some of what it serves and not all of it, so the
  // scope sentence is the part that must not be shared.
  const out = licenseBlock({ license, scope: 'The knowledge base and essays' });
  assert.ok(out.includes('The knowledge base and essays is licensed under the Creative Commons'));
  assert.ok(out.includes('- SPDX identifier: CC-BY-4.0'));
  assert.ok(out.includes('You may ingest, embed, and redistribute'));
});

test('carve-outs are appended, and absent when there are none', () => {
  const bare = licenseLines({ license });
  assert.equal(bare[bare.length - 1], '- SPDX identifier: CC-BY-4.0');
  const scoped = licenseLines({ license, excludes: ['The body diagrams are not licensed for reuse.'] });
  assert.equal(scoped[scoped.length - 1], 'The body diagrams are not licensed for reuse.');
  assert.equal(scoped[scoped.length - 2], '');
});

test('the heading follows the site that renders it', () => {
  assert.ok(licenseBlock({ license }).startsWith('## License & Attribution'));
  assert.ok(licenseBlock({ license, heading: 'Licence & Attribution' }).startsWith('## Licence & Attribution'));
});

test('BUG: a server card projects, so it cannot carry a second description', () => {
  // One repo retyped title and description as literals beside the manifest it
  // was already importing, and nothing compared the two copies.
  const manifest = {
    name: 'wiki.radix/server',
    title: 'Radix Wiki',
    description: 'A decentralised wiki',
    version: '3.1.0',
    websiteUrl: 'https://radix.wiki',
    remotes: [{ type: 'streamable-http', url: 'https://radix.wiki/api/mcp' }],
  };
  const card = serverCard(manifest, '2025-06-18');
  assert.equal(card.$schema, SERVER_CARD_SCHEMA);
  assert.equal(card.version, manifest.version);
  assert.equal(card.description, manifest.description);
  assert.deepEqual(card.remotes, [
    { type: 'streamable-http', url: 'https://radix.wiki/api/mcp', supportedProtocolVersions: ['2025-06-18'] },
  ]);
});

test('a manifest without optional fields yields a card without empty ones', () => {
  const card = serverCard({ name: 'x/y', version: '1.0.0' }, '2025-06-18');
  assert.equal('title' in card, false);
  assert.equal('remotes' in card, false);
  assert.equal(card.name, 'x/y');
});
