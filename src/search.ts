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
 * cannot score as prose. Then three classes of non-prose are collapsed to
 * spaces:
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
  return `regexp_replace(translate(jsonb_path_query_array(${content},'$.**.text')::text, chr(160),' '),'${PROSE_PATTERN}',' ','g')`;
}

/**
 * The `regexp_replace` pattern inside {@link proseSql}, as it must appear in
 * SQL. Written for a single-quoted SQL string literal, so a backslash that
 * Postgres' regex engine should see as an escape is doubled here.
 */
export const PROSE_PATTERN = '<[^>]*>|&nbsp;|\\\\[nrt"\\\\/]|", "|\\["|"\\]';

/**
 * The generated column behind the full-text tier: title at weight A, prose at
 * weight B, so a title hit outranks a body hit inside tier 3 as well as across
 * tiers.
 */
export function searchTsvSql(content = 'content', title = 'title'): string {
  return `setweight(to_tsvector('english', coalesce(${title},'')), 'A') || ` +
    `setweight(to_tsvector('english', coalesce(${proseSql(content)}, '')), 'B')`;
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
