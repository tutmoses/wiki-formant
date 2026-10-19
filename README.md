# wiki-formant

The portable half of a wiki: derived taxonomy, a spec-correct MCP transport, markdown twins, and the conditional-GET plumbing an agent surface needs.

The editor, history, sanitiser, chart and passkey modules bring their libraries as dependencies (`@tiptap/*`, `fast-diff`, `sanitize-html`, `lightweight-charts`, `@simplewebauthn/*`), since every wiki here uses all five. What only some apps use stays an optional peer: `pg`, `react`, `jose` and `@radixdlt/rola` for ROLA, `sharp` and `@vercel/blob` for uploads. Web-standard `Request`/`Response`, so it runs unchanged on Next route handlers, Hono, Bun, Deno and workers.

```bash
npm install wiki-formant
```

## What this is, and what it deliberately is not

Every wiki needs a design system and a set of block types beyond the core. Those are the parts you must own: they encode your brand and your content model, and a package that tried to own them would fight you.

The page store is no longer one of them. Three wikis kept their own pages and revisions on three schemas that had drifted apart (cuid ids against int ids, a version column on one, no author on another, a tenant key on the third), and each wrote its page and its revision its own way. The tables are now the package's (`prisma/wiki.prisma`), and so is the SQL that reads and writes them (`wiki-formant/store`), so one wiki engine serves a standalone wiki and a multi-tenant host alike. The connection, the cache and the auth stay the app's.

What every wiki *also* needs, rebuilds by hand, and then lets drift, is the layer above: the second browsing axis derived from metadata you are already storing, the HTML→markdown converter behind every `.md` twin, the JSON-RPC edges that decide whether an MCP client can talk to you at all, and the ETag arithmetic that turns a recrawl into a 304.

This package was extracted from three production wikis that had each grown their own copy. By the time it was lifted, the copies had already diverged — one had lost the alphabetical index and the related-page ranking; one had `ToolAnnotations` the others lacked; one had MCP prompts the others lacked. Everything here is the union, with tests pinning the specific bugs that shipped.

## Store

`wikiStore` reads and writes `WikiPage` and `WikiRevision` through one `Sql` function the app binds to its own client, scoped to one site.

```ts
import { wikiStore } from 'wiki-formant/store';

const store = wikiStore({
  sql: (query, ...values) => prisma.$queryRawUnsafe(query, ...values),
  siteId: '',                 // a multi-tenant app passes the site's key
  hidden: tree.hiddenPaths,   // back office: never listed unasked
});

const page = await store.get('contents/tech', 'radix-engine');
const cards = await store.list('contents/tech', { sort: 'recent' });
const { items, total } = await store.search('validators', { take: 20 });
await store.save({ tagPath, slug, content, authorId, message, baseVersion: page.version });
```

- **A save is one statement.** The page update and its revision are a data-modifying CTE guarded on the version the save read. A save that lost a race writes nothing and throws a 409 `HttpError`; pass `baseVersion` and a save opened on an old version is refused the same way, instead of erasing the edit in between.
- **The bump is the diff's.** Added, removed or moved blocks are `major`, changed prose or title `minor`; `change` overrides it for a script that knows better. A metadata-only save moves no version and writes no revision.
- **History is diffed on read.** A revision stores the page as it was saved, never a diff, so a script's revision and the editor's carry the same history. `history(pageId, { limit })` reads one row more than it returns, so the oldest entry shown is diffed against its real predecessor.
- **Listings carry a snippet, not the article.** `list`, `recent` and `byIds` drop `content` for one line of it; a category of 200 cards otherwise ships 200 block arrays.
- **Search is four tiers**: title prefix, title, literal prose, then full text on `search_tsv` with Postgres' own headline as the snippet. Hidden paths are left out unless the search names one; `content: true` keeps each row's blocks.
- **A path under a hidden one is hidden too**, in every listing, whether or not the tree names it.
- **`branch` is an agent's walk**: a path and everything under it, newest first or A–Z, with the total a pager needs and an optional `since`. `counts` is pages per tag path, the back office and the home page left out.
- Ids and timestamps default in the database, so the store's SQL and a Prisma client write the same rows. Copy the models with `npx prisma-models wiki` (a tenant-keyed app checks its own copy with `--tenant`), then build the full-text column with `npx fts-ddl '"WikiPage"'`.

## Tree

`createTree` is the category tree every wiki declares, and the walks each had written by hand.

```ts
import { createTree, parseWikiPath } from 'wiki-formant/tree';

const tree = createTree(NODES, { globalKeys: [QUALITY] });
tree.resolve('contents/tech');   // { node, trail, valid, hidden, sort, mainArticle, metadataKeys }
parseWikiPath(tree, ['contents', 'tech', 'radix-engine', 'history']);
// { type: 'page', tagPath: 'contents/tech', slug: 'radix-engine', mode: 'history' }
```

- Metadata keys accumulate down the trail; `sort`, `mainArticle` and `hidden` are inherited, the nearest declaration winning. A field only one wiki reads (an XRD threshold, a band) rides on the node, and the app folds it from `trail`.
- A path that is itself a category wins over a mode suffix, so a category named `history` stays reachable. The empty slug is a category's hub article, and `/<category>/edit` edits it.
- `crumbs` makes one crumb per URL segment, linked only where the tree knows the segment, so a trail can never be shorter than the address bar.

## Category view

`categoryView` is a category page as radix.wiki browses one, from the tree, the taxonomy and anything that reads like the store: the count, a sort that shows only once the set needs an A–Z index (by a `date` key where the category declares one), the facets its `select` keys give, a letter that exists, and a card per visible section listing its own pages, then its sections.

```ts
import { categoryView } from 'wiki-formant/category';

const view = await categoryView({ tree, taxonomy, pages: store }, 'ecosystem', searchParams);
// { sort, total, pages, all, filters, letter, facets, letters, sortable, clearHref, sortHref, sections }
```

- `pages` is the store, or the app's cached and decorated wrapper over its `list` and `subtree`.
- A link carries `sort` only when it is not the category's own, so the bare category and its default are one address.

## Wiki read tools

`wikiReadTools` is the read half of a wiki's MCP server over its store and tree: `search_wiki`, `get_page`, `get_pages`, `list_pages`, `get_categories`, `get_recent_changes` and `get_full_corpus`. `searchWiki` is the same rows for an app's plain-GET `?q=` and its search page, so the three never disagree.

```ts
import { wikiReadTools, searchWiki } from 'wiki-formant/wiki-tools';

const reading = { store, tree, url: (tagPath, slug) => `${SITE}/${tagPath}/${slug}`, text: extractText, noun: 'the Radix Wiki', corpusTitle: 'Radix Wiki' };
const tools = [...wikiReadTools(reading), ...myOwnTools];
const { items, total } = await searchWiki(reading, 'validators', { page: 1, size: 20 });
```

- Every row carries `path`, which every read tool takes back, and `chars` where the page's text was read. A pasted URL resolves, with `pathPrefix` stripped; a category's path reads its hub article; a miss names the nearest pages.
- `privateHidden` closes the back office to every tool; without it a hidden page is unlisted but readable by path, as its URL is.
- `metadata`, `label`, `corpus`, `noMatch` and `skills` are the app's: what a row adds, how a category is named, the sections its llms-full.txt is made of, what an empty search says, and the A2A skills.
- Writes stay with each app, because who may write is the one thing no two of them agree on.

## Taxonomy

`tagPath` puts a page in exactly one place in a tree. The `select`-typed metadata it already carries is a *cross-cutting* axis — and it is almost always stored, rendered once in an infobox as dead text, and never made pressable. The failure mode is a 141-page category rendered as one flat grid while the data to split it sits unread in a JSON column.

The tree is yours; supply `getMetadataKeys` and the rest is derived.

```ts
import { createTaxonomy } from 'wiki-formant/taxonomy';

const taxonomy = createTaxonomy({
  getMetadataKeys: tagPath => TAGS[tagPath]?.metadataKeys ?? [],
  href: (tagPath, { sort, filters, letter }) => /* your URL contract */,
});

const filters = taxonomy.facetFilters('ecosystem', searchParams);
const pages   = taxonomy.filterPages(allPages, filters, letter);
const facets  = taxonomy.buildFacets('ecosystem', allPages, filters, letter);
const index   = taxonomy.needsAlphaIndex(allPages.length)
  ? taxonomy.alphaIndex(allPages, filters) : [];
```

Four behaviours worth knowing, because each replaces a plausible wrong answer:

- **Each facet is counted over the set narrowed by every *other* active filter**, so its own options stay switchable instead of collapsing to the one already chosen.
- **Values come from the data, not from the declared `options`.** A key that declares four values while the pages hold seven would otherwise hide three behind a bar claiming to cover everything. Render what is there and the drift becomes visible.
- **A single-valued facet hides — unless it is the active one.** An infobox row can set a filter the chips never offered; without its chip the reader lands on a narrowed list with nothing to press to widen it.
- **`metadataRows` returns rows, not markup.** A page's populated keys in schema order, with `href` set exactly on the facet ones. The three wikis each rendered this selection their own way — an HTML table folded into a block, a React `<aside>`, a markdown twin — and differed only in how a *value* is formatted; which keys appear and where each links is the part they had rebuilt three times.
- **`rankRelated` ranks by shared facet values** and returns the shared axis as `{key, value}`, so the *See also* heading can be the link into the filtered set. The behaviour it replaces — `pages.slice(0, 5)` — shows every page in a large category the same five links.

One `href` builder is passed in and used by every chip, letter and sort button. A sort button that drops the active filters is the tell that a project grew a second one.

### The controls, not just the counts

`buildFacets` and `alphaIndex` hand back numbers; something still has to turn each one into a pressable thing with a destination. That step was rebuilt in all three wikis, and by the time this was written they no longer agreed on what the row *contains*: one shipped no A–Z index at all, one had no way back to the unfiltered set, and two marked the active chip with `aria-pressed` on an `<a>` — which is not a toggle button and does not take that attribute.

```ts
const state  = { sort, filters, letter: taxonomy.resolveLetter(all, filters, query.letter) };
const groups = taxonomy.facetControls('ecosystem', all, state);  // [{key, label, options}]
const letters = taxonomy.alphaControls('ecosystem', all, state); // [] below the threshold
```

