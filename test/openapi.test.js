import { test } from 'node:test';
import assert from 'node:assert/strict';
import { llmsTxtPath, mcpPath, openApiDocument, toolBody } from 'wiki-formant/openapi';
import { ccBy40 } from 'wiki-formant/license';

const license = ccBy40({ siteName: 'Wiki', siteUrl: 'https://w.example' });

test('the document carries the licence and the one server', () => {
  const doc = openApiDocument({ title: 'T', version: '1.2.3', description: 'D', license, siteUrl: 'https://w.example' }, { '/x': {} });
  assert.equal(doc.openapi, '3.1.0');
  assert.deepEqual(doc.info.license, { name: license.name, identifier: 'CC-BY-4.0' });
  assert.deepEqual(doc.servers, [{ url: 'https://w.example' }]);
  assert.equal('components' in doc, false);
});

test('a tool body drops the path fields and refers to a shared schema', () => {
  const BLOCK = { type: 'object' };
  const body = toolBody(
    { properties: { slug: { type: 'string' }, content: { type: 'array', items: BLOCK } }, required: ['slug', 'content'] },
    { inPath: ['slug'], refs: { Block: BLOCK } },
  );
  const schema = body.content['application/json'].schema;
  assert.deepEqual(schema.required, ['content']);
  assert.deepEqual(Object.keys(schema.properties), ['content']);
  assert.deepEqual(schema.properties.content.items, { $ref: '#/components/schemas/Block' });
});

test('the shared paths say what every site serves', () => {
  assert.match(mcpPath(['search_wiki', 'get_page']).post.description, /Tools: search_wiki, get_page\..*rate limit/);
  assert.ok(llmsTxtPath('Index').get.responses['304']);
});
