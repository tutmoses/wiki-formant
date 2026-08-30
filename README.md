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

## API

| Export | From |
|---|---|
| `createTaxonomy`, `defaultHref`, `firstLetter`, `toggleFilter` | `wiki-formant/taxonomy` |
| `mcpResponse`, `mcpGet`, `mcpOptions`, `handleMcp`, `withMcpCors`, `McpToolError`, `MCP_CORS`, `MCP_PROTOCOL_VERSION` | `wiki-formant/mcp` |
| `htmlToMarkdown`, `inlineToMarkdown`, `tableToMarkdown`, `frontmatter`, `markdownDocument`, `decodeEntities` | `wiki-formant/markdown` |
| `corpusEtag`, `notModified`, `textHeaders`, `markdownHeaders`, `cleanSnippet`, `pageLine` | `wiki-formant/http` |
| `parsePagination`, `paginatedResponse`, `toOffset` | `wiki-formant/pagination` |
| `parseVersion`, `formatVersion`, `incrementVersion`, `bump`, `compareVersions` | `wiki-formant/versioning` |

All are also re-exported from the package root.

## Licence

MIT.
