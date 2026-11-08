# wiki-formant

The portable half of a wiki: a page store, derived taxonomy, a spec-correct MCP transport, markdown twins, block rendering and editing, and the conditional-GET plumbing an agent surface needs.

The editor, history, sanitiser, chart and passkey modules bring their libraries as dependencies (`@tiptap/*`, `fast-diff`, `sanitize-html`, `lightweight-charts`, `@simplewebauthn/*`). What only some apps use is an optional peer: `pg`, `react`, `jose` and `@radixdlt/rola` for ROLA, `sharp` and `@vercel/blob` for uploads. Web-standard `Request`/`Response` throughout, so it runs on Next route handlers, Hono, Bun, Deno and workers.

```bash
npm install wiki-formant
```

An agent can start a wiki for you, hosted on miow.me or in your own app, with the skill in `skills/wiki-formant`: `npx skills add tutmoses/wiki-formant`.

What stays the app's: its design system, its block types beyond the core, its connection, cache and auth. Everything else here is shared.

## API

Every module has a subpath (`wiki-formant/taxonomy`, `wiki-formant/mcp`, …) and there is no root export: a barrel loads every module for the one symbol a route wanted. The emitted `.d.ts` files are the reference; this README shows one use of each subpath and the rules a signature cannot say. A function a module uses only itself is marked `@internal` and left out of the `.d.ts`.

`wiki-formant/tsconfig.base.json` is the compiler floor: an app's `tsconfig.json` extends it and keeps only `paths`, `include`, `exclude` and any licensed extra, since tsconfig resolves those against the file that declares them.

```json
{ "extends": "wiki-formant/tsconfig.base.json", "compilerOptions": { "paths": { "@/*": ["./src/*"] } }, "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", "src/app/.well-known/**/*.ts", ".next/types/**/*.ts", ".next/dev/types/**/*.ts"], "exclude": ["node_modules"] }
```

## Store

`wiki-formant/store`: `wikiStore` reads and writes `WikiPage` and `WikiRevision` through one `Sql` function the app binds to its own client, scoped to one site.

```ts
import { wikiStore } from 'wiki-formant/store';

const store = wikiStore({
  sql: (query, ...values) => prisma.$queryRawUnsafe(query, ...values),
  siteId: '',                 // a multi-tenant app passes the site's key
  hidden: tree.hiddenPaths,   // back office: never listed unasked
});

const page = await store.get('contents/tech', 'radix-engine');
const { items, total } = await store.search('validators', { take: 20 });
await store.save({ tagPath, slug, content, authorId, message, baseVersion: page.version });
```

- **A save is one statement**: the page update and its revision in a CTE guarded on the version read. A lost race, a stale `baseVersion`, a page deleted since or a rename onto a taken slug writes nothing and throws a 409 `HttpError`.
- **The bump is the diff's**: added, removed or moved blocks are `major`, changed prose or title `minor`; `change` overrides it. A metadata-only save moves no version and writes no revision.
- **History is diffed on read.** A revision stores the page as saved. `history(pageId, { limit })` reads one row more than it returns, so the oldest entry shown has its real predecessor.
- **Listings carry a snippet, not the article**: `list`, `recent` and `byIds` drop `content`.
- **Search is four tiers**: title prefix, title, literal prose, then full text on `search_tsv` with Postgres' headline as the snippet. Hidden paths, and paths under them, are left out unless named.
- `branch` is an agent's walk of a path and everything under it; `counts` is pages per tag path.
- Copy the models with `npx prisma-models wiki` (`--tenant` for a tenant-keyed copy), then build the full-text column with `npx fts-ddl '"WikiPage"'`.

## Tree

`wiki-formant/tree`: the category tree a wiki declares, and its walks.

```ts
import { createTree, parseWikiPath } from 'wiki-formant/tree';

const tree = createTree(NODES, { globalKeys: [QUALITY] });
tree.resolve('contents/tech');   // { node, trail, valid, hidden, sort, mainArticle, metadataKeys }
parseWikiPath(tree, ['contents', 'tech', 'radix-engine', 'history']);
// { type: 'page', tagPath: 'contents/tech', slug: 'radix-engine', mode: 'history' }
```

- Metadata keys accumulate down the trail; `sort`, `mainArticle` and `hidden` inherit, the nearest declaration winning. A field only one wiki reads rides on the node.
- A path that is itself a category wins over a mode suffix. The empty slug is a category's hub article.
- `crumbs` makes one crumb per URL segment, linked only where the tree knows it.

## Category view

`wiki-formant/category`: a category page from the tree, the taxonomy and anything that reads like the store.

```ts
import { categoryView } from 'wiki-formant/category';

const view = await categoryView({ tree, taxonomy, pages: store }, 'ecosystem', searchParams);
// { sort, total, pages, all, filters, letter, facets, letters, sortable, clearHref, sortHref, sections }
```

A link carries `sort` only when it is not the category's default, so the bare category and its default are one address.

## Wiki read tools

`wiki-formant/wiki-tools`: the read half of a wiki's MCP server: `search_wiki`, `get_page`, `get_pages`, `list_pages`, `get_categories`, `get_recent_changes`, `get_full_corpus` and `get_page_history`. `searchWiki` is the same rows for a plain-GET `?q=` and a search page.

```ts
import { wikiReadTools, searchWiki, type CorpusSection } from 'wiki-formant/wiki-tools';

const reading = { store, tree, url: (tagPath, slug) => `${SITE}/${tagPath}/${slug}`, text: extractText, noun: 'the Radix Wiki', corpusTitle: 'Radix Wiki' };
const tools = [...wikiReadTools(reading), ...myOwnTools];
const { items, total } = await searchWiki(reading, 'validators', { page: 1, size: 20 });
```

- Every row carries `path`, which every read tool takes back, its `id` (what a `pageList` block takes), and `chars` where the text was read. A pasted URL resolves, with `pathPrefix` stripped; a miss names the nearest pages.
- `get_page` with `blocks: true` returns the stored blocks, `id`, metadata and `version`: what an edit starts from. `forEdit` adds the app's own edit fields; `authors` names revision authors.
- `text` should be the twin's serializer and `resolve` the page's live resolver, so a page reads the same over MCP as at its twin.
- `get_full_corpus` is a `sizeOnly` preflight, then page-aligned slices under `maxChars` (`CORPUS_BUDGET`) with `truncated`, `nextSkip` and `clippedPage`. `corpus` returns the app's own `CorpusSection`s.
- `privateHidden` closes the back office to every tool. `metadata`, `label`, `noMatch` and `skills` are the app's.
- Writes stay with each app.

## Taxonomy

`wiki-formant/taxonomy`: the cross-cutting browsing axis derived from the `select` metadata pages already carry. The tree is yours; supply `getMetadataKeys` and one `href` builder.

```ts
import { createTaxonomy } from 'wiki-formant/taxonomy';

const taxonomy = createTaxonomy({
  getMetadataKeys: tagPath => TAGS[tagPath]?.metadataKeys ?? [],
  href: (tagPath, { sort, filters, letter }) => /* your URL contract */,
});
const state   = { sort, filters, letter: taxonomy.resolveLetter(all, filters, query.letter) };
const groups  = taxonomy.facetControls('ecosystem', all, state);  // [{ key, label, options }]
const letters = taxonomy.alphaControls('ecosystem', all, state);  // [] below the threshold
```

