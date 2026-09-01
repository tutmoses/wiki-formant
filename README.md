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
- **Batches are capped** (default 20) with a teaching error, because the rate limiter charges one token per HTTP request before the body is parsed.

## Markdown twins

`htmlToMarkdown` preserves the structure an agent cites by — headings, lists, tables, code, emphasis — rather than flattening to prose. Tables convert first so the generic rules cannot eat their markup, ordered lists number per list, pipes inside cells are escaped, and a headerless table gets a synthesised header because GFM has no other form.

```ts
import { htmlToMarkdown, markdownDocument } from 'wiki-formant/markdown';

return new Response(
  markdownDocument(
    { title: page.title, url, updated: page.updatedAt, lastVerified: page.lastVerifiedAt,
      license: { spdx: 'CC-BY-4.0', url: 'https://creativecommons.org/licenses/by/4.0/' } },
    blocksToMarkdown(page.content), // your block types, your function
  ),
  { headers: markdownHeaders(lastModified) },
);
```

Block trees stay in your app — every project owns its own type set. Give this module HTML and it gives you markdown.

> A trap worth naming: if you serve twins via a rewrite, Next drops the destination query string. The rewrite must carry the `.md` extension through to the destination path, or the twin silently serves JSON.

## Conditional GET

The `llms.txt` / `llms-index.txt` / `llms-full.txt` trio are the most-recrawled URLs a wiki serves and the most expensive to render. Without a corpus-derived ETag, every AI crawler pays full price on every pass, forever.

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

## Rendered-article passes

`wiki-formant/dom` holds what runs against an article element after it is in the document. Not React, so not in `react.tsx`.

```ts
addCopyButtons(el);            // every <pre> gets one, once
hydrateTweetEmbeds(el);        // placeholders get a live src
const off = onTweetResize(h => sizeTweetEmbeds(el, h));
```

`addCopyButton` was **byte-identical** in two BlockRenderers, down to the SVG path data. Its idempotence guard now lives inside the function rather than in a `pre:not(:has(…))` at the call site, where it can be — and was — retyped.

`activateTabGroups` turns stored `[data-tabs]` markup into a working tab group. The editor persists tabs as nested divs, which is the right thing to store — it survives a markdown twin, a plain HTML render and a reader with JavaScript off, all of which show every tab in order. Making one of them pressable is a reader-side job, and it sits beside the other passes rather than inside a component.

`TWITTER_ORIGIN` is written down once. It is both the embed host and the allow-list `onTweetResize` checks before believing a posted height, and it had been spelled out at four call sites across two repos. Any page can `postMessage`; only the embed host may size the embed.

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

| Export | From |
|---|---|
| `createTaxonomy`, `defaultHref`, `firstLetter`, `toggleFilter` | `wiki-formant/taxonomy` |
| `injectHeadingIds`, `headingsFrom`, `slugifyHeading` | `wiki-formant/headings` |
| `mcpResponse`, `mcpGet`, `mcpOptions`, `handleMcp`, `withMcpCors`, `McpToolError`, `MCP_CORS`, `MCP_PROTOCOL_VERSION` | `wiki-formant/mcp` |
| `htmlToMarkdown`, `inlineToMarkdown`, `tableToMarkdown`, `frontmatter`, `markdownDocument`, `decodeEntities` | `wiki-formant/markdown` |
| `corpusEtag`, `notModified`, `textHeaders`, `markdownHeaders`, `cleanSnippet`, `pageLine` | `wiki-formant/http` |
| `parsePagination`, `paginatedResponse`, `toOffset` | `wiki-formant/pagination` |
| `parseVersion`, `formatVersion`, `incrementVersion`, `bump`, `compareVersions` | `wiki-formant/versioning` |
| `plausibleEvent`, `mcpCallProps`, `searchQueryProps`, `plausibleDomain` | `wiki-formant/analytics` |
| `comboboxAria`, `listId`, `optionId` | `wiki-formant/combobox` |
| `AI_CRAWLERS`, `detectAiBot`, `aiCrawlerTokens`, `aiCrawlerRules` | `wiki-formant/crawlers` |
| `useCollapsibleSidebar`, `SidebarProvider`, `useSidebar`, `TableOfContents`, `useTypeahead`, `useLinkPreview`, `useClickOutside` | `wiki-formant/react` |
| `resolveSidebarOpen`, `sidebarBootScript`, `SIDEBAR_ATTRIBUTE` | `wiki-formant/sidebar` |
| `addCopyButtons`, `activateTabGroups`, `tweetEmbedSrc`, `onTweetResize`, `hydrateTweetEmbeds`, `sizeTweetEmbeds`, `TWITTER_ORIGIN` | `wiki-formant/dom` |
| `Iframe`, `YouTube`, `TwitterEmbed`, `createMapEmbed`, `createCodeBlock`, `createTabs` | `wiki-formant/tiptap` |

Everything above `wiki-formant/react` is also re-exported from the package root. The React, sidebar, DOM and tiptap subpaths are not: they carry `'use client'` or reach for a browser global, and the root has to stay importable from a route handler.

## Licence

MIT.
