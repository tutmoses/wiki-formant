# wiki-formant

The portable half of a wiki: derived taxonomy, a spec-correct MCP transport, markdown twins, and the conditional-GET plumbing an agent surface needs.

Zero runtime dependencies. Web-standard `Request`/`Response`, so it runs unchanged on Next route handlers, Hono, Bun, Deno and workers.

```bash
npm install wiki-formant
```

## What this is, and what it deliberately is not

Every wiki needs a page store, a design system and a set of block types. Those are the parts you must own — they encode your schema, your brand and your content model, and a package that tried to own them would fight you.

What every wiki *also* needs, rebuilds by hand, and then lets drift, is the layer above: the second browsing axis derived from metadata you are already storing, the HTML→markdown converter behind every `.md` twin, the JSON-RPC edges that decide whether an MCP client can talk to you at all, and the ETag arithmetic that turns a recrawl into a 304.

This package was extracted from three production wikis that had each grown their own copy. By the time it was lifted, the copies had already diverged — one had lost the alphabetical index and the related-page ranking; one had `ToolAnnotations` the others lacked; one had MCP prompts the others lacked. Everything here is the union, with tests pinning the specific bugs that shipped.

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
- **`alphaControls` returns `[]` below the index threshold**, folding in `needsAlphaIndex` — one call is either the index you needed or nothing, rather than a decision each caller makes and one caller forgets.
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
- **Deduping is not a parameter.** Two headings with the same text otherwise mint the same id twice, and every link to the second lands on the first. The copy that lacked it had that bug.

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

