// search.ts — the SQL invariants behind ranked wiki search.
//
// Both wikis run the same four-tier search over block JSON, and both build a
// `search_tsv` generated column to back the fourth tier. The expression that
// defines "prose" therefore appears twice per repo at minimum — once in the
// DDL that generates the column, once in the query that reads it — and the
// literal tier and the full-text tier disagree about what a page says the
// moment those two drift.
//
// They did drift. In September 2026 caper learned that
// `jsonb_path_query_array(...)::text` renders a JSON array literal, so the
// array's own syntax arrives as prose: a search for the literal `", "` matched
// 262 of 262 pages, `\n` matched 245, and `ts_headline` windowed on the
// punctuation and showed it to readers mid-snippet. caper fixed its two copies
// together; radix-wiki's four (one DDL, three inline) kept the defect, and each
// of the six carried a comment asserting they must stay identical.
//
// So the expression lives here, once, and every copy is derived. Nothing in
// this module touches a database or a driver: it returns SQL text, and each
// repo interpolates it into its own tagged template with its own table, scope
// and select list. Those genuinely differ — radix-wiki returns ranked ids to
// hydrate, caper returns rows — and pretending otherwise would cost more than
// the drift did.

/**
 * Every `text` value at any block depth, as prose.
 *
 * `$.**.text` rather than the raw JSON, so block ids and `type` discriminators
 * cannot score as prose. In strict mode: lax, Postgres' default, unwraps each
 * array `.**` meets and visits its elements twice, so every value came out
 * twice — measured on all 624 miow pages in October 2026, doubling snippets and
 * every lexeme in `search_tsv`. `silent` keeps strict from raising on items
 * with no `text`. Then three classes of non-prose are collapsed to spaces:
 *
 *   - markup (`<[^>]*>`) and the `&nbsp;` entity
 *   - the JSON array literal's own syntax — `", "` between adjacent values,
 *     the `["` and `"]` at the ends, and `\n` / `\t` / `\"` / `\\` / `\/`
 *     escapes inside values
 *   - `chr(160)`, the literal NBSP, via `translate`, so a typed "534 KB"
 *     matches a stored "534&nbsp;KB"
 *
 * Other HTML entities are deliberately left encoded: `ts_headline` runs on this
 * same expression, and decoding belongs on the way out (see each repo's
 * `summarizePage`), not in an expression a stored generated column depends on.
 *
 * @param content SQL expression for the JSON column — qualify it (`p.content`)
 *                when the query aliases its table.
 */
export function proseSql(content = 'content'): string {
  return `regexp_replace(translate(jsonb_path_query_array(${content},'strict $.**.text','{}',true)::text, chr(160),' '),'${PROSE_PATTERN}',' ','g')`;
}

/**
 * The `regexp_replace` pattern inside {@link proseSql}, as it must appear in
 * SQL. Written for a single-quoted SQL string literal, so a backslash that
 * Postgres' regex engine should see as an escape is doubled here.
 *
 * @internal
 */
export const PROSE_PATTERN = '<[^>]*>|&nbsp;|\\\\[nrt"\\\\/]|", "|\\["|"\\]';

/**
 * The generated column behind the full-text tier: title at weight A, prose at
 * weight B, so a title hit outranks a body hit inside tier 3 as well as across
 * tiers.
 *
 * @internal
 */
export function searchTsvSql(content = 'content', title = 'title'): string {
  return `setweight(to_tsvector('english', coalesce(${title},'')), 'A') || ` +
    `setweight(to_tsvector('english', coalesce(${proseSql(content)}, '')), 'B')`;
}

/**
 * The statements that (re)build a table's `search_tsv` column and its GIN index.
 * Run `column` inside one transaction: DROP then ADD, so no reader ever sees
 * the table without it; then `index`.
 *
 * Rebuilt unconditionally rather than skipped when the column exists. A skip
 * is idempotent about the column and blind to its EXPRESSION: a changed prose
 * expression re-runs clean and changes nothing, and Postgres normalises the
 * stored expression, so comparing it to this string would only produce false
 * rebuilds. The column is derived from `content`, so dropping it loses nothing.
 * Run it BEFORE declaring the column in a Prisma schema: `prisma db push` reads
 * a generated column it does not know about as drift and drops it.
 *
 * @param table the table as SQL names it: `pages`, or `"WikiPage"` for a
 *              PascalCase Prisma model, whose index is `"WikiPage_search_tsv_idx"`.
 */
