import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  proseSql, searchTsvSql, escapeLikeTerm,
  PROSE_PATTERN, HEADLINE_OPTIONS, FTS_RANK_NORMALIZATION,
} from 'wiki-formant/search';

// The regex as Postgres must receive it. Written out longhand rather than
// derived from the module, so a change to PROSE_PATTERN fails here instead of
// agreeing with itself.
const EXPECTED_PATTERN = '<[^>]*>|&nbsp;|\\\\[nrt"\\\\/]|", "|\\["|"\\]';

test('the pattern is what Postgres receives, backslashes and all', () => {
  assert.equal(PROSE_PATTERN, EXPECTED_PATTERN);
  // A SQL single-quoted literal is not backslash-escaped, so the regex engine
  // sees these verbatim: `\\` is one literal backslash, `\[` one literal `[`.
  assert.ok(PROSE_PATTERN.includes('\\\\[nrt"\\\\/]'), 'escape class survives');
  assert.ok(!PROSE_PATTERN.includes("'"), 'no quote can close the SQL literal');
});

test('prose strips markup, entities and the JSON array literal', () => {
  const sql = proseSql();
  assert.ok(sql.startsWith('regexp_replace(translate(jsonb_path_query_array(content'));
  assert.ok(sql.includes("'$.**.text'"), 'reads text at any depth, not the raw JSON');
  assert.ok(sql.includes('chr(160)'), 'literal NBSP collapsed');
  assert.ok(sql.includes(EXPECTED_PATTERN));
  assert.ok(sql.endsWith("' ','g')"));
});

test('the content expression is qualifiable for an aliased table', () => {
  assert.ok(proseSql('p.content').includes('jsonb_path_query_array(p.content'));
  assert.ok(!proseSql('p.content').includes('jsonb_path_query_array(content'));
});

test('the generated column weights title above prose', () => {
  const tsv = searchTsvSql();
  const a = tsv.indexOf("'A'"), b = tsv.indexOf("'B'");
  assert.ok(a > -1 && b > -1 && a < b, 'title at A, prose at B, in that order');
  assert.ok(tsv.includes(proseSql()), 'the B half is the same prose the query reads');
  assert.ok(tsv.includes("coalesce(title,'')"));
});

test('the generated column takes its own column names', () => {
  const tsv = searchTsvSql('body', 'heading');
  assert.ok(tsv.includes("coalesce(heading,'')"));
  assert.ok(tsv.includes('jsonb_path_query_array(body'));
});

test('LIKE metacharacters in a typed query are escaped', () => {
  assert.equal(escapeLikeTerm('100%'), '100\\%');
  assert.equal(escapeLikeTerm('snake_case'), 'snake\\_case');
  assert.equal(escapeLikeTerm('a\\b'), 'a\\\\b');
  assert.equal(escapeLikeTerm('  spaced  '), 'spaced');
});

test('a blank query escapes to the empty string, not a match-all', () => {
  assert.equal(escapeLikeTerm('   '), '');
  assert.equal(escapeLikeTerm(''), '');
  assert.equal(escapeLikeTerm(undefined), '');
});

test('the snippet asks for one unmarked fragment', () => {
  assert.ok(HEADLINE_OPTIONS.includes('MaxFragments=1'));
  assert.ok(HEADLINE_OPTIONS.includes('StartSel=""'));
  assert.ok(HEADLINE_OPTIONS.includes('StopSel=""'));
});

test('rank normalisation is 32, not length division', () => {
  assert.equal(FTS_RANK_NORMALIZATION, 32);
});