`config.gate` is envelope-level middleware: it may withhold entries before dispatch and merge its own responses back afterwards. A payment gate has to sit there rather than in a handler, because the demand *replaces* the call and the receipt rides on the envelope.

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
  { headers: markdownHeaders(lastModified, { etag }) },
);
```

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

## Pagination and versioning

`parsePagination` clamps `page ≥ 1` and `pageSize` to 1–100; `paginatedResponse` always carries `totalPages`. Reshaping that response is a breaking change to every client that pages, which is why it lives here rather than being re-typed per repo.

`parseVersion` / `bump` / `compareVersions` handle revision semver tolerantly — a page always has a version, even when the column holds `null` or junk.

## React

`wiki-formant/react` is the one part that needs React, so it is the one part behind its own subpath, and React is an *optional* peer. What is shared is behaviour; every class name and icon is passed in, because these wikis style their rails differently and always will.

`SidebarProvider` / `useSidebar` hold the rail's collapse state — remembered across loads, defaulted from the viewport only when the reader has never chosen. Pair it with `sidebarBootScript` from `wiki-formant/sidebar` (framework-free, so a server component can stamp it into `<head>`) or a remembered-closed rail paints open and animates shut on every load. `TableOfContents` is the "on this page" list, with scroll-spy, reading either headings you already know or the rendered article.

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

`useClickOutside` is fifteen lines and was in all three. Only one had the `offsetParent` check, and without it a container hidden at the current breakpoint still answers outside-clicks — so on a phone, a tap anywhere dismisses the popover the reader is looking at, because the hidden desktop copy got there first.

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

## Server components

`wiki-formant/react` carries `'use client'`, and that is a module-level boundary: anything exported from it hydrates in the consumer's tree whether or not it uses a hook. `wiki-formant/react-server` is the same React, without the directive — for the parts of a wiki that are pure functions of their props and should ship no JavaScript at all.

`FacetBar` renders the rows `createTaxonomy` already produces. This is why the taxonomy exports a rows model rather than markup: the rows could always cross the boundary and, until this subpath existed, the markup could not, so all three wikis hand-rendered it and two put `aria-pressed` on an `<a>`. `Breadcrumbs` renders the trail and its `BreadcrumbList` JSON-LD together, because a trail whose structured data is written somewhere else is a trail that will one day disagree with its own markup — which is the case Google penalises. It takes a `base` origin: structured-data URLs must be absolute and a package cannot know the site.
`FacetBar` takes a `count` class to render each count as its own element, and `alphaFirst` to lead with the A–Z row. Its JSON-LD goes out through `JsonLd`, which is exported for every other payload a page emits: it re-encodes each `<` as `\u003c`, because these payloads carry authored titles and an authored `</script>` would otherwise close the tag.

`PageNav` is the previous/next pair at the foot of an article — the sequential read the infobox rail's lateral links do not cover. Ordering is the caller's, because it is the one part that is never portable: a wiki's sequence is its section's configured sort, a knowledge base's is a taxonomy walk. Pair it with `adjacentPages` from `wiki-formant/pagination` over a list you already hold — neither wiki needs a query for it, and the two indexed lookups the neighbours used to cost were the reason one of them dropped the control.

`RailShell` stays in `wiki-formant/react`, because it calls `useSidebar` and genuinely is a client component. It renders the rail's landmark, its scroll wrapper and the three collapse states — including the `--instant` class that keeps a remembered-closed rail from animating shut on first paint, and the close-on-tap that a mobile rail needs. Compose your own rail inside it and mark the active link with `isRailLinkActive`; all three wikis do, and the pre-composed component that used to sit here had one consumer and had already lost both of those behaviours.

All three take the router's link component as a prop:

```tsx
import Link from 'next/link';
<FacetBar link={Link} facets={facets} letters={letters} />
```

There is no `next` peer dependency here and there is not going to be one, but a rail that falls back to a bare `<a>` turns every press into a full page load — which is the whole reason a wiki has a persistent rail. So the router arrives through the door.

## Payment gating

`wiki-formant/x402` gates an MCP envelope on payment, for a wiki that charges for a bulk export over HTTP and would otherwise hand the same bytes over free through the equivalent MCP tool. Payment travels in-band — `params._meta["x402/payment"]` in, `result._meta["x402/payment-response"]` out — because one HTTP 402 cannot answer a batch of twenty in which one call is priced and nineteen are not.

`gatePaidCalls` returns what `handleMcp` should dispatch and a `finish` that puts the answer back together. The ordering is the part worth owning once: verify before dispatch, settle only after a non-error answer, splice the challenges back into the caller's original order. A tool that raises cancels rather than settles — the caller pays for an answer, not an attempt.

It imports nothing. `@x402/core`, `@x402/evm`, `@x402/extensions`, `@x402/next` and `viem` are optional peers, and the resource server arrives as a structural port instead of an import, so a wiki that never imports this subpath never resolves any of them. Which surfaces cost what, the prices and the terms text stay with the caller: those are policy, and this is the envelope surgery.

## AI crawlers

Every wiki kept this roster twice — once in the proxy, keyed by user-agent, to
count an `AI Bot Visit`; once in `robots.ts`, as the agents that get their own
group. Both copies were byte-identical across three repos, and they were
different lists.

```ts
import { detectAiBot, aiCrawlerRules } from 'wiki-formant/crawlers';

const bot = detectAiBot(request.headers.get('user-agent'));   // label, or null
const rules = aiCrawlerRules({ allow: '/', disallow, aiAllow });
```

Only one direction of that difference was deliberate: `Applebot-Extended` never
fetches a page, so it belongs in robots and not in the matcher. The other
direction was not. Bytespider, CCBot, cohere-ai, Claude-Web and
Meta-ExternalFetcher were matched by every proxy and named by no robots.txt —
and a crawler obeys only its most-specific matching group, so an agent with no
group of its own falls through to `*`. Three wikis were measuring five crawlers
they had never addressed.

Every group also allows `AGENT_SURFACE_PATHS` — `/api/mcp`, the three `llms` exports, `/openapi.json`, `/.well-known/` — without being told. `aiAllow` is what an origin serves beyond that.

## Page metadata

`wiki-formant/metadata`'s `pageMetadata` builds a page's canonical, markdown-twin alternate, Open Graph and Twitter card from one input. Next replaces those objects per route segment rather than merging them, and does not derive `twitter.title` from `openGraph`, so a page that sets one and forgets the other falls back to the layout's generic card. Two wikis wrote a helper around that, covering different halves.

```ts
export const generateMetadata = () => ({
  title,
  ...pageMetadata({ title, description, url, type: 'article', image: ogImageUrl(title), siteName, handle, markdownTwin: true }),
});
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

