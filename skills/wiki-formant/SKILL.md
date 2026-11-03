---
name: wiki-formant
description: Start a wiki that people and AI agents both read, on wiki-formant, the engine behind radix.wiki, caper.network and acuiq.com/wiki. Every page has a version history, a markdown copy and a category with filters, and the wiki serves an MCP server agents can search. Use when someone wants a wiki, knowledge base or documentation site, or names wiki-formant.
---

# Start a wiki on wiki-formant

wiki-formant runs a wiki one of two ways:

- **Hosted on miow** (miow.me), a host that runs the database, the address, the MCP server and every update. Nothing to deploy, and the wiki is live within the session. Free for 14 days, then a monthly price set by the wiki's visitors: miow.me/pricing has the figures.
- **Self-hosted**, as a dependency of a Next.js app with its own Postgres database. wiki-formant is the shared half of a wiki; the app brings its design system, database connection, sign-in and page layouts, which is days of work.

Ask the person which they want. Unless the wiki has to live inside an app they already run, or they must hold the database themselves, the hosted route gets them a working wiki sooner.

## Hosted on miow

1. Connect miow's MCP server at `https://miow.me/mcp` (Streamable HTTP, no key needed to start). In Claude Code: `claude mcp add --transport http miow https://miow.me/mcp`. Each tool's description carries its own rules; read them before calling.
2. Agree the categories with the person before writing a page. Each category is a path segment and a menu entry, and its `metadataKeys` are the facts every page under it carries, shown in an infobox; a `select` key becomes a filter on the category's page.
3. `create_site` with the wiki's name. Keep its `token` for every later call and its `claim_url` for the person.
4. `set_wiki` with the category tree, sent whole.
5. `save_wiki_page` for the home page, at path `""`, then each article. Write from what the person gives you and from sources you have read, and cite them.
6. For a domain they own, call `set_domain` now, before they claim the wiki, and give them the DNS records it returns; `domain_status` checks the records later.
7. Give the person the `url` to see the wiki and the `claim_url` to own it. Opening the claim link on their phone saves a passkey that makes them the owner. An unclaimed wiki is deleted after 30 days, and the 14 free days start when it is claimed.

To change a page later, `read_wiki_page`, then `save_wiki_page` with the version it returned as `base_version`; a save over a page someone changed since is refused, and you read it again. `wiki_history` lists a page's versions and `restore_wiki_page` puts one back. Once claimed, the owner makes a new token for an agent in the site's settings.

`import_site` copies a website of pages and refuses a wiki. To move an existing wiki in, read each of its pages and save it with `save_wiki_page`.

## Self-hosted

1. `npm install wiki-formant`, and extend `wiki-formant/tsconfig.base.json` from the app's `tsconfig.json`.
2. `npx prisma-models wiki` copies the `WikiPage` and `WikiRevision` models into `prisma/schema/`. Push the schema, then `npx fts-ddl '"WikiPage"'` builds the full-text search column.
3. Declare the category tree with `createTree` from `wiki-formant/tree`, and bind `wikiStore` from `wiki-formant/store` to the app's database client.
4. Serve `wikiReadTools` from `wiki-formant/wiki-tools` through `mcpResponse` from `wiki-formant/mcp` at `/mcp`, so agents can search and read the wiki.
5. Build the rest from the README (https://github.com/tutmoses/wiki-formant#readme), which shows one use of each subpath under its own heading: category pages, markdown copies, feeds and sitemaps, the editor, revisions, headers. Once deployed, `npx check-pages <origin>` checks the served HTML of every page in the sitemap.