Every control arrives as `{value, label, count, href, active}`, its `href` already built through your one builder with **every other axis carried along** — the arithmetic that, done by hand, drops the reader's letter the first time they press a chip.

- **The reset control leads the row**, flagged `reset`, so a consumer that maps the array cannot ship a narrowed view with nothing to press to widen it.
- **`alphaControls` returns `[]` below the index threshold**, folding in `needsAlphaIndex` — one call is either the index you needed or nothing, rather than a decision each caller makes and one caller forgets. A hub's sort toggle reads the same predicate over the same unfiltered count (`needsAlphaIndex(all.length)`; 40 pages unless `alphaIndexMinPages` says otherwise), so a set small enough to need no index offers no sort either.
- **`resolveLetter` drops a letter no page starts with.** A stray `?letter=Q` would otherwise empty the grid with no control marked to explain why.


## Headings

Heading ids, permalink anchors, and the list an "on this page" rail renders — one pass over the HTML you already have.

```ts
import { injectHeadingIds, headingsFrom } from 'wiki-formant/headings';

const html = injectHeadingIds(page.body);   // ids + anchors, idempotent
const toc  = headingsFrom(html);            // [{ id, text, level }]
```

Two behaviours worth knowing:

- **The slug rule is a parameter.** A heading id is a live URL — readers link to `#the-shape-of-a-code`, and so does the page's own permalink anchor. The two wikis this was lifted from had drifted onto different rules, and unifying them would have silently moved every published anchor on whichever one lost. Pass `slug` to keep the rule you already ship.
- **Deduping is not a parameter, but its scope is.** Two headings with the same text otherwise mint the same id twice, and every link to the second lands on the first. The unit that must be unique is the page, so a block wiki that injects block by block passes one `used` set to every call — seeded with any id the template renders itself, such as the title's. All three consumers once passed none, and a heading repeated across two blocks shipped two identical ids.

```ts
const used = new Set([slug(page.title)]);
const blocks = page.blocks.map(b => ({ ...b, text: injectHeadingIds(b.text, { used }) }));
```

`headingsFrom` reads the string, not the rendered DOM — possible only where the body IS a string at render time. A wiki whose content streams in as blocks after mount has to query the DOM, and uses only the injector.

## MCP