export function searchTsvDdl(
  table: string,
  { content = 'content', title = 'title' }: { content?: string; title?: string } = {},
): { column: string[]; index: string } {
  return {
    column: [
      `ALTER TABLE ${table} DROP COLUMN IF EXISTS search_tsv`,
      `ALTER TABLE ${table} ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (${searchTsvSql(content, title)}) STORED`,
    ],
    index: `CREATE INDEX IF NOT EXISTS "${table.replaceAll('"', '')}_search_tsv_idx" ON ${table} USING GIN (search_tsv)`,
  };
}

/**
 * `ts_headline` options for a search result snippet: one fragment, wide enough
 * to read as a sentence, with no highlight markers (the caller styles it).
 */
export const HEADLINE_OPTIONS =
  'MaxWords=32, MinWords=16, ShortWord=3, MaxFragments=1, StartSel="", StopSel=""';

/**
 * Normalisation flag for `ts_rank_cd` on the full-text tier: 32 is
 * `rank/(rank+1)`.
 *
 * Tier 3 is reached only by queries the literal tiers could not answer, and it
 * routinely matches a large share of the corpus — `what is a validator` and
 * `what does a validator do` reduce to the same lexeme and return the identical
 * rows — so ordering is the whole product on this tier. Normalisation 2 (divide
 * by document length) was measured and is worse: it promotes one-line stubs
 * above the long article the asker wants.
 */
export const FTS_RANK_NORMALIZATION = 32;

/**
 * Escape a user's query for use inside a `LIKE`/`ILIKE` pattern.
 *
 * `%`, `_` and `\` are metacharacters there and are literal in what a person
 * typed, so a search for "100%" or "snake_case" means what it says. Returns the
 * empty string for a blank query — callers should treat that as "no search"
 * rather than as a pattern matching everything.
 */
export function escapeLikeTerm(query: string): string {
  return (query ?? '').trim().replace(/[\\%_]/g, char => `\\${char}`);
}

/**
 * A query as the full-text tier reads it: a hyphen or underscore inside a word
 * is a space. `websearch_to_tsquery` keeps a hyphenated word as a phrase that
 * needs the compound itself, so the slug `radix-pipeline` found nothing where
 * `radix pipeline` found sixteen pages. A leading `-` is websearch's NOT, and
 * stays.
 */
export function fullTextQuery(query: string): string {
  return (query ?? '').trim().replace(/([\p{L}\p{N}])[-_]+(?=[\p{L}\p{N}])/gu, '$1 ');
}

/** Edits between two words, a swapped adjacent pair counting as one. */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  return d[a.length]![b.length]!;
}

/**
 * A query with each misspelled word replaced by the nearest word in `vocabulary`
 * (word → how often it occurs), or `null` when no word changes. Called only for
 * a query that found nothing, so a word the wiki already uses is never touched.
 *
 * Tight on purpose: a word of four to seven letters may be one edit out, a
 * longer one two, and a shorter one none. Looser, a name the wiki lacks turns
 * into a word it has – `bondix` into `bonds` – and the reader gets an answer to
 * a question they did not ask. Ties go to the commoner word.
 */
export function correctQuery(query: string, vocabulary: ReadonlyMap<string, number>): string | null {
  let changed = false;
  const fixed = query.trim().toLowerCase().split(/\s+/).map(word => {
    const budget = word.length >= 8 ? 2 : word.length >= 4 ? 1 : 0;
    if (!budget || vocabulary.has(word) || !/^[\p{L}\p{N}]+$/u.test(word)) return word;
    let best: string | null = null;
    let bestDistance = Infinity;
    let bestCount = 0;
    for (const [candidate, count] of vocabulary) {
      if (Math.abs(candidate.length - word.length) > budget) continue;
      const distance = editDistance(word, candidate);
      if (distance > budget) continue;
      if (distance < bestDistance || (distance === bestDistance && count > bestCount)) [best, bestDistance, bestCount] = [candidate, distance, count];
    }
    if (!best) return word;
    changed = true;
    return best;
  });
  return changed ? fixed.join(' ') : null;
}