## Feeds

Three repos, four feeds, 47 of 64 significant lines identical — including,
verbatim in two of them, the comment explaining why the apostrophe escapes
numerically. `renderFeed` is the union.

```ts
return new Response(renderFeed(channel, items), { headers: FEED_HEADERS });
```

**`lastBuildDate` comes from the newest item, not the clock.** One copy stamped
`new Date()` on every request, telling every poller the feed had changed when it
had not — the recrawl the conditional-GET helpers exist to prevent. An empty feed
carries no build date rather than a fictional one.

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

`TWITTER_ORIGIN` is written down once. It is both the embed host and the allow-list `onTweetResize` checks before believing a posted height, and it had been spelled out at four call sites across two repos. Any page can `postMessage`; only the embed host may size the embed.

## Search

`proseSql`, `searchTsvSql`, `HEADLINE_OPTIONS` and `FTS_RANK_NORMALIZATION` are what a literal tier and a full-text tier must agree on. `searchTsvDdl(table)` is the statements that build the generated `search_tsv` column and its index — dropped and re-added in one transaction every run, because a skip-if-present script is blind to a changed expression.

## Block trees

Every wiki here stores the same two containers the same way — `columns[i].blocks` and an infobox's `blocks` — and between them had hand-written that walk seven times. Bind it once and hand it to every walk:

```ts
import { coreBlockShape, leafBlocks, mapBlockTree } from 'wiki-formant/blocks';

export const BLOCK_SHAPE = coreBlockShape<Block>();
mapBlockTree(blocks, processLeaf, BLOCK_SHAPE);
leafBlocks(blocks, BLOCK_SHAPE.containers);
```

`computeRevisionDiff` defaults to the same shape, path-addressed, so a repo whose containers are the core two passes none.

The dispatch over a repo's own block union stays in that repo; the bodies come from here. `wiki-formant/text` has a prose body for every core leaf — `statsToText`, `linkGridToText` and `pageListToText` joined the originals when two of the three wikis turned out to extract nothing from them, so their MCP `get_page` answered a hub page as nearly empty.

`createBlockValidator` returns `blockIssues` beside the boolean validators: the same walk, reporting where each failure is.

```ts
const issues = blockIssues(body.content);
if (issues.length) return badRequest(`Invalid content: ${describeBlockIssues(issues)}`);
// Invalid content: [2].columns[0].blocks[1]: malformed linkGrid block
```

## Sanitising stored HTML

`wiki-formant/sanitize` is the allowlist between an author's saved HTML and a reader's browser. The block views render three HTML fields themselves, and a repo renders `content.text` beside them, so the guard ships with the renderer. `sanitize-html` is an optional peer; run it server-side, on the render path, so it covers rows written before it existed and no sanitiser ships to the client.

```ts
import { createHtmlSanitizer, sanitizeCoreLeaf } from 'wiki-formant/sanitize';

const clean = createHtmlSanitizer({ iframeHosts: FRAME_HOSTS });   // pair with CSP frame-src
const safe = mapBlockTree(blocks, b => sanitizeCoreLeaf(b, clean), BLOCK_SHAPE);
```

The default list is derived from what the editor nodes in `wiki-formant/tiptap` store — the embed wrappers' data attributes, the tab markup `activateTabGroups` reads back, the table classes — plus the presentational SVG subset the infographics pipeline embeds. Extend it with `tags`, `attributes`, `classes` and `schemesByTag` derived from your stored HTML, never from memory: a list written from memory erases content on the first render.

Classes pass by name only. Limiting `style` to layout and paint is worth nothing while `class` is free, because every site's own stylesheet ships `fixed inset-0 z-50`, and those draw a fake prompt over the chrome as well as `position` does.

## Editor nodes