A minimal [Model Context Protocol](https://modelcontextprotocol.io) server over Streamable HTTP, with the transport edges most implementations get wrong.

```ts
import { mcpResponse, mcpGet, mcpOptions, McpToolError } from 'wiki-formant/mcp';

const config = {
  serverInfo: { name: 'my-wiki', version: '1.4.0' },
  instructions: 'Call search_pages first; get_page needs a full path.',
  docsUrl: 'https://example.com/llms.txt',
  tools: [{
    name: 'search_pages',
    description: 'Full-text search across the wiki.',
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string', description: 'query' } },
      required: ['q'],
    },
    annotations: { readOnlyHint: true },
    handler: async ({ q }) => search(String(q)),
  }],
  onCall: (req, body) => track(req, body),
};

export const POST = (req: Request) => mcpResponse(req, config);
export const GET  = () => mcpGet(config.docsUrl);
export const OPTIONS = () => mcpOptions();
```

What it gets right:

- **A caller-fixable mistake is a tool result with `isError`, never `-32603`.** Bad arguments come back naming every bad field at once, quoting the legal values and appending the schema, so one retry can fix all of them.
- **Capabilities advertise only what the config populates.** An advertised `resources` whose list comes back empty reads as a bug, not as honesty. The `-32601` method list narrows the same way.
- **A notification-only POST answers a bare `202`**, not a `200` carrying JSON `null`.
- **Malformed JSON is `-32700` with a `400`**, never a 500.
- **`GET` is an explicit 405 with CORS headers.** A framework's automatic 405 carries none, so a browser client cannot even read the refusal.
- **The preflight allow-list includes `Accept` and `Mcp-Protocol-Version`.** One missing entry fails the preflight rather than the POST, which presents as "the server is down".
- **Batches are capped** (default 20) with a teaching error, because the rate limiter charges one token per HTTP request before the body is parsed. From 2025-06-18 on they are refused outright, because that revision removed them.
- **Both protocol eras, one endpoint.** A request carrying `io.modelcontextprotocol/protocolVersion` in `params._meta` is served as `2026-07-28`: `server/discover`, per-request version and header validation (`-32022` naming every version spoken, `-32020` on a routing header that disagrees with the body), `resultType` and cache hints on results, and 404 for the methods that revision removed. Everything else is the legacy era, where `initialize` echoes the client's version when it is one of `2025-11-25`, `2025-06-18`, `2025-03-26` or `2024-11-05` and offers the newest otherwise. The spec permits a dual-era server, and it is the only way to adopt the new revision without failing the handshake of every client already in the field.
- **The version is negotiated, not asserted.** Every response carries it back in `MCP-Protocol-Version`. Answering a constant is legal and still costs the caller structured output, tool titles and `_meta` without ever saying so.
- **`Access-Control-Expose-Headers` is set.** Allow-Headers governs what a browser may send, Expose-Headers what it may read — without the second a browser client cannot see `Retry-After` on a 429, and a rate limit presents as a hang.
- **The rate limit is declared, not wired.** Put `rateLimit: {capacity, refillPerSec}` on the config and `mcpResponse` enforces it before parsing the body, refuses with a JSON-RPC envelope, and states `RateLimit-Limit`/`-Remaining`/`-Reset` on every answer. Four routes had each transcribed that by hand through three differently-named local helpers, which is how a headroom header gets added to one surface and forgotten on the next.
- **`mcpRateLimited(retryAfterSec)` is a JSON-RPC envelope.** A 429 whose body is `{"error": "..."}` is a string where the client's parser expects `{code, message}`, on the one response an agent meets exactly when it is working hard.

### Structured output, `_meta`, and the envelope gate

**Every object a handler returns comes back as `structuredContent` beside the text block**, so a client reads the answer rather than scraping prose for it. This used to be gated on declaring an `outputSchema`, and the result was that across four live servers and thirty-two tools — every one of them answering in JSON — not a single response ever carried it. `outputSchema` remains the stronger contract, because a client validates against it; it is no longer the price of admission. A handler returning a string is left alone.

`inputSchema.requireOneOf` names a set of which at least one must be present. `required` cannot express "query or popular", so the one tool needing it checked in its handler and the caller learned at execution time — the single class of argument mistake this module was otherwise catching before dispatch.

A handler's second argument is its context:

```ts
handler: async (args, ctx) => {
  ctx.meta;                                      // params._meta, as it arrived
  ctx.setMeta('x402/payment-response', receipt); // rides back on result._meta
  return { hits: 2 };
}
```

`config.gate` is envelope-level middleware: it may withhold entries before dispatch and merge its own responses back afterwards. A payment gate has to sit there rather than in a handler, because the demand *replaces* the call and the receipt rides on the envelope. `RpcRequest` and `toolText` are exported for a gate to build with; acuiq2's x402 gate is the one that does.

### Tool arguments and the corpus tool

`readArgs` reads a tool's raw arguments as typed, clamped values and records every value it had to override, so a result can say `adjustments: [{ param: 'limit', requested: -4, used: 1, … }]` instead of silently answering a different question. Defaults belong in the tool description; the result echoes only overrides.

`wiki-formant/corpus` is the arithmetic behind a `get_full_corpus` tool: a `sizeOnly` preflight with per-branch and largest-page breakdowns, then page-aligned slices under a `maxChars` budget (`CORPUS_BUDGET`) with `truncated`, `nextSkip` and `clippedPage`. The corpus itself — which rows, how a page becomes a section — is the wiki's; `sliceCorpus` takes the sections it builds.

## Conformance

`wiki-formant/conformance` is the half of an MCP conformance run that is not about any one server's tools: a JSON-RPC client that backs off on a 429, the transport assertions (CORS preflight, `GET`→405, a notification answering 202 with no body, `-32700`, the batch cap, honest `capabilities`, version negotiation), version coherence across every descriptor a surface publishes, A2A card parity, conditional-GET and `robots` checks, and a pass/fail table with an exit code.

```ts
const t = createTester({ base: 'https://example.com', clientName: 'my-mcp-test' });
await transportChecks(t, 'my-mcp-test');
await annotationChecks(t, { writes: ['create_page'] });
await payloadBudget(t, [{ name: 'search', args: { query: 'x' } }]);
process.exit(t.summary());
```

What stays in your repo is fixtures: which tools you expect, what a good answer from each looks like, and which text surfaces you publish. `payloadBudget` weighs every listed call **and** every read-only tool that takes no required arguments, because the one tool nobody thought to list is the one that answers with 3.3 MB; pass a per-call `maxBytes` for a bulk-export tool that is deliberately large. It also asserts that a JSON answer arrived with `structuredContent`.

`standardVersionSources(t, openapiPaths)` is the `versionCoherence` map every S10 surface serves — both agent-card paths, `mcp.json`, the server card and each path the OpenAPI document answers at — so a suite names only the paths it adds. `t.rpcAt(endpoint, …)` and `t.callAt` drive a second MCP endpoint on the same surface with the same backoff, User-Agent and tally.

```ts
await versionCoherence(t, server.version, standardVersionSources(t, ['/openapi.json', '/api/openapi.json']), init.result?.serverInfo?.version);
```

`descriptorChecks(t)` defaults to `S10_DESCRIPTORS`, the six JSON descriptors every surface here serves, and `distinctEtagChecks(t, ['llms.txt', 'llms-index.txt', 'llms-full.txt'])` asserts that depths projecting one corpus carry different ETags — every one present, which a bare Set-size check misses.

## Markdown twins

Pass an `etag` and answer `notModified` before rendering: a twin is the single most recrawled URL a page has, so a twin with no validator is a full render on every pass, forever — the same arithmetic that justifies the corpus ETag, applied per page.

`htmlToMarkdown` preserves the structure an agent cites by — headings, lists, tables, code, emphasis — rather than flattening to prose. Tables convert first so the generic rules cannot eat their markup, ordered lists number per list, pipes inside cells are escaped, and a headerless table gets a synthesised header because GFM has no other form.

```ts
import { htmlToMarkdown, markdownDocument } from 'wiki-formant/markdown';

return new Response(
  markdownDocument(
    { title: page.title, url, updated: page.updatedAt, lastVerified: page.lastVerifiedAt,
      license: { spdx: 'CC-BY-4.0', url: 'https://creativecommons.org/licenses/by/4.0/' } },
    blocksToMarkdown(page.content), // your block types, your function
  ),
  { headers: markdownHeaders(lastModified, { etag, noindex: true }) },
);
```

`noindex` sends `X-Robots-Tag: noindex`, for a twin of an HTML page: a search engine that reads it has the page already. A document with no HTML page, an AGENTS.md, leaves it off.

Block trees stay in your app — every project owns its own type set. Give this module HTML and it gives you markdown.

> A trap worth naming: if you serve twins via a rewrite, Next drops the destination query string. The rewrite must carry the `.md` extension through to the destination path, or the twin silently serves JSON.

## Conditional GET

The `llms.txt` / `llms-index.txt` / `llms-full.txt` trio are the most-recrawled URLs a wiki serves and the most expensive to render. Without a corpus-derived ETag, every AI crawler pays full price on every pass, forever.

A URL that answers JSON or markdown by `Accept` asks `wantsMarkdown(request)` and sends `VARY_ACCEPT` on both branches. Without the Vary, a shared cache hands one client the other's format.

```ts
import { corpusEtag, notModified, textHeaders } from 'wiki-formant/http';

const etag = corpusEtag([pageCount, newestUpdatedAt]);
const lastModified = newestUpdatedAt.toUTCString();

export async function GET(request: Request) {
  return notModified(request, etag, lastModified)
    ?? new Response(buildCorpus(), { headers: textHeaders(etag, lastModified) });
}
```

`descriptorResponse` and `descriptorHandler` serve a JSON descriptor (an agent card, a manifest, an OpenAPI document) with its own ETag and `Access-Control-Allow-Origin: *`, since every descriptor is public and browser agents read them; six of nine routes had passed the header by hand.

`corpusValidatorsFrom(seed, stamps)` is that pair from an aggregate: the newest of `stamps` (the epoch when every one is null), appended to `seed` for the tag. `corpusRoute(validators, build)` is the whole handler, and skips the build on a 304.

```ts
const agg = await prisma.page.aggregate({ _count: true, _max: { updatedAt: true } });
corpusValidatorsFrom([depth, agg._count], [agg._max.updatedAt]);
```

### Route errors

`json`, `errors` and `handleRoute` are the answers a route handler gives when it is not answering with data, as web-standard `Response`s a Next handler returns as they are. Every error body is `{ error, ...extra }`: one origin had these helpers, one had a second convention with a third copy inside a single route, and two answered with whatever `Response.json` was nearest, so one mistake came back three ways depending on the origin.

```ts
import { errors, handleRoute, HttpError } from 'wiki-formant/http';

export const GET = (req: Request) => handleRoute(async () => {
  const q = new URL(req.url).searchParams.get('q');
  if (!q) return errors.badRequest('q is required');
  if (q.length > 200) throw new HttpError(400, 'q is too long', { code: 'INVALID_PARAMS' });
  return Response.json(await search(q));
}, 'Search failed');
```

A thrown `HttpError` answers with its own status and message. Anything else thrown is logged and answered with a 500 carrying only `errorMsg`, so an exception's text — a database error naming a table — never reaches the caller. `errors.tooManyRequests(sec)` states `Retry-After`.

## Response headers

`wiki-formant/headers` holds the six headers every route sends and the Content-Security-Policy they share, for `next.config.ts` to import:

```ts
import { contentSecurityPolicy, securityHeaders } from 'wiki-formant/headers';

const csp = contentSecurityPolicy({ 'connect-src': ["'self'", 'https://*.radixdlt.com'] });

const nextConfig = {
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders(process.env.NODE_ENV === 'production' ? csp : null) }];
  },
};
```

Four configs had restated these by hand on the grounds that a config could not import an ESM-only package. It could not because no subpath had a `default` condition, and Next resolves a config's imports the way `require` does; every subpath has one now, and Node 24 loads the module there unchanged.

`withWikiDefaults(config, { csp })` wraps the whole config: the headers on every route with `csp` enforced in production, AVIF before WebP from the image optimiser, Turbopack's build cache off (Vercel restored a stale one and shipped a stylesheet two commits old), and `distDir` from `STUDIO_DIST_DIR` for radix-studio's second dev server. What the app sets wins, and its own `headers()` follow these.

```ts
export default withWikiDefaults<NextConfig>({ async redirects() { /* … */ } }, { csp });
```

`contentSecurityPolicy` starts from the policy all four origins shared line for line, and each directive passed replaces its default rather than appending, so the call site reads as the whole list. An empty list drops a directive.

The default `frame-src` is `DEFAULT_IFRAME_HOSTS`, the same list the sanitiser's `iframeHosts` defaults to. The sanitiser's comment had asked every config to keep the two matched by hand, and one did not: its policy lacked the bare `youtube.com` and `youtube-nocookie.com` its sanitiser kept, so those embeds survived cleaning and then rendered blank. A site with its own host list passes it to the sanitiser and states the same hosts in its `frame-src`.

## Pagination and versioning

`parsePagination` clamps `page ≥ 1` and `pageSize` to 1–100; `paginatedResponse` always carries `totalPages`. Reshaping that response is a breaking change to every client that pages, which is why it lives here rather than being re-typed per repo.

`parseVersion` / `bump` / `compareVersions` handle revision semver tolerantly — a page always has a version, even when the column holds `null` or junk.

## React

`wiki-formant/react` is the one part that needs React, so it is the one part behind its own subpath, and React is an *optional* peer. What is shared is behaviour; every class name and icon is passed in, because these wikis style their rails differently and always will.

`SidebarProvider` / `useSidebar` hold the rail's collapse state — remembered across loads, defaulted from the viewport only when the reader has never chosen. Pair it with `sidebarBootScript` from `wiki-formant/sidebar` (framework-free, so a server component can stamp it into `<head>`) or a remembered-closed rail paints open and animates shut on every load. `TableOfContents` is the "on this page" list, with scroll-spy, reading either headings you already know or the rendered article.

The rail's breakpoint is necessarily known twice — `matchMedia` here, a media query in a stylesheet — because a media query cannot read a JS constant and a JS constant cannot read a media query. `base.css` holds the CSS half: with `RailShell prefix="wiki-sidebar"` inside a `.wiki-layout` beside a `.wiki-layout__main`, the rail is a sticky column from 1024px and, below it, a drawer stacked above the article that the same open/closed choice shows or removes, table of contents included. 1024 is the default `breakpoint` of `SidebarProvider` and `sidebarBootScript`, so a wiki on `base.css`'s rail passes none. It is measured: an 18rem rail, a full `--measure` of prose (63ch of Inter is 636px) and the page gutters need 972px, and 1024 is the gutter tier above that. The site supplies `--rail-top` (what the sticky rail clears), `--rail-border` (the rule beside the column, which becomes the drawer's foot) and the surface, padding and gap.

What the two halves can be stopped from doing is parting in silence. `base.css` sets `--rail-floating: 1` inside its media query, and the hook checks the two agree on every breakpoint crossing, in development, naming both sides and the number to change. A wiki that lays its rail out itself opts in the same way:

```css
@media (max-width: 767px) {          /* the edge of breakpoint={768} */
  :root { --rail-floating: 1; }
  .sidebar { /* … however this wiki lays its rail out */ }
}
```

Without the property the check stays quiet, since a package cannot require CSS it does not ship. The mechanism is `railBreakpointMismatch` and `readRailFloating` from `wiki-formant/sidebar`, both exported, the first pure.

`useTypeahead` is the search field's state machine. Five surfaces across the three wikis had three implementations and no two agreed on what a search field does; this is their union, because each had a piece the others lacked:

```ts
const { query, setQuery, items, highlight, setHighlight, onKeyDown, reset } =
  useTypeahead({ fetch: searchPages, onPick: page => router.push(page.href) });
```

- **A request-id guard**, so a slow response cannot paint over a newer one. Two of the five surfaces had none: type fast enough and you are reading results for a query you have already replaced.
- **Keyboard navigation.** Two surfaces had none — including the header dropdown of a wiki whose search *is* its primary navigation.
- **Abort and a per-query cache**, which only the third had. The cache is per mount, so a stale result cannot outlive the page.

`fetch` must be referentially stable; it is an effect dependency. Its `signal` is optional to implement — forward it from a REST fetcher, ignore it in a server action.

`useLinkPreview` is the Wikipedia-style hover card: one delegated listener rather than a component per link, which is what makes it viable over an article holding hundreds of anchors. Two wikis had written the same ninety lines — same intent delay, same grace period for the cursor to cross into the card, same clamp arithmetic, same cache. They differed in three things, and those three are the options: which anchors are eligible, what fetches a preview, and how tall the card is.

`useSnapRow` is a carousel as a row scrolled sideways under `scroll-snap-type: x mandatory`, so a finger swipes it with no script; AcuiQ's protocol card, which swapped one point for the next in state, could not be swiped at all. The hook is the rest: `step` for arrows and arrow keys, wrapping round at either end, `go(i)` for a dot or for opening a lightbox on the picture clicked, and `at` for the counter. It ships no markup and no class names, since miow's rows hold pictures and AcuiQ's hold whole acupoints.

```tsx
const { ref, onScroll, at, step, go } = useSnapRow();
<div ref={ref} onScroll={onScroll} className="row">{items}</div>
```

`useClickOutside` is fifteen lines and was in all three. Only one had the `offsetParent` check, and without it a container hidden at the current breakpoint still answers outside-clicks — so on a phone, a tap anywhere dismisses the popover the reader is looking at, because the hidden desktop copy got there first.

`useUnsavedChanges(dirty)` asks before an edit with unsaved changes is left: the browser's own prompt on a reload or a closed tab, and the `confirmLeave()` it returns for a Back link or Cancel, which a client-side navigation never sends through `beforeunload`. If a save leaves by a full page load, pass false once it has landed, or the save's own exit asks. `useSaveShortcut(save)` binds ⌘S and Ctrl+S, reading `save` when the key is pressed.

### The listbox contract

`useTypeahead` shared the state machine across five surfaces and left the ARIA
behind, so all five drifted into different wrongness: one put `aria-selected` on
a plain `<button>`, which is not a role that takes it; one gave the rows
`role="option"` and the container no `role="listbox"`, so the options had no
owner; two had no roles at all; one used a `data-highlighted` attribute, which
nothing reads. None of the five set `aria-activedescendant`, which is the
attribute that announces the highlighted row as the reader arrows through it.

```tsx
const { items, highlight, setHighlight, combobox } = useTypeahead({ fetch, onPick });
const { inputProps, listProps, optionProps } = combobox();

<input {...inputProps} />
<ul {...listProps}>
  {items.map((item, i) => (
    <li key={item.id} {...optionProps(i)} onMouseEnter={() => setHighlight(i)}>…</li>
  ))}
</ul>
```

- **`aria-activedescendant` is omitted, never emptied.** An id resolving to no
  element is worse than no attribute: the field claims an active option and the
  reader announces nothing.
- **`combobox(listKey)` takes a key** because one hook often feeds two rendered
  lists — a header with a desktop field and a mobile one puts both in the same
  document, and a single id set duplicates every option id.

The arithmetic is `wiki-formant/combobox`, which imports nothing, so the rules
are unit-tested without a DOM.

`SortHeader` is the React half of `sortTables`: spread `useTableSort`'s `headerProps(key)` onto it and it renders a `<th aria-sort>` holding a `<button>`, the markup `sortTables` writes into stored tables, so one stylesheet rule draws both arrows. One of the copies it replaced put `onClick` on the cell, which no keyboard can reach.

`useBlockOperations(blocks, setBlocks, { duplicate })` is the five list edits every block editor makes, with ref-stable callbacks, and `BlockActions` is their button bar — every button named, the moves disabled at the ends, clicks kept from bubbling into a row that selects on click. `useRevisionRestore(restore, { onRestored })` confirms, restores and reports an error; `restoreViaPost(endpoint)` is the `restore` for a wiki whose route takes `{ revisionId }`. Of the three restores it replaced, one asked no confirmation and one dropped a failure silently.

## Server components

`wiki-formant/react` carries `'use client'`, and that is a module-level boundary: anything exported from it hydrates in the consumer's tree whether or not it uses a hook. `wiki-formant/react-server` is the same React, without the directive — for the parts of a wiki that are pure functions of their props and should ship no JavaScript at all.

`FacetBar` renders the rows `createTaxonomy` already produces. This is why the taxonomy exports a rows model rather than markup: the rows could always cross the boundary and, until this subpath existed, the markup could not, so all three wikis hand-rendered it and two put `aria-pressed` on an `<a>`. `Breadcrumbs` renders the trail and its `BreadcrumbList` JSON-LD together, because a trail whose structured data is written somewhere else is a trail that will one day disagree with its own markup — which is the case Google penalises. It takes a `base` origin: structured-data URLs must be absolute and a package cannot know the site.
`FacetBar` takes a `count` class to render each count as its own element, and `alphaFirst` to lead with the A–Z row. A chip row above the grid and a panel beside it are the same markup laid out by different stylesheets, so the class names are what tell them apart: `letterRow`, `letterControl` and `letterControlActive` style the A–Z row apart from the facet rows (each falls back to `row`, `control` or `controlActive`); a `text` class wraps each label in its own element and gives a facet option its value as `title`, so a long value can truncate while its count stays in view; and `letterCounts="title"` keeps each letter a bare glyph with its count in the tooltip. With none of them set the markup is what it was. Its JSON-LD goes out through `JsonLd`, which is exported for every other payload a page emits: it re-encodes each `<` as `\u003c`, because these payloads carry authored titles and an authored `</script>` would otherwise close the tag.

`PageNav` is the previous/next pair at the foot of an article — the sequential read the infobox rail's lateral links do not cover. Ordering is the caller's, because it is the one part that is never portable: a wiki's sequence is its section's configured sort, a knowledge base's is a taxonomy walk. Pair it with `adjacentPages` from `wiki-formant/pagination` over a list you already hold — neither wiki needs a query for it, and the two indexed lookups the neighbours used to cost were the reason one of them dropped the control.

`RailShell` stays in `wiki-formant/react`, because it calls `useSidebar` and genuinely is a client component. It renders the rail's landmark, its scroll wrapper and the three collapse states — including the `--instant` class that keeps a remembered-closed rail from animating shut on first paint, and the close-on-navigate that a mobile drawer needs. Only a followed link closes it: a search field or a table-of-contents entry inside the drawer leaves it open. Compose your own rail inside it and mark the active link with `isRailLinkActive`; all three wikis do, and the pre-composed component that used to sit here had one consumer and had already lost both of those behaviours.

`FacetSummary` is the line under the facet bar — how much of the section is showing, and a Clear link when anything is narrowed — with the filtered-empty and empty-section states. `RelatedPages` is the see-also list: a labelled `<aside>` over a `<ul>`, its heading linked to the set `rankRelated` found in common. `InfoboxAside` is the facts panel's named landmark with its "Part of a series on" line, and `InfoboxFacts` renders `metadataRows` as a row-headed table. That table was an HTML string in two wikis, injected as a fake content block; one re-escaped a `"` before each href by hand and the other did not. As React nodes there is nothing to escape. `formatFactValue` is its default cell: a date as its day, a URL or bare domain as an outbound link, `<br>`-separated values as lines.

All three take the router's link component as a prop:

```tsx
import Link from 'next/link';
<FacetBar link={Link} facets={facets} letters={letters} />
```

There is no `next` peer dependency here and there is not going to be one, but a rail that falls back to a bare `<a>` turns every press into a full page load — which is the whole reason a wiki has a persistent rail. So the router arrives through the door.

## AI crawlers

Every wiki kept this roster twice — once in the proxy, keyed by user-agent, to
count an `AI Bot Visit`; once in `robots.ts`, as the agents that get their own
group. Both copies were byte-identical across three repos, and they were
different lists.

```ts
import { trackAiBot, crawlerRules } from 'wiki-formant/crawlers';

trackAiBot(request, event, () => import('@/lib/track'));   // in proxy.ts: whether it counted
const rules = crawlerRules({ allow: '/', disallow, aiAllow });
```

Only one direction of that difference was deliberate: `Applebot-Extended` never
fetches a page, so it belongs in robots and not in the matcher. The other
direction was not. Bytespider, CCBot, cohere-ai, Claude-Web and
Meta-ExternalFetcher were matched by every proxy and named by no robots.txt —
and a crawler obeys only its most-specific matching group, so an agent with no
group of its own falls through to `*`. Three wikis were measuring five crawlers
they had never addressed.

Every agent group also allows the agent surface — `/api/mcp`, the three `llms` exports, `/openapi.json`, `/.well-known/` — without being told. `aiAllow` is what an origin serves beyond that.

`crawlerRules` returns every group robots.txt needs: the wildcard, one per AI crawler, and one for each search engine. Search engines get the HTML site and none of its twins — `/*.md$` always, plus `searchDisallow` — because the `*` group keeps the machine surface open to agents, and for Google a twin is a page it already has. Two origins wrote that group by hand and the third never did, so Google crawled its twins. The `<Link>` prefetch payload (`?_rsc=`) is refused in every group.

`trackAiBot(request, event, load)` counts an `AI Bot Visit` inside `event.waitUntil`: a crawler on the roster wherever it goes, and anything but a search engine that asks for what only agents read (a `.md` twin or `Accept: text/markdown`, the `llms` exports, `/openapi.json`, `/.well-known/`), since most agents are on no roster. Its user agent is kept, so `digest` can name it. `load` is a dynamic import because the tracker pulls in a database client, which a static import would load for every request the proxy sees.

## IndexNow

Bing, Yandex, Seznam, Naver and Yep take a POST of changed URLs instead of waiting to recrawl. The `indexnow` bin reads an origin's live sitemap and posts the rows whose `lastModified` falls inside the window, so the editor, the MCP write tools and the sweep scripts that write straight to the database are all covered with no hook in any of them. It runs where the sweeps run, never as a cron on the host: a submission costs the origin one sitemap render and no scheduled function. The sitemap must render per request. A cached one froze at the last deploy and listed none of the pages edited since, so this bin submitted nothing.

The key is public by design, since an engine checks it by fetching `/<key>.txt`. The file in the app's `public/` is the only copy, and the bin finds it there, so run it from the app's root. It checks that the live origin serves the key before posting anything.

```sh
npx indexnow https://radix.wiki              # rows modified in the last 24 hours
npx indexnow https://radix.wiki --hours 6
npx indexnow https://radix.wiki --all        # every row: a new origin or a new key
```

Rows with no `lastModified` go only in a full submission. A 403 or 422 from the engine exits 1. A sitemap index is read one level down, as `check-pages` reads it.

## Page metadata

`wiki-formant/metadata`'s `pageMetadata` builds a page's canonical, markdown-twin alternate, Open Graph and Twitter card from one input. Next replaces those objects per route segment rather than merging them, and fills a missing twitter card from `openGraph` only when no `twitter` object was inherited — so under a layout that sets its own card, a page that sets one and forgets the other shows the layout's. Two wikis wrote a helper around that, covering different halves.

```ts
export const generateMetadata = () => ({
  title,
  ...pageMetadata({ title, description, url, type: 'article', image: ogImageUrl(title), siteName, handle, markdownTwin: true }),
});
```

The schema.org nodes sit beside it, because they state the same facts to a different reader. `articleLd` requires `image` — two of three wikis shipped articles without one while their og:image named a card — so pass it the card `pageMetadata` got. `collectionLd` is an index page over an `ItemList`, and `citationsFromReferences` turns a `references` block into `Article.citation`.

```tsx
<JsonLd data={articleLd({ headline: title, url, image, published, modified, publisher: { '@id': `${SITE_URL}/#organization` }, citation: citationsFromReferences(refs) })} />
```

`questionPairs(html)` reads a page's FAQ out of its own headings: every `h2`/`h3` ending in `?`, answered by the text beneath it. It never rewrites a statement heading as a question, so a page earns `FAQPage` by being written as one. `faqPageLd(pairs, url)` is that node, or null under two pairs, and takes an authored list just as well.

```tsx
const faq = faqPageLd(questionPairs(html), url);
{faq && <JsonLd data={faq} />}
```

`describe(text)` is a page's meta description from any prose, HTML, markdown or plain: tags, entities, link targets and bare URLs go, and the rest fits `DESCRIPTION_LIMIT` (160) as whole sentences where they fill half of it, else cut at a word with an ellipsis. Four sites had four rules, one cutting mid-word at 150 and one slicing at 160 with no mark. `openingText(blocks)` (`wiki-formant/text`) is what a page without an excerpt is described by: its first top-level `content` block with prose once the headings are out, since a page that opens with an infobox would otherwise be described by its metadata table.

```ts
const description = describe(page.metadata?.excerpt || openingText(page.content));
```

`sitePageMetadata({ siteName, handle })` binds the three fields Next drops from every page that sets its own card, with `locale` defaulting to `en_US`. `siteGraphLd` is the Organization, WebSite (with its `SearchAction`) and `WebAPI` as one `@graph` for the root layout, every node carrying an `@id`, and `siteRefs(url)` hands out the same ids for a page's `publisher` and `isPartOf` — so no page writes an inline copy of the publisher that can disagree with the layout's.

```ts
export const card = sitePageMetadata({ siteName: SITE_NAME, handle: '@example' });
export const SITE = siteRefs(SITE_URL);
<JsonLd data={siteGraphLd({ name, url: SITE_URL, logo, sameAs, searchUrl, api })} />
```

## Revisions

What changed between two versions of a page, and therefore which semver bump to
ask for. Both wikis had written it and `extractBlocks` was byte-identical
between the copies; they differed only in what each had learned since.

```ts
const diff = computeRevisionDiff({
  currentVersion: page.version,
  oldContent, newContent, oldTitle, newTitle,
  // containers: defaults to coreBlockGroups — `columns.i.blocks` and an infobox's `blocks`
});
```

- **Blocks match by id**, so a block that moved is one `moved` and not a removal
  plus an addition.
- **Container keys are never diffed as attributes.** They are walked as their own
  entries, and comparing them here would report an infobox as edited every time
  anything inside it changed — turning a prose edit into a structural bump.
- **The path segment is part of the contract**, because `root.1.columns.0.blocks.2`
  is what a reviewing UI anchors on. A wiki with a container beyond the core two
  passes its own `containers` and says how it is addressed.

One copy also built two Maps keyed by a recursive `JSON.stringify` of every
block, on every save, and never read either one. Matching is by id and always
was. That half is not here.

## History

What each revision changed, as a history view shows it. `revisions` stays free
of dependencies because every save imports it; this is the reading half, and it
needs `fast-diff`.

```tsx
import { withChanges } from 'wiki-formant/history';
import { RevisionChanges } from 'wiki-formant/react-server';

const rows = withChanges(revisionsNewestFirst); // each row needs its `content`
<RevisionChanges changes={rows[0].changes} label={type => BLOCK_LABELS[type]} />
```

- **Diffed on the server, from stored content.** radix-wiki used to send both
  HTML bodies of every modified block to the browser and diff them there: 887 KB
  of payload for a 13-revision page whose drawn diffs came to 25 KB. A row
  leaves `withChanges` without its content.
- **Words, not letters.** Semantic cleanup is on, so a rewritten sentence reads
  as the old words struck and the new ones added.
- **Leaves only.** A container's own entry restates its children. A leaf whose
  type changed is a replacement and gets no text diff. `leafText` names the prose
  field of a block beyond the core `content` one.
- **A window diffs against what precedes it.** The oldest row is diffed against
  an empty page, so fetch one revision more than you show and drop the last row.

`RevisionChanges` marks struck and added text as `<del>` and `<ins>` and keys
each change on `data-action`; `base.css` only resets the list.

## Feeds

Three repos, four feeds, 47 of 64 significant lines identical — including,
verbatim in two of them, the comment explaining why the apostrophe escapes
numerically. `feedResponse` is the union.

```ts
export const GET = async (request: Request) => feedResponse(request, channel, await items());
```

`feedResponse` renders the channel and answers a conditional GET: the ETag is the XML's own, Last-Modified the build date. All four feeds used to return the XML bare, so a poller could never be told the channel was unchanged.

**`lastBuildDate` comes from the newest item, not the clock.** One copy stamped
`new Date()` on every request, telling every poller the feed had changed when it
had not — the recrawl the conditional-GET helpers exist to prevent. An empty feed
carries no build date rather than a fictional one.

## Sitemaps

`treeSitemap(pages, { sections, sectionRow, pageRow })` returns the rows a wiki's tree adds to its sitemap: a row per section, dated by the newest page at or beneath it, then a row per page, dated by its own `updatedAt`. All three wikis listed their sections, and each dated them differently. One used the newest page beneath, one did the same from a derived tree, and one used no date at all. A section with no page beneath it carries no date rather than an invented one.

```ts
...treeSitemap(pages, {
  sections: tagPrefixes(pages.map(p => p.tagPath)),
  sectionRow: path => ({ url: `${SITE_URL}/wiki/${path}`, changeFrequency: 'weekly', priority: 0.6 }),
  pageRow: p => ({ url: pageUrl(p), changeFrequency: 'weekly', priority: 0.7 }),
}),
```

Every URL appears once. An empty-slug page is its section's own article, so it dates the section and gets no row of its own. A section whose URL a page already holds is served as that page, so the section row is dropped. `tagPrefixes` lists every path at or above the given ones, for a wiki whose sections are wherever its pages sit rather than a configured list. Which sections exist, the URLs, and each row's frequency and priority stay with the caller.

## Licence declarations


S10 wants a licence on every surface, and each repo satisfied that by writing the
same block again. What is genuinely per-project is the *scope* — which half of a
site the grant covers and what it excludes — so that is the parameter.

```ts
const license = ccBy40({ siteName: 'AcuiQ', siteUrl: SITE_URL });
const block = licenseBlock({ license, scope: 'The protocol compilation and prose', excludes });
```

The same `License` goes to `agentCard({ license, licenseScope })` and to `openApiLicense(license)` for a spec's `info.license`. The three cards and three specs here had each projected it differently, one from a hand-typed name.

## Rendered-article passes

`wiki-formant/dom` holds what runs against an article element after it is in the document. Not React, so not in `react.tsx`.

```ts
addCopyButtons(el);            // every <pre> gets one, once
sortTables(el);                // every column-headed table sorts by its headers
hydrateTweetEmbeds(el);        // placeholders get a live src
const off = onTweetResize(h => sizeTweetEmbeds(el, h));
```

`addCopyButton` was **byte-identical** in two BlockRenderers, down to the SVG path data. Its idempotence guard now lives inside the function rather than in a `pre:not(:has(…))` at the call site, where it can be — and was — retyped.

In React, `useArticlePasses(ref, [blocks])` runs the three passes and `useTweetEmbeds(ref, [html])` the embed pair, from `wiki-formant/react`. Three renderers had the effect written out and disagreed on its dependencies: two ran once on mount, so a page swapped in without a remount kept its old tables unsortable.

`activateTabGroups` turns stored `[data-tabs]` markup into a working tab group. The editor persists tabs as nested divs, which is the right thing to store — it survives a markdown twin, a plain HTML render and a reader with JavaScript off, all of which show every tab in order. Making one of them pressable is a reader-side job, and it sits beside the other passes rather than inside a component.

`sortTables` makes the tables stored in article HTML sortable by their headers. They arrive as a string a `dangerouslySetInnerHTML` wrote, so React never sees their rows and cannot sort them. A column is dates if every filled cell starts with one, numbers if every one does, and text otherwise — one stray value makes the whole column text, which beats sorting half of it by one rule and half by another. A third press restores the author's order, which is often chronological or ranked and otherwise needs a reload. Label/value tables and tables with merged cells are left alone. The markup it writes — `aria-sort` on the cell, a `.sort-header` button inside it — is the markup a React sortable header should write too, so both kinds of table draw their arrows from one stylesheet rule.

`scrollTables(html)` is the one table pass that runs on the string, before render: it wraps each stored table in a `.table-scroll` box, and `base.css` lets that box scroll sideways. A table box ignores `overflow`, so a table with an address or a URL in a cell is as wide as that token whatever its column, and a scroll box added by an effect would arrive after the table had already been laid out too wide. Call it on the render path beside `injectHeadingIds`. A table already in a box keeps it, so it is safe on HTML that has been through it once. `articleHtml(html, { used, slug, anchor, links })` (`wiki-formant/headings`) is that chain: heading ids, the scroll boxes, and, given `links`, `normaliseLinks`.

The embed's origin is written down once. It is both the embed host and the allow-list `onTweetResize` checks before believing a posted height, and it had been spelled out at four call sites across two repos. Any page can `postMessage`; only the embed host may size the embed.

## Search

`proseSql`, `HEADLINE_OPTIONS` and `FTS_RANK_NORMALIZATION` are what a literal tier and a full-text tier must agree on. `searchTsvDdl(table)` is the statements that build the generated `search_tsv` column and its index — dropped and re-added in one transaction every run, because a skip-if-present script is blind to a changed expression.

## Block trees

Every wiki here stores the same two containers the same way — `columns[i].blocks` and an infobox's `blocks` — and between them had hand-written that walk seven times. Bind it once and hand it to every walk:

```ts
import { coreBlockShape, leafBlocks, mapBlockTree } from 'wiki-formant/blocks';

export const BLOCK_SHAPE = coreBlockShape<Block>();
mapBlockTree(blocks, processLeaf, BLOCK_SHAPE);
leafBlocks(blocks, BLOCK_SHAPE.containers);
```

`computeRevisionDiff` defaults to the same shape, path-addressed, so a repo whose containers are the core two passes none.

The dispatch over a repo's own block union stays in that repo; the bodies come from here. `coreAtomicText` has a prose body for every core leaf — the stats, link-grid and page-list bodies joined the originals when two of the three wikis turned out to extract nothing from them, so their MCP `get_page` answered a hub page as nearly empty.

The core leaves — `content`, `codeTabs`, `banner`, `references`, `stats`, `linkGrid`, `recentPages`, `pageList` — had the same case bodies in every wiki's text export, markdown twin, validator and new-block record. A repo's switch hands those cases over and keeps its own, so it stays exhaustive over its union:

```ts
import { coreAtomicText, coreAtomicToMarkdown, coreBlockDefaults } from 'wiki-formant/blocks';
import { coreAtomicValidator } from 'wiki-formant/validation';

switch (block.type) {
  case 'content': case 'codeTabs': case 'banner': case 'references':
  case 'stats': case 'linkGrid': case 'recentPages': case 'pageList':
    return coreAtomicToMarkdown(block, { siteUrl: SITE_URL, referencesTitle: 'Sources' });
  case 'corpusStats':
    return block.resolvedHtml ? htmlToMarkdown(block.resolvedHtml) : '';
}

const BLOCK_DEFAULTS = { ...coreBlockDefaults({ stats }), daoTimeline: () => ({ type: 'daoTimeline', limit: 25 }) };
const core = coreAtomicValidator({ pageId: id => /^\d{1,9}$/.test(id) });
// validateAtomic: b => { switch (b.type) { case 'daoTimeline': …; default: return core(b); } }
```

`coreAtomicToMarkdown` joins a resolved page's site-relative `href` to `siteUrl`, because a twin is read off-site; a wiki whose lists hold its own page rows keeps those two cases. `coreAtomicValidator` caps `recentPages.limit` and `pageIds` at `MAX_BLOCK_ROWS`, a whole number of rows, because both end in a database `take:`; `blockLimit` is the same bound on the read side.

`createBlockValidator` returns `blockIssues` beside the boolean validators: the same walk, reporting where each failure is.

```ts
const issues = blockIssues(body.content);
if (issues.length) return badRequest(`Invalid content: ${describeBlockIssues(issues)}`);
// Invalid content: [2].columns[0].blocks[1]: malformed linkGrid block
```

A `codeTabs` tab's `code` is source text in every wiki here, and every view treats it that way: `CodeTabsView` escapes it into a `<pre><code>`, the sanitiser leaves it alone, the markdown twin fences it verbatim. A wiki that escapes and highlights on the server passes `highlighted` to the view. The package used to assume editors stored highlighted markup; none ever had, and every twin printed `Vec<u8>` as `Vec`.

`recentPages` and `pageList` resolve to `ResolvedPageRef`s — build each with `pageRef(page, now)`, which carries the ISO date a `<time>` needs — and `PageRefsView` renders them as a list, with a `renderItem` slot for a wiki that has its own row.

## Dates

`relativeTime(then, now, { style })` is `compact` (`3h`), `short` (`3h ago`) or `long` (`3 days ago`, day-grained for pages cached for hours), with `absoluteAfterDays` to hand over to the date itself. `now` is always passed in, never read, so a server render and its hydration agree. `formatDay` is always UTC: a stored day formatted in the server's zone, or the browser's, is the previous day for half the world. It reads `en-US` unless given a `locale`: `formatDay(day, { locale: 'en-GB', month: 'long' })` is `19 September 2026`. Both are in `wiki-formant/freshness`, with `isoDate`.

## Sanitising stored HTML

`wiki-formant/sanitize` is the allowlist between an author's saved HTML and a reader's browser. The block views render two HTML fields themselves — `linkGrid` descriptions and `references` text — and a repo renders `content.text` beside them, so the guard ships with the renderer. `codeTabs` is not one of them: its code is source. Run it server-side, on the render path, so it covers rows written before it existed and no sanitiser ships to the client.

```ts
import { createHtmlSanitizer, sanitizeCoreLeaf } from 'wiki-formant/sanitize';

const clean = createHtmlSanitizer({ iframeHosts: FRAME_HOSTS });   // and the same hosts in the CSP's frame-src
const safe = mapBlockTree(blocks, b => sanitizeCoreLeaf(b, clean), BLOCK_SHAPE);
```

The default list is derived from what the editor nodes in `wiki-formant/tiptap` store — the embed wrappers' data attributes, the tab markup `activateTabGroups` reads back, the table classes — plus the presentational SVG subset the infographics pipeline embeds. Extend it with `tags`, `attributes`, `classes` and `schemesByTag` derived from your stored HTML, never from memory: a list written from memory erases content on the first render.

Classes pass by name only. Limiting `style` to layout and paint is worth nothing while `class` is free, because every site's own stylesheet ships `fixed inset-0 z-50`, and those draw a fake prompt over the chrome as well as `position` does.

## Image uploads

`wiki-formant/upload` is the route an editor's image upload posts to. Two wikis had written it and their limits had drifted: one took 25 MB with no cap on decoded pixels and trusted the Content-Type the client sent, the other 4 MB, 40 megapixels and the file's own leading bytes. These are the second one's defaults.

```ts
// src/app/api/upload/route.ts
export const runtime = 'nodejs';
export const POST = uploadHandler({
  authorize: async () => (await currentUser())?.id ?? errors.unauthorized('Sign in to upload.'),
  prefix: 'wiki/',
});
```

The bytes say what the file is, never the name or type, and SVG is refused. Every image is re-encoded, upright, so nothing from the source's metadata is kept, a phone's GPS position included; the bytes as sent are never stored. `encode` is the re-encode, the sniffed format by default; a wiki with an image standard resizes and converts there. Each uploader has a budget keyed on `authorize`'s id and address, and each address one of its own, so an id minted fresh per burst (a self-signed wallet) refills nothing. `maxBytes`, `maxPixels` and `rateLimit` take other limits, and `store` replaces Vercel Blob. `sharp` and `@vercel/blob` are optional peers. `normalizeImage(bytes, { maxPixels, encode })` is the same sniff, cap and re-encode without the route, for images that arrive another way – a server action, or a picture copied in from another site; it resolves to `{ buffer, format, contentType }` and throws a message fit to show the uploader.

## Editor nodes

`wiki-formant/tiptap` carries the custom nodes both wiki editors had written twice: `Iframe`, `YouTube` (the stock extension plus the paste rule it does not ship with), `TwitterEmbed`, `createMapEmbed`, `createCodeBlock` and `createTabs`. `Iframe` and `createMapEmbed` draw a frame only for an https src on `DEFAULT_IFRAME_HOSTS` (`embedSrc`), since an editor draws stored HTML where its author is signed in, and a `javascript:` src runs there under any CSP that allows inline script.

```ts
const CodeBlock = createCodeBlock({
  classNames: { button: 'lang-btn', option: 'lang-option', optionActive: 'text-accent' },
  icons: { chevron: open => <ChevronDown className={open ? 'rotate-180' : ''} /> },
});
```

The language list defaults to `CODE_LANGS` and `DEFAULT_LANG` from `wiki-formant/blocks`, which two wikis had typed identically; a wiki with its own passes `langs` and `defaultLang`. The ones that take config take it because that is exactly where the two copies differed — class tokens, the language list, and the API route a shortened map URL has to be resolved through. Injecting them is what lets one wiki keep `text-jupiter` and the other `text-accent` without either forking the node, and it keeps this file from dragging an icon library in behind it.

`createTabs` returns `TabGroup` and `TabItem` together: `tabGroup`'s content expression is `tabItem+`, so registering one without the other leaves a node type the schema cannot satisfy. A pasted short map link inserts immediately with `about:blank` and swaps its `src` when the redirect resolves — pasting must not block on a network hop, and the node has to exist for the reader to see anything happen.

`createHeadingIds({ slug })` decorates each heading in the editor with the id its published copy will carry, through `uniqueHeadingId` — the dedupe `injectHeadingIds` uses — so a rail listing headings mid-edit links to the anchors readers will get. `uploadImageTo('/api/upload')` is the `uploadImage` two editors had written identically.

`toolbarActions([...])` picks the formatting commands, in order, with the labels a screen reader announces — two toolbars titled buttons with the internal key, so one said "codeBlock". `WikiToolbar` lays them out the way three wikis had each assembled them by hand: the format buttons, Remove link while the cursor is in a link, upload and embed, the insert buttons, and the table controls while the cursor is in a table. Every button is a `ToolbarButton` (named, and `aria-pressed`, since these are toggles); the link button opens the address field and reads as on while it is open. Which buttons, icons and classes are yours; a toolbar shaped differently builds from `ToolbarButton` and `runTableAction` directly.

```tsx
<WikiToolbar editor={editor} isActive={isActive} prompt={url} actions={FORMAT} trailing={INSERT} onUpload={triggerUpload} embed
  icons={{ ...ICONS, unlink: <Unlink />, upload: <Upload />, embed: <Globe /> }}
  classNames={{ toolbar: 'toolbar', button: 'toolbar-btn', pressed: 'toolbar-btn-on', divider: 'toolbar-divider' }} />
<UrlPromptField prompt={url} classNames={{ row: 'row', input: 'input', apply: 'btn', cancel: 'btn-quiet' }} />
```

`useUrlPrompt(editor, { resolveMapUrl })` is the link and embed address field under a toolbar, in place of a `window.prompt` that blocks the page and cannot show the link the cursor is in. Three editors had written it and one still used the prompt; only one copy both opened a link field on the current address and unlinked on an emptied one. The hook carries both, closes the field when the editor it serves changes (a toolbar shared between blocks would otherwise apply it to the wrong one), and leaves the markup to you.

`UrlPromptField` is its markup: an address input on which Enter applies and Escape closes, and Apply and Cancel.

A link is stored as its `href` and the `link` class, nothing else. Stock Tiptap writes `target="_blank" rel="noopener noreferrer nofollow"` onto every link, internal ones included, which on a site throws away its own link equity and opens in-site navigation in new tabs. Whether a link is external depends on the host serving the page, so `normaliseLinks` decides it at render time. A legacy link loses both attributes the next time its page is saved.

The redirect resolves through the wiki's own route, because the editor cannot read it cross-origin. `resolveMapUrl` is the client half and `resolveMapHandler` the whole route: exact shortener hosts, one hop, an allowlisted landing host, a timeout, and your sign-in check as `authorize`. One of the two copies it replaced matched `goo.gl` as a substring and followed every redirect for anyone who asked.

```ts
export const GET = resolveMapHandler({ authorize: async () => !!(await currentUser()) });
```

## Block editor

`wiki-formant/block-editor` is the block list an author edits and the fields of the core types. Three wikis had written it, 500 to 700 lines each, and had drifted: one dropped a stored code language its list did not name, one let a typed count run past the row cap, one named every remove button "Remove", one never marked the block being edited. The behaviour is here once; the look arrives as a kit.

```tsx
const KIT: BlockEditorKit = {
  classNames: { list: 'stack', card: 'block-card', action: 'icon-btn', input: 'input', row: 'row', … },
  icons: { add: <Plus />, up: <ChevronUp />, down: <ChevronDown />, duplicate: <Copy />, remove: <Trash2 /> },
  Choice: ToggleGroup,   // optional: a <select> otherwise
  Menu: PopoverMenu,     // optional: an inline panel otherwise
};
const SCHEMA: BlockSchema<Block> = {
  meta: type => BLOCK_META[type], create: createBlock, duplicate: duplicateBlock,
  types: PAGE_TYPES, nestedTypes: ATOMIC_TYPES, single: ['infobox'],
  renderBody: (block, onUpdate) => {
    switch (block.type) {
      case 'codeTabs': return <CodeTabsFields block={block} onUpdate={onUpdate} />;
      case 'columns': return <ColumnsFields block={block} onUpdate={onUpdate} />;
      case 'daoTimeline': return <DaoTimelineEdit block={block} onUpdate={onUpdate} />;
      …
    }
  },
};
<BlockEditor blocks={blocks} onChange={setBlocks} schema={SCHEMA} kit={KIT} />
```

The dispatch stays a `switch` over the wiki's own union, so a new type is a compile error there. `CodeTabsFields`, `StatsFields`, `ReferencesFields`, `LinkGridFields`, `BannerFields`, `PageListFields`, `ColumnsFields` and `InfoboxFields` take the core blocks `wiki-formant/blocks` declares; the two containers hold the same list, offering `nestedTypes`. `Field`, `Choice` and `LimitField` are exported for a wiki's own editors, so its native types wear the same kit. A card is marked `data-selected` while it is being edited and `data-nested` inside a container; a type the build does not know is shown by its raw type and carried through untouched. Keep the kit and the schema stable — a module constant or a `useMemo` — since both reach every card through context, and a fresh one re-renders every card on every keystroke.

An editor that draws each block in place, with a list of its own (miow's), hosts the same fields in `<BlockFieldsKit kit={KIT}>`, without `<BlockEditor>`. Only the two container fields need the full editor, since they hold a block list.

A banner with no text of its own shows `BANNER_MESSAGES` from `wiki-formant/text`, a sentence per variant that names no wiki; `BannerView` takes it unless `message` overrides it.

The core blocks are `ContentBlock`, `CodeTabsBlock`, `StatsBlock`, `LinkGridBlock`, `ReferencesBlock`, `BannerBlock`, `ColumnsBlock<A>` and `InfoboxBlock<A>`, `A` being the wiki's atomic union. A wiki builds its union from them beside its own `recentPages` and `pageList`, which hold its own page rows or a section, and its native types.

## Analytics

Page views and events, counted in the site's own Postgres instead of a hosted
service. No cookie is set and no address is kept: a visitor is a hash of the
address and browser under a salt that is replaced every UTC day, and the old
salt is deleted, so a visitor is told apart within a day and never followed
into the next. Rows are kept 400 days. The package owns the SQL and the app
owns the connection: `Sql` is one function that runs a statement with `$1, $2…`
placeholders, and the four tables it needs ship as Prisma models in
`prisma/analytics.prisma` (see `prisma-models` below). The fourth, `ViewDay`, holds days a site counted
elsewhere before it counted its own; `digest` adds them to any window that
reaches back that far, and a site with no such history leaves it empty.

```ts
// src/lib/track.ts
const sql: Sql = (query, ...values) => prisma.$queryRawUnsafe(query, ...values);
export const { trackEvent, trackMcpCall, trackSearch, viewRoute } =
  createTracker({ sql, defer: after, siteUrl: SITE_URL });

// src/app/api/view/route.ts – the whole beacon route
export const POST = viewRoute();

// the root layout, once
<Beacon />
```

`createTracker` records only on a Vercel production deployment unless told
otherwise (`enabled`), because dev and previews write to production's
database. `trackMcpCall(request, body, server?)` fits `McpServerConfig.onCall`;
`trackSearch(headers, query, results, surface?)` takes the headers or Next's
`headers` itself, which it reads inside the deferred write. `viewRoute({ site })`
passes a site resolver to `collect`. The module that builds the tracker
imports the app's database client, so a proxy reaches it through a dynamic
`import()` inside `event.waitUntil`, never a static one.

`<Beacon>` (`wiki-formant/react`) sends a view each time the path changes,
client-side moves included, and a click on a link to another host as an
"Outbound Link: Click" event; `track(name, props)` (`wiki-formant/dom`) sends
any other browser event. Underneath the tracker, server code calls
`recordEvent` and leaves the deferral to the framework, so this package keeps
its zero-dependency guarantee:

```ts
after(() => recordEvent(sql, { name: 'Signup', props: { plan }, url, headers }));
```

`mcpCallProps` reads a tool name out of a JSON-RPC envelope that is untrusted
and may be a batch; `trackSearch` normalises a search box's free text so
the same question aggregates as one row, and drops an empty one. Pass the request's headers and the
event joins whoever sent it, person or agent.

`digest(sql, { days })` reads a site back as one JSON object: visitors, agents,
page views, bounce rate, visit length, sources (a link's `utm_source`, else the
referring host), top and entry pages, countries, devices, visitors and agents by
day, the agents by name, MCP tool calls, and the searches that found nothing.
An agent is counted as a visitor is, one address and user agent a day, from its
`AI Bot Visit` and `MCP Call` events; it runs no page script, so it is never
among the visitors. `ownAgents` leaves the site's own out. A visit is a run of one
visitor's views with no gap over 30 minutes. A multi-tenant app passes a `site`
key to every call and a `site` resolver to `collect`.

Instrumenting the agent lane and not the human one is the easy mistake: it
leaves a wiki able to say what every crawler asked for and nothing about what
its readers asked for. The queries that return zero rows are the valuable ones
– they name a gap in the corpus in the reader's own words.

## Passkeys and the stats page

`wiki-formant/passkey` is the door to a site's own admin pages: a passkey and
nothing else, no account, password or email. `createPasskeyGate({ sql, rpName })`
returns the whole of it. `gate.route` is the sign-in route, `gate.signOut` the
sign-out route, `gate.signedIn(cookieValue)` is the check a page makes, and
`gate.cookie` is the cookie's name. The two tables (`Passkey`, `PasskeyToken`) ship as Prisma
models in `prisma/passkey.prisma`, and every token is kept only as its hash.

There is no sign-up. Every passkey, the first among them, is saved from a
single-use link that the `passkey-invite` bin prints from a machine holding
`DATABASE_URL`, so a fresh deployment cannot be claimed by whoever reaches it
first. A passkey is bound to the host it was saved on, so localhost needs its
own. A session names the passkey that signed in: deleting a `Passkey` row signs
out every session it opened.

```ts
// src/lib/admin.ts
export const gate = createPasskeyGate({ sql, rpName: 'Caper' });

// src/app/api/passkey/route.ts
export const POST = gate.route;
export const DELETE = gate.signOut;

// src/app/stats/page.tsx
const q = statsQuery(params); // ?days= (1, 7, 30, 90, 365 or all, else 30) and the filters
return (
  <StatsGate gate={gate} session={(await cookies()).get(gate.cookie)?.value} invite={params.invite} host="caper.network">
    {async () => <Stats digest={await digest(sql, q)} {...q} />}
  </StatsGate>
);
```

`StatsGate` (`wiki-formant/stats`) renders `children` and a sign-out button for a signed-in reader and, for anyone else, the line saying what the prompt will do and the passkey button that does it; `classNames` places the text, the button's box, the button and its error. Those buttons are the browser half of `wiki-formant/passkey`, and they have no subpath of their own.

`Stats` (`wiki-formant/stats`) renders a `digest` as one page: the
headline figures, each with its change from the window before
(`.stats-delta[data-better]`, a share or for the bounce rate points, for the
site's stylesheet to colour), one of them by day, week or month (a count's
total, a rate's mean), every non-empty
ranked list, and `?days=` links between windows, all time among them, pinned in
the chart's frame as its own buttons are (`TimeChart`'s `controls`). Each
figure is a button that charts it: visitors, agents, page views, bounce rate,
visit length and clicks to X. `digest`'s `by_day` carries every
one of those per UTC day, a visit on the day it began, so the days add up to the
totals. A day with no visits has no bounce rate or visit length and is left out
of those charts rather than drawn as zero. Everything but the figures and the
chart is server-rendered.

Every row in a list is a link that narrows the page to it, and the narrowings
stack: `?page=`, `?entry=`, `?source=`, `?country=` and `?device=`, each shown as
a chip that drops it. A narrowing keeps the visits that pass – that saw the
page, began on it, came from the source, or were made from the country or
device – and recounts every figure, list and day from those visits alone, with
events only from their visitors. Agent tool calls and missed searches are
events no visit reaches, so their rows are not links. `ViewDay` keeps totals,
not visits, so a narrowed page starts at `counted_from`, the first day the site
counted itself, says so, and drops the comparison with the window before. The chart is `TimeChart` with a count
axis from zero.

## ROLA sign-in

`wiki-formant/rola` is the part of a Radix wallet sign-in two sites had each written: a single-use challenge, the wallet's proof of it, and the HS256 token a verified address is handed. How a site keeps the session stays with it, because the two keep it differently: radix-wiki a `Session` row behind a seven-day cookie, caper a stateless token it slides forward, with a short one for agents.

```ts
const rola = createRola({ expectedOrigin, dAppDefinitionAddress, networkId, applicationName, challenges: prisma.challenge });
const { challenge } = await rola.generateChallenge();
const v = await rola.verifySignedChallenge(signed);        // { isValid, error? }

const secret = sessionSecret(process.env.JWT_SECRET);      // throws under 32 characters
const token = await signSession({ id: signed.address }, secret, 7 * 86400);
const claims = await verifySession<{ id: string }>(bearerToken(request.headers) ?? cookie, secret);
```

Where the two copies differed, this takes the stricter. A challenge is spent by one conditional delete, so two requests racing with one signature cannot both pass, and it is spent whatever the outcome; making one purges the expired. Only an account proof signs in. Verification pins HS256. `jose` and `@radixdlt/rola` are optional peers.

## Charts

`TimeChart` (`wiki-formant/chart`) is every time-series chart on the four sites:
token prices, ledger activity, a caper's price, visitors per day. One area
series in the box's own `color`, its axis in `--chart-axis` if set, with range
buttons — 24H, 7D, 30D, 90D, 1Y, All — then, after a rule, the day, week and
month steps. The steps show wherever a range is drawn by day, so the buttons
never shift; one is enabled once it makes four points (none under 24H and 7D,
which are drawn by the hour and the four hours), and the default is the finest
that makes 200 or fewer, so a year opens weekly and five years monthly.

```tsx
// Daily points: the chart slices and steps them itself; 30D up.
<TimeChart series={days} label="Transactions" aggregate="sum" fromZero />

// A loader: asked for 'hour' (24H), '4h' (7D) or 'day' from 0 (every longer
// range), once each.
<TimeChart series={load} label="Price" format={formatPrice} range="30d" candles />
```

A price point may carry `open`, `high` and `low` (its `value` is the close)
and `volume`. Points that carry the candle get a candles switch, a candlestick icon
pressed while they show, opening on candles with `candles`; points that carry volume get a volume pane under the
price, a fifth of the height. Candles take `--chart-up` and `--chart-down` from
the canvas box, else its `color`. A week of candles opens on its first, closes
on its last, spans the highest high and lowest low, and sums its volume. A point
with a volume of zero is a stretch nothing traded in: its candle and bar leave
the slot empty, except the last, which is the price now. A price's line is
straight between closes and a count's is curved.

`aggregate` is how a week or month is made from its days: `last` for a price,
`sum` for a count, so a week reads as the week's total, and `mean` for a rate,
which no total makes sense of. A stepped range starts on a whole week or month,
so its first point is not a few days of one; the week in progress is its total
so far. `fromZero` starts a count's axis at zero and stops it there, with
no negative ticks under it. A single range draws no range buttons and shows every point.
`chartSteps` is exported for a chart drawn elsewhere.

`format` writes the axis and the crosshair label. An axis tick also gets the
spacing between ticks as a second argument, so a formatter can write every tick
to the same precision and two never read alike: `stepDecimals(step)` is the
decimal places that takes, and `formatChartValue`, the default, uses it.

`markers` are events, `{ time, label }`, each drawn as an arrow on the last
point at or before it, so one mid-week lands on its week and two on one point
share it. `step` opens on a step where the
range can make it, and `onView` hears the range and step on mount and on every
change, for a page that keeps them in its URL:

```tsx
<TimeChart series={days} label="Transactions" aggregate="sum" fromZero
  markers={[{ time: haltAt, label: 'Halt' }]} step="month" onView={v => keep(v)} />
```
`base.css` pins the buttons (`.chart-controls button[aria-pressed]`) to the
canvas's top-left corner, rules a line between groups and dims a disabled step;
the site's stylesheet gives them and the box a look.

## Base stylesheet

`wiki-formant/base.css` is the layout the package's markup does not work without, and nothing else: columns that stack until there is room, stored tab panels that show one at a time, a copy button pinned to its block's corner and visible on focus and on touch, a table's scroll box, the stats block's grid, the code-tab strip, the banner's row and the infobox's wrapping, the breadcrumb row, the `aria-sort` arrow as a mask over `currentColor`, the stats page's grid and bars, and the chart's height and pinned buttons. It also carries the shape and motion of the primitives every site re-implemented and forked — `.spinner` (a `currentColor` ring sized by `--spinner-size`), `.skeleton`'s pulse, `.empty-state`, the wrap rule for long tokens in inline `code` — and the reduced-motion guard none of them had. No colour and no scale, so a design system's own rules override it at equal specificity.

```css
@import "wiki-formant/base.css" layer(components);
```

No view emits a Tailwind utility any more — `ColumnsView` states its gap and alignment as data attributes, and an inactive code tab is `hidden` — so a site no longer needs its Tailwind to scan this package for the markup to work.

## API

Every module has a subpath — `wiki-formant/taxonomy`, `wiki-formant/mcp`, and so on —
and there is no root export: `import … from 'wiki-formant'` does not resolve. A
barrel loads every module it names for the one symbol a route wanted, and had
already re-exported one module twice. The emitted `.d.ts` files are the reference.
There is no hand-maintained symbol list here, because the one that used to be here
drifted from them. A function a module uses only itself is marked `@internal`: the
package's tests still reach it, and the `.d.ts` leaves it out.

`wiki-formant/tsconfig.base.json` is the compiler floor: an app's `tsconfig.json` extends it and keeps only `paths`, `include`, `exclude` and any licensed extra, since tsconfig resolves those against the file that declares them.

```json
{ "extends": "wiki-formant/tsconfig.base.json", "compilerOptions": { "paths": { "@/*": ["./src/*"] } }, "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", "src/app/.well-known/**/*.ts", ".next/types/**/*.ts", ".next/dev/types/**/*.ts"], "exclude": ["node_modules"] }
```

`wiki-formant/db` holds `pgPoolConfig(url)`, the options every app here hands to
`new pg.Pool()`: ten clients on Supabase's 6543 transaction pooler, three on the
5432 session pooler, whose fifteen-client cap a build's workers share. It also
holds `prismaConfig(root, schema?)`, what an app's prisma.config.ts hands
`defineConfig`: `.env` loaded from `root`, the schema folder (or one file) and
migrations under it, and DIRECT_URL preferred, because the Prisma CLI's
connections hang on the transaction pooler.

```ts
// prisma.config.ts
import { defineConfig } from 'prisma/config';
import { prismaConfig } from 'wiki-formant/db';

export default defineConfig(prismaConfig(import.meta.dirname));
```

`rateLimit` takes `blockMs` (and a `blockKey`, default the bucket's own) for a
caller already shown to be abusive: running dry blocks the key outright for that
long, across every bucket that names it, rather than letting the refill trickle
one token through at a time. `clientIp` reads `x-real-ip` first — Vercel sets it
and overwrites any inbound copy — and the leftmost `x-forwarded-for` only where no
`x-real-ip` was set, since a proxy that appends hands the client that slot.
`limitClient(prefix, headers, opts)` is the per-address gate, `rateLimit` over
`clientKey`, which a dozen call sites had written out.

## A bin

`check-classes` fails a build on a `className` token that resolves to nothing, and counts the inverse fault — 3+ Tailwind utilities inline, which is a component class that was never named. Both sets are derived from the emitted stylesheets rather than listed, so nothing has to be maintained per project. Run it from a repo root after a build:

```sh
npx check-classes                # exit 1 on any dead token
npx check-classes --warn         # report and exit 0
npx check-classes --compositions # also fail on the inline compositions
```

`analytics-digest` prints a site's `digest` as JSON for a script outside the app. Run it from the app's root, where `pg` is installed and `.env` holds `DATABASE_URL`:

```sh
npx analytics-digest --days 7
npx analytics-digest --days 30 --handle radixwiki --siblings caper.network,acuiq.com
npx analytics-digest --days 7 --gap "Symptom Miss:term"   # adds an event to the search gaps
```

`passkey-invite` prints a single-use link that saves a passkey for the page it names, good for a day (`--days n` for longer). No routine calls it: the site's owner runs it by hand, from an app's checkout, for the first passkey and whenever another device or person needs into the stats page. Run it the same way:

```sh
npx passkey-invite https://caper.network/stats
```

`prisma-models` copies the models the analytics and passkey SQL reads, `prisma/analytics.prisma` and `prisma/passkey.prisma`, into an app's schema folder, and `--check` exits 1 when a copy is missing or has drifted. Prisma reads a schema split across one folder's files, so the app moves `prisma/schema.prisma` into `prisma/schema/`, points `prisma.config.ts`'s `schema` at the folder, and keeps its generator, datasource and own models there beside the shipped files. A generator `output` is relative to the file that declares it, so it gains a `../`.

```sh
npx prisma-models            # write both into prisma/schema
npx prisma-models --check    # in the build, before prisma generate
```

An app that keeps one schema file and writes the models into it by hand, because each needs a relation the shipped one cannot carry, checks them in place: `--in` names the file and compares model by model, ignoring comments and spacing, and `--tenant` lets each `siteId` drop its default and gain a `@relation` on it.

```sh
npx prisma-models analytics --check --in prisma/schema.prisma --tenant   # miow
```

`fts-ddl <table>` rebuilds a table's `search_tsv` generated column and its GIN index from the expression `wiki-formant/search` queries, over `DIRECT_URL` (else `DATABASE_URL` on 5432). Run it before declaring the column in `schema.prisma`; the bin's header says why. A PascalCase Prisma table goes in quoted, as SQL names it.

```sh
npx fts-ddl pages
npx fts-ddl '"WikiPage"'
```

`mark-verified` stamps `lastVerifiedAt` on pages a sweep checked and found current, so `freshnessBanner` stops calling them outdated, and `maintenance-log` is the state I/O of a wiki-sweep routine whose memory lives in one page's `metadata.state`: `read`, `write` (the whole state, or `-` for stdin), `compact` and `backlog-add`, which appends under a row lock so another routine's item cannot be lost to a concurrent `write`. Every write compacts and re-renders the page, holding at most as many FLAG FOR A HUMAN items as the page shows; a revision is written at most once a day. `write` refuses a state whose `totalRuns` is below the stored one, which is a state read before another run wrote. Both work on the package's own `WikiPage` and `WikiRevision`. Run them from the app's root, like `passkey-invite`:

```sh
npx mark-verified contents/tech/radix-engine scrypto       # one page
npx mark-verified --all ecosystem --invalidate wiki        # a tag path, then the cache tag
npx maintenance-log read --at contents/tech/operations/wiki-maintenance-log --routine wiki-sweep --author <id>
npx maintenance-log backlog-add '[{"item": "…"}]' --at operations/wiki-maintenance-log --routine caper-wiki-sweep
```

`--site <siteId>` names the wiki in a multi-tenant app (default `""`), and `--invalidate <tag>` runs `vercel cache invalidate` after a write.

## A reusable workflow

`.github/workflows/publish-mcp-registry.yml` republishes an origin's server to the MCP registry when the version in its `server.json` moves. Each app keeps its own trigger and calls it with its domain:

```yaml
on:
  push: { branches: [main], paths: ['server.json'] }
  workflow_dispatch:
jobs:
  publish:
    uses: tutmoses/wiki-formant/.github/workflows/publish-mcp-registry.yml@main
    with:
      domain: example.com
    secrets:
      MCP_REGISTRY_PRIVATE_KEY: ${{ secrets.MCP_REGISTRY_PRIVATE_KEY }}
```

## Licence

MIT.