- Each facet is counted over the set narrowed by every *other* filter, so its options stay switchable.
- Values come from the data, not the declared `options`. A single-valued facet hides unless it is active.
- Every control is `{ value, label, count, href, active }` with every other axis carried in `href`. The reset control leads the row, flagged `reset`.
- `alphaControls` is `[]` below `needsAlphaIndex` (40 pages unless `alphaIndexMinPages`); `resolveLetter` drops a letter no page starts with.
- `metadataRows` returns a page's populated keys as rows with `href` on the facet ones; `rankRelated` ranks by shared facet values and returns the shared axis for the *See also* heading.

## Headings

`wiki-formant/headings`: heading ids, permalink anchors, and the list an "on this page" rail renders.

```ts
import { articleHtml, headingsFrom } from 'wiki-formant/headings';

const used = new Set([slug(page.title)]);
const blocks = page.blocks.map(b => ({ ...b, text: articleHtml(b.text, { used, links: { selfHost: 'radix.wiki' } }) }));
const toc = headingsFrom(blocks.map(b => b.text).join(''));   // [{ id, text, level }]
```

- `injectHeadingIds` is idempotent; `slug` is a parameter, since a heading id is a published URL.
- Pass one `used` set across a page's blocks, seeded with ids the template renders, or a repeated heading mints a duplicate id.
- `articleHtml` is the render-path chain: heading ids, `scrollTables`, and with `links` the link pass: an internal link loses `target` and `rel`, an external one gets them, and a bare-URL anchor gets readable text.

## MCP

`wiki-formant/mcp`: a [Model Context Protocol](https://modelcontextprotocol.io) server over Streamable HTTP.

```ts
import { mcpResponse, mcpGet, mcpOptions, McpToolError } from 'wiki-formant/mcp';
import { MCP_RATE_LIMIT } from 'wiki-formant/rate-limit';

const config = {
  serverInfo: { name: 'my-wiki', version: '1.4.0' },
  instructions: 'Call search_pages first; get_page needs a full path.',
  docsUrl: 'https://example.com/llms.txt',
  tools: [{
    name: 'search_pages',
    description: 'Full-text search across the wiki.',
    inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'query' } }, required: ['q'] },
    annotations: { readOnlyHint: true },
    handler: async ({ q }) => search(String(q)),
  }],
  rateLimit: MCP_RATE_LIMIT,
  onCall: (req, body) => track(req, body),
};

export const POST = (req: Request) => mcpResponse(req, config);
export const GET  = () => mcpGet(config.docsUrl);
export const OPTIONS = () => mcpOptions();
```

- A caller-fixable mistake is a tool result with `isError`, never `-32603`: bad arguments name every bad field, quote legal values and append the schema. Throw `McpToolError(message, details)` from a handler for the same.
- Capabilities, and the `-32601` method list, advertise only what the config populates.
- A notification-only POST is a bare `202`; malformed JSON is `-32700` with a `400`; `GET` is an explicit 405 with CORS; the preflight allow-list and `Access-Control-Expose-Headers` cover what MCP clients send and read.
- Batches are capped (`DEFAULT_MAX_BATCH`, 20) and refused from 2025-06-18 on.
- Both protocol eras on one endpoint: a request with `io.modelcontextprotocol/protocolVersion` in `params._meta` is served as `2026-07-28` (`server/discover`, per-request version checks, `resultType` and cache hints); everything else is the legacy era, which echoes a supported client version. Every response carries `MCP-Protocol-Version`.
- The A2A call an agent card invites (`message/send`, `SendMessage`) is answered from the tool `answer` names.
- `rateLimit: { capacity, refillPerSec }` is enforced before the body is parsed, with `RateLimit-*` headers on every answer; `mcpRateLimited(sec)` is the JSON-RPC 429.
- Every object a handler returns comes back as `structuredContent` beside the text; `outputSchema` is the stronger contract when declared. `inputSchema.requireOneOf` names a set of which one must be present.
- A handler's second argument is its context: `ctx.meta` (the request's `params._meta`) and `ctx.setMeta(key, value)` (onto `result._meta`). `config.gate` is envelope-level middleware, for a payment gate whose demand replaces the call.
- `readArgs` reads raw arguments as typed, clamped values and records every override; `withAdjustments` puts them on the result as `adjustments`.
- `feedbackTool(record, noun)` is `send_feedback`. Listed, `initialize` appends `FEEDBACK_INVITE` and an empty `listEnvelope` page or an `McpToolError` carries a one-line pointer to it.

## Conformance

`wiki-formant/conformance`: the half of an MCP conformance run that is not about one server's tools. Every value it compares against is imported from `wiki-formant/mcp`.

```ts
import { createTester, standardSuite, wikiReadChecks } from 'wiki-formant/conformance';

const t = createTester({ base: 'https://example.com', clientName: 'my-mcp-test' });
const init = await standardSuite(t, {
  version: serverManifest.version,
  openapi: ['/openapi.json', '/.well-known/openapi.json'],
  writes: ['create_page', 'send_feedback'],
  manifest: { writeAuth: true },
  budget: [{ name: 'search_wiki', args: { query: 'x' } }, { name: 'get_full_corpus', maxBytes: 260_000 }],
  conditionalGet: ['llms.txt'],
  robots: ['/api/mcp', '/llms.txt', '/.well-known/agent-card.json'],
});
const { first } = await wikiReadChecks(t, { query: 'radix', address: r => ({ tagPath: r.tagPath, slug: r.slug }), twin: r => `${r.path}.md` });
process.exit(t.summary());
```

`standardSuite(t, cfg)` runs the suites every surface runs, in order: `transportChecks` (CORS preflight, `GET`→405, 202 for a notification, `-32700`, the batch cap, honest capabilities, version negotiation), `versionCoherence` over `standardVersionSources`, `agentCardParity`, `annotationChecks`, `manifestParity`, `payloadBudget`, `conditionalGetChecks`, `descriptorChecks` (default `S10_DESCRIPTORS`) and `robotsChecks`. `budget`, `conditionalGet` and `robots` run only when given, for a surface whose fixtures exist only later in its run. It returns the `initialize` response. Each suite is exported for a surface that needs it alone.

`wikiReadChecks(t, opts)` checks the `wiki-tools` read tools: categories, a search and the page it finds (by `address`, default `{ path }`), its twin (given `twin`), a listing, recent changes, a corpus preflight and a slice that is cut and resumes when the corpus exceeds `corpusChars`, and the teaching answers to no hits, a missing argument, an unknown tool and a missing page. `endpoint` and `label` run it against a second server. It returns `{ rows, first, page }`.

- `payloadBudget` weighs every listed call and every read-only tool with no required arguments, and asserts a JSON answer carries `structuredContent`.
- `conditionalGetChecks` wants a 304 on `If-None-Match` (alone and in a list) and a `Last-Modified`; `descriptorChecks` wants an ETag and a `max-age` on a JSON descriptor.
- `t.rpcAt(endpoint, …)` and `t.callAt` drive another endpoint with the same backoff, User-Agent and tally.

The drift checks hold a server to what its own site does:

- `manifestParity(t, { writeAuth? })`: `/.well-known/mcp.json` is `tools/list`, names the endpoint, and states write auth only beside a write tool.
- `rowParity(t, label, mcp, rest)`: a tool's rows and the GET API's are identical and not empty.
- `twinParity(t, label, twinUrl, text)`: a tool's text is the page's markdown twin, past frontmatter and title.
- `editReadChecks(t, { path, rows?, validate?, endpoint?, label? })`: rows carry ids, `get_page` with `blocks: true` returns blocks the site's `validate` accepts, and the history's newest revision is that version.
- `roundTrip(t, label, { read, write })`: a write takes its read back unchanged.
- `openapiWriteParity(t, [[path, method, tool], …], specUrl?)`: every field an OpenAPI write documents, the tool takes.
- `rolaOriginCheck(t)`: the ROLA recipe names the origin under test.
- `freshAfterWriteChecks(t, urls, write, { shows?, gone? })`: each URL shows the write within five seconds. Run it against a deployment, since with no CDN it passes trivially.

## Markdown twins

`wiki-formant/markdown`: `htmlToMarkdown` keeps the structure an agent cites by (headings, lists, tables, code, emphasis); `markdownDocument` adds the frontmatter.

```ts
import { htmlToMarkdown, markdownDocument } from 'wiki-formant/markdown';
import { markdownHeaders, cacheTagHeaders, VARY_ACCEPT } from 'wiki-formant/http';

return notModified(request, etag, lastModified) ?? new Response(
  markdownDocument(
    { title: page.title, url, updated: page.updatedAt, lastVerified: page.lastVerifiedAt, license },
    blocksToMarkdown(page.content),
  ),
  { headers: markdownHeaders(lastModified, { etag, noindex: true, extra: { ...VARY_ACCEPT, ...cacheTagHeaders(pageTag(path)) } }) },
);
```

- Tables convert first, ordered lists number per list, cell pipes are escaped, and a headerless table gets a header.
- `noindex` is for a twin of an HTML page; a document with no HTML page (AGENTS.md) leaves it off.
- `cacheTagHeaders(tags)` with the tags the save path revalidates, or the CDN holds a route handler's twin past every save. The same goes for `llms.txt`, a search index and a sitemap.
- Next drops a rewrite destination's query string, so a twin rewrite carries the `.md` extension through to its destination.

## Conditional GET and route errors

`wiki-formant/http`: validators, the headers of every text surface, and the answers a route gives when it is not answering with data.

```ts
import { corpusValidatorsFrom, corpusRoute, errors, handleRoute, HttpError } from 'wiki-formant/http';

export const GET = corpusRoute(async () => {
  const agg = await prisma.page.aggregate({ _count: true, _max: { updatedAt: true } });
  return corpusValidatorsFrom([agg._count], [agg._max.updatedAt]);
}, buildCorpus);

export const POST = (req: Request) => handleRoute(async () => {
  const q = new URL(req.url).searchParams.get('q');
  if (!q) return errors.badRequest('q is required');
  if (q.length > 200) throw new HttpError(400, 'q is too long', { code: 'INVALID_PARAMS' });
  return Response.json(await search(q));
}, 'Search failed');
```

- `corpusEtag`, `notModified` and `textHeaders` are the parts; `corpusRoute` skips the build on a 304.
- A URL answering JSON or markdown by `Accept` asks `wantsMarkdown(request)` and sends `VARY_ACCEPT` on both branches.
- `descriptorResponse` serves a JSON descriptor with its own ETag and `Access-Control-Allow-Origin: *` (`descriptorHandler` in `wiki-formant/well-known` is the route).
- Every error body is `{ error, ...extra }`. A thrown `HttpError` answers with its status; anything else is logged and answered with a 500 carrying only the handler's message (`'Search failed'`), so no exception text reaches a caller. `errors.tooManyRequests(sec)` states `Retry-After`.

## Response headers and the Next config

`wiki-formant/headers`: the headers every route sends, the shared CSP, and the Next config defaults. It imports nothing, so `next.config.ts` pays for nothing it does not use.

```ts
import type { NextConfig } from 'next';
import { contentSecurityPolicy, withWikiDefaults } from 'wiki-formant/headers';

const csp = contentSecurityPolicy({ 'connect-src': ["'self'", 'https://*.radixdlt.com'] });
export default withWikiDefaults({ async redirects() { /* … */ } } satisfies NextConfig, { csp });
```

`withWikiDefaults(config, { csp })` adds:

- `securityHeaders` on every route, `csp` enforced in production only (Next's dev runtime is inline and `eval`); an origin with a per-request nonce passes none.
- `/openapi.json` rewritten to `/.well-known/openapi.json` first in `beforeFiles`, merged with the app's own `rewrites()` in either form.
- AVIF before WebP, `turbopackFileSystemCacheForBuild: false` (Vercel restores a stale build cache), and `distDir` from `STUDIO_DIST_DIR` for radix-studio's second dev server.

What the app sets wins, and its `headers()` follow these. `contentSecurityPolicy` starts from the shared base and each directive passed replaces its default; an empty list drops one. The default `frame-src` is `DEFAULT_IFRAME_HOSTS`, the sanitiser's default `iframeHosts`, so an embed that clears one clears the other; a site with its own hosts passes the same list to both.

## Pagination, versioning and rate limits

```ts
import { parsePagination, paginatedResponse, listEnvelope } from 'wiki-formant/pagination';
import { bump, parseVersion } from 'wiki-formant/versioning';
import { limitClient, rateLimitedResponse } from 'wiki-formant/rate-limit';

const { page, pageSize } = parsePagination(searchParams);            // page ≥ 1, pageSize 1–100
return Response.json(paginatedResponse(items, total, page, pageSize)); // always carries totalPages

bump(page.version, 'minor');                                           // tolerant of null or junk

const limit = limitClient('search', request.headers, { capacity: 30, refillPerSec: 0.5 });
if (!limit.ok) return rateLimitedResponse(limit.retryAfterSec);
```

- `listEnvelope` is the shape every list tool answers with, its `note` on an empty page.
- `rateLimit` is an in-memory token bucket; `blockMs` blocks an abusive key outright across every bucket naming it. `clientIp` reads `x-real-ip` first, then the leftmost `x-forwarded-for`. `MCP_RATE_LIMIT` is the MCP servers' budget.

## React

`wiki-formant/react` carries `'use client'`. What is shared is behaviour; class names and icons are passed in.

```tsx
import { LinkPreviewCard, SidebarProvider, RailShell, TableOfContents, useLinkPreview } from 'wiki-formant/react';

function LinkPreview() {
  const { preview, cardProps } = useLinkPreview<Preview>({ eligible, fetch: fetchPreview, cardHeight: 200 });
  return preview && <LinkPreviewCard {...cardProps} title={preview.title} excerpt={preview.excerpt} bannerImage={preview.bannerImage} />;
}
```

- `SidebarProvider` / `useSidebar` hold the rail's collapse state, remembered across loads and defaulted from the viewport only when the reader never chose. Pair it with `sidebarBootScript` (`wiki-formant/sidebar`) in `<head>`, or a remembered-closed rail paints open first.
- `RailShell` renders the rail's landmark, scroll wrapper and collapse states, and closes a mobile drawer on a followed link; mark the active link with `isRailLinkActive`. With `RailShell prefix="wiki-sidebar"` in a `.wiki-layout` beside `.wiki-layout__main`, `base.css` lays it out: a sticky column from 1024px, a drawer above the article below it. The site supplies `--rail-top`, `--rail-border` and the surface.
- The breakpoint is known twice, in `matchMedia` and in CSS. `base.css` sets `--rail-floating: 1` inside its media query and the hook warns in development when the two disagree; a rail laid out by its own CSS sets the property the same way. `railBreakpointMismatch` and `readRailFloating` (`wiki-formant/sidebar`) are the mechanism.
- `TableOfContents` is the "on this page" list with scroll-spy.
- `useLinkPreview` is the hover card: one delegated listener, an intent delay, a grace period into the card, viewport clamping and a per-href cache. `LinkPreviewCard` is its markup (`link-preview-card`, `-banner`, `-body`, `-title`, `-excerpt`); a caller that must move the card passes its own `style`.
- `useTypeahead` is the search field's state machine: a request-id guard, keyboard navigation, abort and a per-mount cache. `fetch` must be referentially stable. Its `combobox(listKey)` hands out `inputProps`, `listProps` and `optionProps(i)`, with `aria-activedescendant` omitted rather than emptied; `listKey` keeps two rendered lists' ids apart. The arithmetic is `wiki-formant/combobox`, which imports nothing.
- `useSnapRow` is a carousel as a scroll-snapped row: `step`, `go(i)` and `at`, no markup.
- `useClickOutside` ignores a container hidden at the current breakpoint (`offsetParent`).
- `useUnsavedChanges(dirty)` asks before leaving and returns `confirmLeave()` for a client-side navigation; `useSaveShortcut(save)` binds ⌘S / Ctrl+S; `useSearchShortcut(open)` is "/" to search, with `focusShown(input)`.
- `SortHeader` renders `useTableSort`'s `headerProps(key)` as a `<th aria-sort>` holding a `<button>`, the markup `sortTables` writes.
- `useBlockOperations(blocks, setBlocks, { duplicate })` and `BlockActions` are a block list's five edits and their buttons; `useRevisionRestore(restore, { onRestored })` confirms and restores, `restoreViaPost(endpoint)` being the usual `restore`.
- `useArticlePasses(ref, [blocks])` runs `wiki-formant/dom`'s passes and `renderMath` (KaTeX, an optional peer, loaded only when a page has `$$…$$`, `\[…\]` or `\(…\)`).
- `<Beacon />` sends page views and outbound clicks to `wiki-formant/analytics`.

`useClickOutside`, `useSnapRow` and the editor hooks ship no class names.

## Server components

`wiki-formant/react-server`: the same React without the directive, for parts that are pure functions of their props. Each takes the router's link component, since a bare `<a>` turns every press into a full load.

```tsx
import Link from 'next/link';
import { Breadcrumbs, FacetBar, FacetSummary, InfoboxFacts, JsonLd, Pager } from 'wiki-formant/react-server';

<Breadcrumbs link={Link} items={tree.crumbs(path)} base={SITE_URL} />
<FacetBar link={Link} facets={groups} letters={letters} alphaFirst />
<Pager href={p => `?page=${p}`} page={page} total={totalPages} noun="Page" />
```

- `FacetBar` renders `facetControls` and `alphaControls`; `letterRow`, `letterControl`, `text` and `letterCounts="title"` separate the A–Z row and let a label truncate while its count stays.
- `Breadcrumbs` renders the trail and its `BreadcrumbList` JSON-LD together; `base` makes the URLs absolute.
- `JsonLd` escapes every `<`, so an authored `</script>` cannot close the tag.
- `Pager` steps by links (`href`) or buttons (`onPage`, `wrap`); a step with nowhere to go stays in place, inert. `SnapDots` are a snap row's dots.
- `FacetSummary` is the count and Clear line under the facets; `RelatedPages` the see-also aside; `InfoboxAside` the facts landmark with its series line; `InfoboxFacts` renders `metadataRows` with `formatFactValue` as its default cell.
- `RevisionChanges` renders `withChanges` rows; `MaintenanceQueues` renders `maintenanceQueues`; `Cite` is an article's citation in a `<details>`.

## Block trees

`wiki-formant/blocks`: the two core containers (`columns[i].blocks`, an infobox's `blocks`), the walks over them, and the core leaves' text, markdown and defaults.

```ts
import { coreBlockShape, mapBlockTree, coreAtomicToMarkdown, coreBlockDefaults } from 'wiki-formant/blocks';

export const BLOCK_SHAPE = coreBlockShape<Block>();
mapBlockTree(blocks, processLeaf, BLOCK_SHAPE);

switch (block.type) {
  case 'content': case 'codeTabs': case 'banner': case 'references':
  case 'stats': case 'linkGrid': case 'recentPages': case 'pageList':
    return coreAtomicToMarkdown(block, { siteUrl: SITE_URL, referencesTitle: 'Sources' });
  case 'corpusStats':
    return block.resolvedHtml ? htmlToMarkdown(block.resolvedHtml) : '';
}
```

- The dispatch over a repo's own union stays in that repo, so a new type is a compile error there; the core bodies come from here (`coreAtomicText`, `coreAtomicToMarkdown`, `coreBlockDefaults`).
- The core leaves are `content`, `codeTabs`, `banner`, `references`, `stats`, `linkGrid`, `testimonial`, `events`, `locations`, `recentPages`, `pageList` and `list`. `CoreLeafBlock` is their union (less the list and containers) and `CoreLeafType` its types; a wiki's atomic union is `CoreLeafBlock | ListBlock | its native types`, and a leaf added here fails to compile in every wiki until wired.
- `coreAtomicToMarkdown` makes a resolved page's `href` absolute with `siteUrl`, since a twin is read off-site.
- A `codeTabs` tab's `code` is source text: escaped by its view, fenced verbatim by the twin. Pass `highlighted` to the view for server-highlighted markup. `CODE_LANGS` and `DEFAULT_LANG` are the language list.
- `recentPages`, `pageList` and `list` resolve to `ResolvedPageRef`s built with `pageRef(page, now)`.
- `ListBlock` is the pages under a section (`source: 'under'`), the newest (`'newest'`, `count`) or chosen ones (`'chosen'`, `pages`), shown as links or cards.
- An `events` item is `{ id, date, end?, text }`, dated to the year, month or day (`EVENT_DATE`); `splitEvents`, `eventWhen`, `eventBegun` and `eventEnded` split upcoming from past by a `day`, which the browser re-splits by the visitor's own.
- A `testimonial` is `{ quote, author, role?, avatarUrl? }`. A `locations` item carries an address, `hours` rows of `{ days, opens, closes }` and a `timeZone`.

## Validation

`wiki-formant/validation`: the block model in one declaration, and the checks under it.

```ts
import { defineBlocks, describeBlockIssues } from 'wiki-formant/validation';
import { coreBlockDefaults } from 'wiki-formant/blocks';

const model = defineBlocks<Block>({
  defaults: { ...coreBlockDefaults(), corpusStats: () => ({ type: 'corpusStats', view: 'sourceTiers' }) },
  checks: { corpusStats: b => isCorpusView(b.view), list: (b, core) => core(b) && isSection(b.under) },
});
export const { shape: BLOCK_SHAPE, createBlock, duplicateBlock, validateBlocks, blockIssues } = model;

const issues = blockIssues(body.content);
if (issues.length) return errors.badRequest(`Invalid content: ${describeBlockIssues(issues)}`);
// Invalid content: [2].columns[0].blocks[1]: malformed linkGrid block
```

- A check for a core type narrows the package's (`core` is passed in). `coreAtomicValidator` and `createBlockValidator` are the parts.
- `MAX_BLOCK_ROWS` caps `recentPages.limit` and `pageIds`, since both end in a database `take:`; `blockLimit` is the read side.
- `safeLinkHref` and `okUrl` are the link checks the views rely on.

## Block views

`wiki-formant/block-views`: the views of the core leaves, as client components that render server-side.

```tsx
import { CodeTabsView, ColumnsView, LinkGridView, PageRefsView, StatsView, EventsView, LocationsView, BannerView } from 'wiki-formant/block-views';

case 'codeTabs': return <CodeTabsView tabs={block.tabs} />;
case 'columns':  return <ColumnsView columns={block.columns} gap={block.gap} render={renderBlock} />;
case 'pageList': return <PageRefsView refs={block.items} link={Link} renderItem={row} />;
```

- `ColumnsView` states its gap and alignment as data attributes and an inactive code tab is `hidden`, so no view needs Tailwind to scan the package.
- `TestimonialView` is `figure.testimonial`; pass `photo` for sized images.
- `EventsView` sets upcoming soonest first and past latest first, with "Now on" beside one begun; `day` fills the server's split.
- `LocationsView` draws each place's address, week (`PlaceHours`), note and map; the browser adds whether it is open by the place's clock, once a minute. `wiki-formant/hours` holds those rules (`hoursRows`, `openState`, `clock`, `hoursLd`, `mapHref`, `mapEmbed`) for a twin or structured data; a closing time at or before the opening one is the next morning, and `DEFAULT_ZONE` is `Europe/London`.
- `BannerView` shows `BANNER_MESSAGES` (`wiki-formant/text`) unless `message` overrides it.

## Text

`wiki-formant/text`: a block tree as plain prose, for an LLM export or a description.

```ts
import { openingText, plainText, stripHtml } from 'wiki-formant/text';
import { describe } from 'wiki-formant/metadata';

const description = describe(page.metadata?.excerpt || openingText(page.content));
```

`openingText` is the first top-level `content` block with prose once headings are out, so a page opening on an infobox is not described by its table. `matchSnippet` is a search hit's line.

## Page metadata

`wiki-formant/metadata`: a page's canonical, markdown alternate, Open Graph and Twitter card from one input, and the schema.org nodes beside them.

```ts
export const generateMetadata = () => ({
  title,
  ...pageMetadata({ title, description, url, type: 'article', image: ogImageUrl(title), siteName, handle, markdownTwin: true }),
});
<JsonLd data={articleLd({ headline: title, url, image, published, modified, publisher: SITE.publisher, citation: citationsFromReferences(refs) })} />
```

- Next replaces `openGraph` and `twitter` per segment rather than merging, so `pageMetadata` sets both; `sitePageMetadata({ siteName, handle })` binds the fields every page's card needs.
- `articleLd` requires `image`. `collectionLd` is an index over an `ItemList`. `siteGraphLd` is the Organization, WebSite and `WebAPI` `@graph` for the root layout, and `siteRefs(url)` hands out the same `@id`s for a page's `publisher` and `isPartOf`.
- `questionPairs(html)` reads a FAQ from headings ending in `?`; `faqPageLd(pairs, url)` is null under two pairs.
- `describe(text)` is a meta description from any prose within `DESCRIPTION_LIMIT` (160): whole sentences where they fill half, else cut at a word with an ellipsis.

## Social cards

`wiki-formant/og`: the `/og` card, as the element `next/og`'s `ImageResponse` takes.

```tsx
import { SocialCard, bannerField, bubbles, cardRandom, OG_SIZE, OG_HEADERS } from 'wiki-formant/og';

const field = (await bannerField(searchParams.get('banner'), /\.public\.blob\.vercel-storage\.com$/))
  ?? bubbles(cardRandom(title), { field: [BG, NAVY], colors: [GREEN, ORANGE] });
return new ImageResponse(<SocialCard {...{ title, eyebrow, description }} {...field} mark="example.org" colors={colors} fontFamily="Inter" />, { ...OG_SIZE, headers: OG_HEADERS, fonts });
```

- A page's banner is its card; the generated field is for a page without one. `bannerField` fetches only from the hosts named, crops, inlines PNG and turns the scrim on, or returns null. It loads `sharp`.
- Fonts stay with the site: Next traces a font file only from a literal path in the app, and satori reads TTF or OTF.
- `wiki-formant/seeded`'s `hashStr` and `seededRandom` are the deterministic randomness the art draws from, identical on server and browser.

## Revisions and history

`wiki-formant/revisions`: what changed between two versions of a page, and which bump to ask for. `wiki-formant/history`: what each revision changed, as a history view shows it.

```tsx
import { computeRevisionDiff } from 'wiki-formant/revisions';
import { withChanges } from 'wiki-formant/history';

const diff = computeRevisionDiff({ currentVersion: page.version, oldContent, newContent, oldTitle, newTitle });
const rows = withChanges(revisionsNewestFirst);   // each row needs its `content`; it leaves without it
<RevisionChanges changes={rows[0].changes} label={type => BLOCK_LABELS[type]} />
```

- Blocks match by id, so a moved block is one `moved`. Container keys are walked as their own entries, never diffed as attributes. A path like `root.1.columns.0.blocks.2` is part of the contract; pass `containers` beyond the core two.
- `withChanges` diffs on the server, by words, leaves only. The oldest row is diffed against an empty page, so fetch one more than you show.

## Feeds and sitemaps

```ts
import { feedResponse } from 'wiki-formant/feed';
import { treeSitemap, tagPrefixes } from 'wiki-formant/sitemap';

export const GET = async (request: Request) => feedResponse(request, channel, await items());

...treeSitemap(pages, {
  sections: tagPrefixes(pages.map(p => p.tagPath)),
  sectionRow: path => ({ url: `${SITE_URL}/wiki/${path}`, changeFrequency: 'weekly', priority: 0.6 }),
  pageRow: p => ({ url: pageUrl(p), changeFrequency: 'weekly', priority: 0.7 }),
}),
```

- `feedResponse` answers a conditional GET; `lastBuildDate` is the newest item's date, and an empty feed carries none.
- A section is dated by the newest page at or beneath it, or not at all. Every URL appears once: an empty-slug page dates its section and gets no row.

## Licences and the X account

```ts
import { ccBy40, licenseBlock, openApiLicense } from 'wiki-formant/license';
import { xAccount, followLines, followNote, followLinkProps } from 'wiki-formant/social';

const license = ccBy40({ siteName: 'AcuiQ', siteUrl: SITE_URL });
const block = licenseBlock({ license, scope: 'The protocol compilation and prose', excludes });
export const X = xAccount({ siteName: 'AcuiQ', handle: '@acu_iq', posts: "a named trial's prescription with its citation" });
```

- One `License` goes to `licenseBlock`, `agentCard({ license, licenseScope })` and `openApiLicense` for `info.license`.
- `X.url` is the `sameAs`, `X.handle` the card's, `followLines(X)` goes into llms.txt and AGENTS.md, `followNote(X)` into the MCP instructions, and `<a {...followLinkProps(X)}>` is the footer link with `rel="me"`.

## Agent descriptors

`wiki-formant/well-known`: the A2A agent card, the MCP manifest and server card, and the registry's domain proof.

```ts
import { agentCard, mcpManifest, skillsFromTools, wellKnownHandler, serverCardHandler } from 'wiki-formant/well-known';

const AGENT_CARD = agentCard({ name, description, url: `${SITE_URL}/api/mcp`, version, skills: skillsFromTools(TOOLS), license });
// src/app/.well-known/[doc]/route.ts
export const GET = wellKnownHandler({ agentCard: AGENT_CARD, mcpManifest: mcpManifest({ … }), openapi: SPEC });
```

The card is served identically at `agent-card.json` and `agent.json`, and its `url` is the MCP endpoint, which answers A2A. `registryAuthHandler` serves `MCP_REGISTRY_PUBLIC_KEY` at `/.well-known/mcp-registry-auth`, 404 when unset.

## AI crawlers

`wiki-formant/crawlers`: one roster of AI crawlers, for the proxy that counts them and the robots.txt that addresses them.

```ts
import { trackAiBot, crawlerRules } from 'wiki-formant/crawlers';

trackAiBot(request, event, () => import('@/lib/track'));   // in proxy.ts
const rules = crawlerRules({ allow: '/', disallow, aiAllow });
```

- Every agent group allows `AGENT_SURFACE_PATHS` (`/api/mcp`, `/llms.txt`, `/openapi.json`, `/.well-known/`); `aiAllow` adds the origin's own.
- Search engines get the HTML site and no twins (`/*.md$`, plus `searchDisallow`). The `?_rsc=` prefetch payload is refused in every group.
- `trackAiBot` counts a rostered crawler anywhere, and anything but a search engine asking for what only agents read. `load` is a dynamic import so the proxy does not load a database client.

## Rendered-article passes

`wiki-formant/dom`: what runs against an article element once it is in the document.

```ts
import { addCopyButtons, sortTables, activateTabGroups, hydrateTweetEmbeds, onTweetResize, sizeTweetEmbed } from 'wiki-formant/dom';

addCopyButtons(el);
sortTables(el);
activateTabGroups(el);
hydrateTweetEmbeds(el);
const off = onTweetResize((h, source) => sizeTweetEmbed(el, h, source));
```

- Each pass is idempotent.
- `sortTables` sorts a column as dates, numbers or text (one stray value makes it text), restores the author's order on a third press, and leaves label/value and merged-cell tables alone.
- `activateTabGroups` makes stored `[data-tabs]` markup a working tab group; without script every tab shows in order.
- `onTweetResize` believes only the embed host and hands over the posting window, so `sizeTweetEmbed` sizes that iframe alone.
- `scrollTables(html)` (`wiki-formant/headings`) wraps each table in a `.table-scroll` box on the string, before layout.
- `track(name, props)` sends a browser event to the analytics beacon.

## Search

`wiki-formant/search`: what a literal tier and a full-text tier must agree on: `proseSql`, `HEADLINE_OPTIONS`, `FTS_RANK_NORMALIZATION`, and `searchTsvDdl(table)`, the statements that drop and re-add the generated `search_tsv` column and its index in one transaction. `fullTextQuery` is a query as the full-text tier reads it, a hyphen or underscore inside a word a space; `correctQuery(query, vocabulary)` corrects a query's misspelt words against a site's own, which the store's `search` retries with when its first page is empty, returning the query that found the rows as `corrected`.

```ts
const { column, index } = searchTsvDdl('"WikiPage"');
```

## Dates, freshness and the maintenance queues

`wiki-formant/freshness` and `wiki-formant/queues`.

```ts
import { relativeTime, formatDay, freshnessBanner } from 'wiki-formant/freshness';
import { maintenanceQueues } from 'wiki-formant/queues';

relativeTime(then, now, { style: 'short' });        // '3h ago'; `now` is always passed in
formatDay(day, { locale: 'en-GB', month: 'long' }); // '19 September 2026', always UTC
const banner = freshnessBanner(page, Date.now(), { against: 'current sources and the live ledger' });
const queues = maintenanceQueues(pages, { href, required, nowMs, verify, listedIds });
```

- `freshnessBanner` is the `outdated` banner once a page goes unchecked for `maxAgeDays` (180), or null.
- `maintenanceQueues` returns the outdated, orphaned, unsourced and missing-facts queues, empty ones dropped. Pass every page but the home page and the back office. `MaintenanceQueues` draws them on a `noindex` page.
- `citation({ publisher, title, date, url })` (`wiki-formant/react-server`) is the line `Cite` shows.

## Sanitising stored HTML

`wiki-formant/sanitize`: the allowlist between saved HTML and a reader's browser. Run it server-side on the render path.

```ts
import { createHtmlSanitizer, sanitizeCoreLeaf } from 'wiki-formant/sanitize';

const clean = createHtmlSanitizer({ iframeHosts: FRAME_HOSTS });   // the same hosts in the CSP's frame-src
const safe = mapBlockTree(blocks, b => sanitizeCoreLeaf(b, clean), BLOCK_SHAPE);
```

- The default list is what `wiki-formant/tiptap`'s nodes store plus a presentational SVG subset. Extend `tags`, `attributes`, `classes` and `schemesByTag` from your stored HTML, never from memory.
- A YouTube iframe comes out as the `YouTube` node's markup, whoever wrote it, and `base.css` draws it as a 16:9 player.
- Classes pass by name only, since a site's own utilities can draw over the chrome.
- `sanitizeLine(html, { links })` cleans what a `WikiLine` stores: its marks and `wikiTextStyle`'s spans. `sanitizeCoreLeaf` runs it over the core leaves' one-line fields (a figure, a quote and who said it, the events' and places' headings, a place's name), which `block-views` draws as HTML.

## Image uploads

`wiki-formant/upload`: the route an editor's image upload posts to.

```ts
// src/app/api/upload/route.ts
export const runtime = 'nodejs';
export const POST = uploadHandler({
  authorize: async () => (await currentUser())?.id ?? errors.unauthorized('Sign in to upload.'),
  prefix: 'wiki/',
});
```

- The file's own bytes say what it is; SVG is refused. Every image is re-encoded upright, so no source metadata (GPS included) is kept. Defaults: 4 MB, 40 megapixels.
- Each uploader has a budget on `authorize`'s id and address, and each address its own.
- `encode`, `maxBytes`, `maxPixels`, `rateLimit` and `store` (Vercel Blob by default) are options. `normalizeImage(bytes, opts)` is the sniff, cap and re-encode without the route.

## Maps

`wiki-formant/maps`: a pasted Google or Apple Maps URL as one an `<iframe>` accepts.

```ts
import { toMapEmbedUrl, resolveMapHandler } from 'wiki-formant/maps';

toMapEmbedUrl('https://maps.apple.com/?ll=51.5,-0.12');
export const GET = resolveMapHandler({ authorize: async () => !!(await currentUser()) });   // /api/resolve-map
```

A short link resolves through the wiki's own route (`resolveMapUrl` is the client half): exact shortener hosts, one hop, an allowlisted landing host, a timeout and your sign-in check.

## Editor nodes

`wiki-formant/tiptap`: the custom nodes: `Iframe`, `YouTube` (with its paste rule), `TwitterEmbed`, `createMapEmbed`, `createCodeBlock`, `createTabs` and `createHeadingIds`.

```ts
import { embedNodes, createCodeBlock, createTabs, createHeadingIds } from 'wiki-formant/tiptap';

const { TabGroup, TabItem } = createTabs();
const nodes = [...embedNodes({ resolveMapUrl }), createCodeBlock({ classNames, icons }), TabGroup, TabItem, createHeadingIds({ slug })];
```

- `embedNodes` turns a pasted YouTube, X or map link into its player. `Iframe` and the map node draw only an https src on `DEFAULT_IFRAME_HOSTS` (`embedSrc`), since the editor draws stored HTML where its author is signed in.
- The node views draw in default classes `base.css` styles; `classNames` and `icons` replace them.
- `createTabs` returns both nodes, since one is unsatisfiable without the other. A short map link inserts at once and swaps its `src` when it resolves.
- `createHeadingIds` gives each heading the id its published copy will carry.

## Editor

`wiki-formant/editor`: the rich-text editor's engine, minus its chrome.

```tsx
import { useWikiEditor, useUrlPrompt, WikiToolbar, UrlPromptField, WikiLine, uploadImageTo } from 'wiki-formant/editor';

const url = useUrlPrompt(editor, { resolveMapUrl });
<WikiToolbar editor={editor} prompt={url} onUpload={triggerUpload}
  icons={{ ...ICONS, unlink: <Unlink />, upload: <Upload />, embed: <Globe /> }}
  classNames={{ toolbar: 'toolbar', button: 'toolbar-btn', pressed: 'toolbar-btn-on', divider: 'toolbar-divider' }} />
<UrlPromptField prompt={url} classNames={{ row: 'row', input: 'input', apply: 'btn', cancel: 'btn-quiet' }} />
<WikiLine as="h1" value={title} onChange={setTitle} placeholder="The page's title" />
```

- `WikiToolbar` shows each command the editor's extensions support (`supports`) and nothing else, in fixed groups, with the table controls while the cursor is in a table.
- `useUrlPrompt` is the link and embed field: it opens on the current link, unlinks on an emptied one, and closes when its editor changes.
- `WikiLine` is a one-line field with its own `marks`, undo and `onFocus`, so one toolbar can drive the field last touched. Its `style` mark is `wikiTextStyle`: a font, colour and size on a run of words, which an article editor takes through `nodes` and an app's own controls set with `setTextStyle`.
- A link is stored as its `href` and the `link` class only; whether it is external is decided at render by `articleHtml`'s `links` pass. `uploadImageTo('/api/upload')` is the `uploadImage` an editor passes.

## Block editor

`wiki-formant/block-editor`: the block list an author edits and the fields of the core types. The look arrives as a kit.

```tsx
const KIT: BlockEditorKit = {
  classNames: { action: 'icon-btn', input: 'input', row: 'row', stack: 'stack-sm' },
  icons: { add: <Plus />, up: <ChevronUp />, down: <ChevronDown />, duplicate: <Copy />, remove: <Trash2 /> },
};
const SCHEMA: BlockSchema<Block> = {
  meta: type => BLOCK_META[type], create: createBlock, duplicate: duplicateBlock,
  types: PAGE_TYPES, nestedTypes: ATOMIC_TYPES, single: ['infobox'],
  renderBody: (block, onUpdate) => {
    switch (block.type) {
      case 'codeTabs': return <CodeTabsFields block={block} onUpdate={onUpdate} />;
      case 'columns': return <ColumnsFields block={block} onUpdate={onUpdate} />;
      case 'daoTimeline': return <DaoTimelineEdit block={block} onUpdate={onUpdate} />;
    }
  },
};
<BlockEditor blocks={blocks} onChange={setBlocks} schema={SCHEMA} kit={KIT} />
```

- Each block is a card with a toolbar (name, add below, move, duplicate, delete); an add menu of more than eight types opens on a filter box. An option's `group` heads it.
- The core fields are `CodeTabsFields`, `StatsFields`, `TestimonialFields`, `EventsFields`, `LocationsFields`, `ReferencesFields`, `LinkGridFields`, `BannerFields`, `PageListFields`, `ListFields`, `ColumnsFields` and `InfoboxFields`. `Field`, `Choice` and `LimitField` are for a wiki's own types.
- A type the build does not know is shown by its raw type and carried through untouched.
- Keep the kit and schema stable (a module constant or `useMemo`): both reach every card through context.
- An editor that draws blocks in place hosts the fields in `<BlockFieldsKit kit={KIT}>` with `<BlockToolbar>` and `<AddBlockMenu>`.

## Analytics

`wiki-formant/analytics`: page views and events in the site's own Postgres. No cookie and no stored address: a visitor is a hash of address and browser under a salt replaced every UTC day. Rows are kept 400 days. A view is marked engaged once its reader has had the page visible fifteen seconds or given it input, so `engaged` counts people where `agents` counts crawlers. The tables ship in `prisma/analytics.prisma`; `ViewDay` holds days a site counted elsewhere first.

```ts
// src/lib/track.ts
const sql: Sql = (query, ...values) => prisma.$queryRawUnsafe(query, ...values);
export const { trackEvent, trackMcpCall, trackFeedback, trackSearch, viewRoute } = createTracker({ sql, defer: after, siteUrl: SITE_URL });

// src/app/api/view/route.ts
export const POST = viewRoute();
```

- `createTracker` records only on a Vercel production deployment unless `enabled` says otherwise. `trackMcpCall` fits `McpServerConfig.onCall`; `trackSearch` normalises a query and drops an empty one; `recordEvent` is the undeferred write.
- A proxy reaches the tracker through a dynamic `import()` inside `event.waitUntil`, since it imports the database client.
- `digest(sql, { days })` is the site as one JSON object: people, engaged people, agents, views, visits, bounce rate, sources, pages, countries, devices, by day, agents by name, MCP calls and searches that found nothing, less a search its visitor went on typing within five minutes and any of one character. A visit is a run of views with no gap over 30 minutes; a bounce is a one-view visit its reader never engaged with. Agents are counted beside people, never among them: the ranked lists are people's. `ownAgents` leaves the site's own out. A multi-tenant app passes `site`.
- A browser under automation (`navigator.webdriver`) sends no beacon.

## Passkeys and the stats page

`wiki-formant/passkey`: the door to a site's own admin pages, a passkey and nothing else. `wiki-formant/stats`: the stats page behind it.

```ts
// src/lib/admin.ts
export const gate = createPasskeyGate({ sql, rpName: 'Caper' });

// src/app/api/passkey/route.ts
export const POST = gate.route;
export const DELETE = gate.signOut;

// src/app/stats/page.tsx
const q = statsQuery(params);
return (
  <StatsGate gate={gate} session={(await cookies()).get(gate.cookie)?.value} invite={params.invite} host="caper.network">
    {async () => <Stats digest={await digest(sql, q)} {...q} link={Link} />}
  </StatsGate>
);
```

- There is no sign-up: every passkey is saved from a single-use link `npx passkey-invite` prints. A passkey is bound to its host. Deleting a `Passkey` row signs out every session it opened. Tokens are kept only as hashes (`prisma/passkey.prisma`).
- `gate.signedIn(cookie)` is a page's check and `gate.allows(request)` a write route's.
- `statsQuery` reads `?days=` (1, 7, 30, 90, 365 or all) and the narrowings `?page=`, `?entry=`, `?source=`, `?country=`, `?device=`, which stack and recount every figure from the visits that pass.
- Each headline figure shows its change from the window before (`.stats-delta[data-better]`) and charts on press. A narrowed page over `ViewDay` totals starts at `counted_from` and says so.

## ROLA sign-in

`wiki-formant/rola`: a Radix wallet sign-in up to the token: a single-use challenge, the wallet's proof, the HS256 session, and the two MCP tools that sign an agent in. How a site keeps the session stays with it.

```ts
import { createRola, sessionSecret, signSession, verifySession, bearerToken, rolaLoginTools } from 'wiki-formant/rola';

const rola = createRola({ expectedOrigin, dAppDefinitionAddress, networkId, applicationName, challenges: prisma.challenge });
const v = await rola.verifySignedChallenge(signed);        // { isValid, error? }
const secret = sessionSecret(process.env.JWT_SECRET);      // throws under 32 characters
const token = await signSession({ id: signed.address }, secret, 7 * 86400);
const claims = await verifySession<{ id: string }>(bearerToken(request.headers) ?? cookie, secret);

const tools = rolaLoginTools({
  site: 'the wiki', dAppDefinitionAddress, origin: SITE_URL, tokenTtlSec: 7 * 86400, writeTools: 'create_page / edit_page',
  generateChallenge: rola.generateChallenge,
  login: async signed => issueToken(signed),   // { token, expiresAt, ...shown }; throw McpToolError to refuse
  notes: { sign: { address: 'your virtual account; its key must be an on-ledger owner_keys entry' } },
});
```

- A challenge is spent by one conditional delete whatever the outcome, so one signature cannot pass twice; making one purges the expired. Only an account proof signs in. Verification pins HS256.
- `rolaLoginTools` gives `get_challenge` (the exact message to sign, naming the dApp definition address and the origin `rolaOriginCheck` looks for) and `login`, whose refusal says to fetch a new challenge. `notes.challenge`, `notes.sign` and `notes.address` add a surface's own lines.

## Charts

`wiki-formant/chart`: `TimeChart`, every time-series chart: one area series in the box's `color`, range buttons (24H to All) and day, week and month steps.

```tsx
<TimeChart series={days} label="Transactions" aggregate="sum" fromZero
  markers={[{ time: haltAt, label: 'Network halt' }]} step="month" onView={v => keep(v)} />
<TimeChart series={load} label="Price" format={formatPrice} range="30d" candles />
```

- `series` is the points or a loader asked for `'hour'` (24H), `'4h'` (7D) or `'day'`, once each.
- The default step is the finest that makes 200 points or fewer; no step is finer than the points. `aggregate` is `last` for a price, `sum` for a count, `mean` for a rate. A stepped range starts on a whole week or month.
- Points with `open`, `high` and `low` get a candles switch; with `volume`, a volume pane. A zero-volume point leaves its slot empty.
- `format` gets the tick spacing too; `stepDecimals` and `formatChartValue` keep ticks at one precision. `markers` are tooltips on the last point at or before each event.
- `chartSteps` is exported for a chart drawn elsewhere.

## Base stylesheet

`wiki-formant/base.css`: the layout the package's markup needs and the package's components drawn on eleven `--ui-*` tokens (`--ui-surface`, `--ui-surface-2`, `--ui-border`, `--ui-radius`, `--ui-pad`, `--ui-small`, `--ui-muted`, `--ui-accent`, `--ui-on-accent`, `--ui-up`, `--ui-down`) a site maps from its palette in `:root`. No colour and no scale, so a design system's rules override it at equal specificity.

```css
@import "wiki-formant/base.css" layer(components);
```

It declares the page frame (`--content-width` 72rem, `--sidebar-width` 18rem, `--page-pad` 16/24/32px) in the components layer, so a site never restates them in `@theme`; the primitives `.spinner`, `.skeleton`, `.empty-state`; and the reduced-motion guard. The split of a page beside its infobox and the rail's surface stay the site's.

## Database and scripts

`wiki-formant/db`: `pgPoolConfig(url)`, ten clients on the 6543 transaction pooler and three on the 5432 session pooler, and `prismaConfig(root, schema?)`, which prefers `DIRECT_URL`, since the Prisma CLI hangs on the transaction pooler.

```ts
// prisma.config.ts
import { defineConfig } from 'prisma/config';
import { prismaConfig } from 'wiki-formant/db';
export default defineConfig(prismaConfig(import.meta.dirname));
```

`wiki-formant/scripts`: what a seed or sweep script shares: `withClient` (a `pg` client that rolls back on a throw and expires the cache tag after a write), `readPage`, `writeRevision` (refused if the page moved on), `upsertWikiPage`, the block builders `content`, `banner` and `infobox`, and `assertLinkShapes`.

```ts
import { withClient, readPage, writeRevision } from 'wiki-formant/scripts';
await withClient(async client => {
  const page = await readPage(client, 'contents/tech', 'radix-engine');
  await writeRevision(client, page!, blocks, { change: 'minor', message: 'Why, with the source.' });
}, { tag: 'wiki' });
```

`wiki-formant/link-check`: `auditLinks`, each link once with the pages that carry it, probed with `probeExternal` or the checker's own, and `printLinkAudit`.

`wiki-formant/knip`: the shared knip configuration, spread into each app's `knip.ts`.

## Bins

Run each from the app's root, where `.env` holds `DATABASE_URL`.

```sh
npx check-classes [--warn] [--compositions]   # a className token no stylesheet defines; 3+ inline utilities
npx check-pages https://radix.wiki            # the served HTML of every sitemap page
npx analytics-digest --days 7 [--gap "Symptom Miss:term"]
npx passkey-invite https://caper.network/stats [--days n]
npx prisma-models [analytics|passkey|wiki] [--check] [--in prisma/schema.prisma --tenant]
npx fts-ddl '"WikiPage"'                      # rebuild search_tsv and its index over DIRECT_URL
npx indexnow https://radix.wiki [--hours 6 | --all]
npx mark-verified <tagPath> <slug> | --all <tagPath> [--invalidate wiki]
npx maintenance-log read|write|compact|backlog-add --at <path> --routine <name> [--author <id>]
```

- `prisma-models` copies the shipped models into `prisma/schema/` (Prisma reads a folder of files; a generator `output` gains a `../`), and `--check` fails on a missing or drifted copy. `--in` compares models in one file, and `--tenant` lets `siteId` drop its default and gain a relation.
- `fts-ddl` runs before the column is declared in `schema.prisma`; a PascalCase table goes in quoted.
- `indexnow` posts the sitemap rows modified in the window to IndexNow, after checking the origin serves the key file in `public/`. The sitemap must render per request.
- `mark-verified` stamps `lastVerifiedAt` so `freshnessBanner` stops calling a page outdated.
- `maintenance-log` is the state of a sweep routine kept in one page's `metadata.state`: every mode holds the row lock from read to write, `backlog-add` files an item another routine raised and a stale `write` merges it back, and a `write` whose `totalRuns` is below the stored one is refused. `--site` names the wiki in a multi-tenant app.

## A reusable workflow

`.github/workflows/publish-mcp-registry.yml` republishes an origin's server to the MCP registry when its `server.json` version moves.

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