`wiki-formant/tiptap` carries the custom nodes both wiki editors had written twice: `Iframe`, `YouTube` (the stock extension plus the paste rule it does not ship with), `TwitterEmbed`, `createMapEmbed`, `createCodeBlock` and `createTabs`. The four `@tiptap/*` packages are optional peers, so a consumer taking only the taxonomy still installs a package with no runtime dependencies.

```ts
const CodeBlock = createCodeBlock({
  langs: CODE_LANGS, defaultLang: DEFAULT_LANG,
  classNames: { button: 'lang-btn', option: 'lang-option', optionActive: 'text-accent' },
  icons: { chevron: open => <ChevronDown className={open ? 'rotate-180' : ''} /> },
});
```

The ones that take config take it because that is exactly where the two copies differed — class tokens, the language list, and the API route a shortened map URL has to be resolved through. Injecting them is what lets one wiki keep `text-jupiter` and the other `text-accent` without either forking the node, and it keeps this file from dragging an icon library in behind it.

`createTabs` returns `TabGroup` and `TabItem` together: `tabGroup`'s content expression is `tabItem+`, so registering one without the other leaves a node type the schema cannot satisfy. A pasted short map link inserts immediately with `about:blank` and swaps its `src` when the redirect resolves — pasting must not block on a network hop, and the node has to exist for the reader to see anything happen.

`createHeadingIds({ slug })` decorates each heading in the editor with the id its published copy will carry, through `uniqueHeadingId` — the dedupe `injectHeadingIds` uses — so a rail listing headings mid-edit links to the anchors readers will get. `uploadImageTo('/api/upload')` is the `uploadImage` two editors had written identically.

The redirect resolves through the wiki's own route, because the editor cannot read it cross-origin. `resolveMapUrl` is the client half and `resolveMapHandler` the whole route: exact shortener hosts, one hop, an allowlisted landing host, a timeout, and your sign-in check as `authorize`. One of the two copies it replaced matched `goo.gl` as a substring and followed every redirect for anyone who asked.

```ts
export const GET = resolveMapHandler({ authorize: async () => !!(await currentUser()) });
```

## Analytics

Two lanes, one events helper. `mcpCallProps` reads a tool name out of a JSON-RPC
envelope that is untrusted and may be a batch; `searchQueryProps` normalises a
search box's free text so the same question aggregates as one row. Sending stays
with the caller — `plausibleEvent` builds the request, and the framework's own
deferral (`after()` in a route or server action, `event.waitUntil` in a proxy)
decides when it goes, so this package keeps its zero-dependency guarantee.

```ts
const props = searchQueryProps({ query, results: rows.length, surface: 'wiki' });
// null for an empty field, so a blank search cannot fire an event
if (props) after(() => plausibleEvent({ domain }, 'Search Query', url, props, headers, {
  // a person triggered this, so it joins their session rather than landing
  // as the fixed bot-tracker pseudo-visitor
  userAgent: headers.get('user-agent') ?? undefined,
}));
```

Instrumenting the agent lane and not the human one is the easy mistake: it
leaves a wiki able to say what every crawler asked for and nothing about what
its readers asked for. The queries that return zero rows are the valuable ones —
they name a gap in the corpus in the reader's own words.

## API

Every module has a subpath — `wiki-formant/taxonomy`, `wiki-formant/mcp`, and so on.
The emitted `.d.ts` files are the reference. There is no hand-maintained symbol list
here, because the one that used to be here drifted from them.

The package root re-exports the runtime modules that need no peer dependency and no
client boundary, so `import … from 'wiki-formant'` stays importable from a route
handler with nothing else installed. Everything that reaches for React, a browser
global, tiptap or a wallet — and the tooling modules, which no route imports — is
subpath-only.

## A bin

`check-classes` fails a build on a `className` token that resolves to nothing, and counts the inverse fault — 3+ Tailwind utilities inline, which is a component class that was never named. Both sets are derived from the emitted stylesheets rather than listed, so nothing has to be maintained per project. Run it from a repo root after a build:

```sh
npx check-classes                # exit 1 on any dead token
npx check-classes --warn         # report and exit 0
npx check-classes --compositions # also fail on the inline compositions
```

## Licence

MIT.
