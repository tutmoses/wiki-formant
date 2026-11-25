// react-server.tsx — the parts of the wiki UI that must NOT ship JavaScript.
//
// `react.tsx` carries `'use client'`, which is a module-level boundary: anything
// exported from it is a client component in the consumer's tree, whether or not
// it uses a hook. The facet bar and the breadcrumb trail are pure functions of
// their props — every control is a link and the URL is the only state — so
// putting them there would have made three server-rendered rows into three
// hydrated ones for nothing. Hence a second React subpath with no directive.
//
// This is also why `wiki-formant/taxonomy` exports a rows model
// (`FacetControlGroup`) rather than a component: the rows can cross the boundary
// and, until this file existed, the markup could not. Both now live here, and
// the rows model stays what it always was — the bar renders it, it does not
// replace it.
//
// Every link component arrives as a prop. This package has no `next` peer
// dependency, so a rail or a facet row that reached for `next/link` would fall
// back to a full page load on every press. React is an optional peer, as it is
// for `wiki-formant/react`.

import { Fragment } from 'react';
import type { ComponentProps, ComponentType, ReactNode } from 'react';
import { Beacon, RailToggle, SidebarProvider, Toaster, WikiLinkPreview, type RailLink, type WikiLinkPreviewProps } from './react.js';
import type { WikiNode } from './tree.js';
import { SEE_ALSO_ID } from './headings.js';
import type { License } from './license.js';
import type { SiteDefinition } from './metadata.js';
import { followLinkProps, type XAccount } from './social.js';
import { sidebarBootScript } from './sidebar.js';
import type { Control, FacetControlGroup, MetadataRow } from './taxonomy.js';
import { safeLinkHref } from './validation.js';
import { highlightRanges } from './highlight.js';
import { isoDate } from './html.js';
import { blockLocation, type BlockChange } from './revisions.js';
import type { HistoryChange } from './history.js';
import type { MaintenanceQueue } from './queues.js';
import { formatDay } from './freshness.js';

/**
 * The shape a router's link component has to satisfy here.
 *
 * Deliberately the intersection the three rails, three facet bars and the stats
 * page actually use, not a re-declaration of `AnchorHTMLAttributes`: a wider surface would
 * let a consumer pass something `next/link` accepts and a bare `<a>` silently
 * drops. `next/link` satisfies this as it stands.
 */
export interface WikiLinkProps {
  href: string;
  className?: string;
  title?: string;
  'aria-current'?: 'true' | 'page' | undefined;
  /** `prev`/`next` on the foot nav — the half that makes the pair machine-readable. */
  rel?: string;
  /** `switch`, with `aria-checked`, on the stats page's toggle between two views. */
  role?: string;
  'aria-checked'?: boolean;
  /** The name of a link drawn as an icon. */
  'aria-label'?: string;
  /** False where following the link costs the server a query, as a stats page's links do; a plain anchor ignores it. */
  prefetch?: boolean;
  children?: ReactNode;
}

export type WikiLinkComponent = ComponentType<WikiLinkProps>;

/**
 * The default for anything that does not need client-side navigation.
 *
 * Exported because `block-views` renders links too and had declared the same
 * three lines; a default that exists twice is a default that can diverge.
 */
export const Anchor: WikiLinkComponent = ({ prefetch: _, ...props }) => <a {...props} />;

// ---- facet bar --------------------------------------------------------------

/**
 * Class names differ per wiki and always will — unlike the rail's `wiki-rail__*`
 * tree, which is a shared convention, these are each design system's own words
 * for a chip and a row. Defaults are given so a consumer that shares them writes
 * nothing.
 *
 * Whether the bar is a chip row above the grid or a panel beside it is decided
 * here and nowhere else: the markup is the same, the stylesheet behind these
 * names lays it out.
 */
export interface FacetBarClassNames {
  root?: string;
  /** Each facet's row, and the A–Z row unless `letterRow` is set. */
  row?: string;
  /** A row's heading: the facet's label, or `alphaLabel`. */
  label?: string;
  /** A facet option, and a letter unless `letterControl` is set. */
  control?: string;
  controlActive?: string;
  /** Set it and each count is its own `<span>` with this class, not ` (n)` text. */
  count?: string;
  /**
   * Set it and each control's text is its own `<span>` with this class, and a
   * facet option carries its value as `title`: the hook for truncating a long
   * value while its count stays in view, with the full value one hover away.
   */
  text?: string;
  /**
   * The A–Z row and its letters, which a panel draws as a block of glyphs
   * while its facet options run full width. Each falls back to its shared key.
   */
  letterRow?: string;
  letterControl?: string;
  letterControlActive?: string;
}

export interface FacetBarProps {
  link: WikiLinkComponent;
  facets: FacetControlGroup[];
  letters: Control[];
  /** The label on the A–Z row. */
  alphaLabel?: string;
  /** Lead with the A–Z row: two lines against a facet block's twenty. */
  alphaFirst?: boolean;
  /**
   * Where a letter's count goes. `'inline'` prints it like an option's;
   * `'title'` keeps the letter a bare glyph and puts its count in the tooltip.
   */
  letterCounts?: 'inline' | 'title';
  classNames?: FacetBarClassNames;
  /** The landmark's accessible name. */
  label?: string;
}

const pagesPhrase = (n: number) => `${n} page${n === 1 ? '' : 's'}`;

/**
 * The section's second axis, as pressable chips.
 *
 * Each control arrives with its href already built through the one `href`
 * helper in `wiki-formant/taxonomy` — which is what stops a letter button from
 * dropping the active facets — and the A–Z row leads with the reset control.
 *
 * `aria-current`, not `aria-pressed`: a link is not a toggle button and does not
 * take that attribute.
 */
export function FacetBar({
  link: Link,
  facets,
  letters,
  alphaLabel = 'A–Z',
  alphaFirst = false,
  letterCounts = 'inline',
  classNames = {},
  label: navLabel = 'Filter pages',
}: FacetBarProps) {
  if (!facets.length && !letters.length) return null;

  const {
    root = 'stack tight',
    row = 'cluster',
    label = 'form-label',
    control = 'tag',
    controlActive = 'tag tag-removable',
    count,
    text,
    letterRow = row,
    letterControl = control,
    letterControlActive = controlActive,
  } = classNames;

  const chip = (
    c: Control,
    classes: { idle: string; active: string },
    opts: { title?: string; showCount: boolean },
  ) => (
    <Link
      key={c.value || 'all'}
      href={c.href}
      className={c.active ? classes.active : classes.idle}
      aria-current={c.active ? 'true' : undefined}
      {...(opts.title ? { title: opts.title } : {})}
    >
      {text ? <span className={text}>{c.label}</span> : c.label}
      {opts.showCount && (count ? <span className={count}>{c.count}</span> : ` (${c.count})`)}
    </Link>
  );

  const facetRows = facets.map(facet => (
    <div key={facet.key} className={row}>
      <span className={label}>{facet.label}</span>
      {facet.options.map(o =>
        chip(o, { idle: control, active: controlActive }, { title: text ? o.label : undefined, showCount: true }),
      )}
    </div>
  ));

  // The reset control leads the letters and says what it resets to.
  const alphaRow = letters.length > 0 && (
    <div key="alpha" className={letterRow}>
      <span className={label}>{alphaLabel}</span>
      {letters.map(l =>
        chip(
          l,
          { idle: letterControl, active: letterControlActive },
          {
            title: l.reset ? `All ${l.count} pages` : letterCounts === 'title' ? pagesPhrase(l.count) : undefined,
            showCount: letterCounts === 'inline',
          },
        ),
      )}
    </div>
  );

  // A landmark: every control in it narrows the list below, and a screen
  // reader user skipping between regions should be able to land on it.
  return (
    <nav className={root} aria-label={navLabel}>
      {alphaFirst ? [alphaRow, ...facetRows] : [...facetRows, alphaRow]}
    </nav>
  );
}

// ---- the line under the facet bar -------------------------------------------

export interface FacetSummaryProps {
  shown: number;
  total: number;
  /** The section, as a reader names it. */
  name: string;
  /** The un-narrowed section. Pass it exactly when a facet or letter is active. */
  clearHref?: string;
  link?: WikiLinkComponent;
}

/**
 * How much of the section the reader is looking at, and the way back to all of
 * it. Two wikis printed the same sentence and one printed none; one had the
 * Clear link and another had the only filtered-empty state. This is all three.
 */
export function FacetSummary({ shown, total, name, clearHref, link: Link = Anchor }: FacetSummaryProps) {
  const clear = clearHref ? (
    <>
      {' '}
      <Link href={clearHref} className="facet-summary-clear">
        Clear filters
      </Link>
    </>
  ) : null;
  if (total === 0) return <p className="facet-summary">This section has no pages yet.</p>;
  if (shown === 0) return <p className="facet-summary">No pages match these filters.{clear}</p>;
  return (
    <p className="facet-summary">
      {shown === total ? (
        <>
          The following <strong>{total}</strong> {total === 1 ? 'page is' : 'pages are'} in {name}.
        </>
      ) : (
        <>
          Showing <strong>{shown}</strong> of {total} pages in {name}.
        </>
      )}
      {clear}
    </p>
  );
}

// ---- see also ------------------------------------------------------------------

export interface RelatedPagesProps {
  /** `rankRelated`'s pages, with the hrefs the wiki builds. */
  pages: readonly { href: string; title: string; detail?: string }[];
  /** The heading's words — the wiki's own, since they name its sections. */
  heading: ReactNode;
  /**
   * The set the heading opens: the section filtered to the facet `rankRelated`
   * found in common. Omit and the heading is plain text.
   */
  href?: string;
  link?: WikiLinkComponent;
  /** Unique on the page; ties the landmark to its heading. */
  id?: string;
}

/**
 * The foot-of-article "see also". A labelled complementary landmark over a real
 * list, because the two copies this replaced split those between them: one had
 * the landmark and the list, the other neither.
 */
export function RelatedPages({ pages, heading, href, link: Link = Anchor, id = SEE_ALSO_ID }: RelatedPagesProps) {
  if (!pages.length) return null;
  return (
    <aside className="see-also" aria-labelledby={id}>
      <h2 id={id} className="see-also-heading">
        {href ? <Link href={href}>{heading}</Link> : heading}
      </h2>
      <ul className="see-also-list">
        {pages.map(p => (
          <li key={p.href}>
            <Link href={p.href} className="see-also-item">
              <span className="see-also-title">{p.title}</span>
              {p.detail && <span className="see-also-detail">{p.detail}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </aside>
  );
}

// ---- structured data --------------------------------------------------------

/**
 * A JSON-LD payload, safe to place inside `<script type="application/ld+json">`.
 *
 * The body has to go in through `dangerouslySetInnerHTML` — React escapes a
 * text child's `<`, which breaks the parser Google reads — and these payloads
 * carry authored strings: page titles, display names, excerpts. An authored
 * `</script>` closes the tag and the rest parses as markup. Re-encoding every
 * `<` as its JSON escape closes that; every JSON parser decodes it back, so the
 * data a crawler reads is unchanged. One of the three wikis did this; the
 * other two, and this package's own breadcrumb trail, did not.
 *
 * @internal
 */
function jsonLdScript(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

/** A `<script type="application/ld+json">` for `data`, escaped by `jsonLdScript`. */
export function JsonLd({ data }: { data: unknown }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(data) }} />;
}

// ---- the agent surface's links ----------------------------------------------

export interface SiteLinksProps {
  /** The site's RSS feeds. */
  feeds?: readonly { href: string; title: string }[];
  /** Whether the origin serves `/.well-known/openapi.json` and `agent-card.json`. */
  described?: boolean;
  /** Whether it serves `/AGENTS.md`. */
  agentsMd?: boolean;
}

/**
 * The `<link>`s that make `/llms.txt`, the feeds, the OpenAPI document, the
 * agent card and AGENTS.md reachable from whatever page an agent lands on first.
 * React hoists them into `<head>` from anywhere in the tree.
 *
 * They live in the root layout, not in `alternates`, because a page that sets
 * `alternates.canonical` replaces that whole object. `service-desc` is the
 * OpenAPI document, never the MCP endpoint: that is POST-only, so a client that
 * followed the link would get a 405, and the document and the card both carry
 * its URL. `/llms.txt` is `help`, not `alternate`, which would claim a site-wide
 * index is this page's plain-text twin.
 */
export function SiteLinks({ feeds = [], described = true, agentsMd = false }: SiteLinksProps) {
  return (
    <>
      <link rel="help" type="text/plain" href="/llms.txt" title="LLM guide" />
      {feeds.map(f => (
        <link key={f.href} rel="alternate" type="application/rss+xml" href={f.href} title={f.title} />
      ))}
      {described && <link rel="service-desc" type="application/json" href="/.well-known/openapi.json" title="OpenAPI description" />}
      {described && <link rel="service-meta" type="application/json" href="/.well-known/agent-card.json" title="A2A agent card" />}
      {agentsMd && <link rel="service-doc" type="text/markdown" href="/AGENTS.md" title="Agent API reference" />}
    </>
  );
}

// ---- breadcrumbs ------------------------------------------------------------

export interface BreadcrumbItem {
  label: string;
  /**
   * Omit to render the crumb as plain text rather than a link — a section that
   * groups pages but has no page of its own. A crumb with no href is left out
   * of the `BreadcrumbList` too, since a `ListItem` with no `item` is invalid.
   */
  href?: string;
}

export interface BreadcrumbsProps {
  items: BreadcrumbItem[];
  /**
   * Origin the JSON-LD `item` URLs are resolved against, without a trailing
   * slash. Structured-data URLs must be absolute — Google rejects relative
   * paths — and this package cannot know the site it is rendering for. Omit it
   * to render the trail with no structured data at all.
   */
  base?: string;
  className?: string;
  /** Defaults to a plain `<a>`, which is what a crumb trail wants. */
  link?: WikiLinkComponent;
  /**
   * What the final crumb renders as.
   *
   * `h1` is not decoration: on a wiki whose page title IS the last crumb, the
   * trail and the heading are the same words, and rendering both means either
   * saying it twice or shipping a page with no h1 at all. The `breadcrumb-h1`
   * class carries the size difference.
   */
  lastAs?: 'span' | 'h1';
  /**
   * Fewest crumbs worth rendering. Default 2 — one crumb is not a trail.
   *
   * A wiki whose last crumb doubles as the page heading passes 1, because there
   * the single crumb is not a trail either, it is the title.
   */
  minItems?: number;
}

/**
 * The trail, plus the `BreadcrumbList` that makes it a rich result.
 *
 * THE TWO ARE EMITTED TOGETHER ON PURPOSE. A trail whose JSON-LD is written
 * somewhere else is a trail that will one day disagree with its own markup, and
 * Google penalises exactly that. Both wikis had proved the point before
 * adopting this: each rendered its crumbs in a component and built its
 * `BreadcrumbList` in a different file — a page module in one, a `*-ld.ts` in
 * the other — and one of them carried a comment noting the risk it was taking.
 *
 * Markup is a `<nav>` wrapping an `<ol>`: a breadcrumb trail is an ordered list
 * and assistive technology announces it as one. The separators are list items
 * marked `aria-hidden`, so they are not read out as content.
 */
export function Breadcrumbs({
  items,
  base,
  className = '',
  link: Link = Anchor,
  lastAs = 'span',
  minItems = 2,
}: BreadcrumbsProps) {
  if (!items || items.length < minItems) return null;

  const absolute = (path: string) =>
    /^https?:\/\//.test(path) ? path : `${base}${path.startsWith('/') ? path : `/${path}`}`;

  // A one-item list is noise in the index even where the trail is worth
  // rendering. Every crumb is listed, but only a crumb with an href carries an
  // `item`: schema.org's documented shape for the page you are already on is a
  // final `ListItem` with a name and no URL, so dropping it would lose the leaf
  // the trail exists to name.
  const structured = base && items.length > 1;

  return (
    <>
      <nav aria-label="Breadcrumb" className={`breadcrumbs ${className}`.trim()}>
        <ol>
          {items.map((item, i) => {
            const isLast = i === items.length - 1;
            const Last = lastAs === 'h1' ? 'h1' : 'span';
            return (
              <Fragment key={item.href ?? `${item.label}-${i}`}>
                {i > 0 && <li className="separator" aria-hidden="true">/</li>}
                <li>
                  {isLast ? (
                    <Last
                      className={lastAs === 'h1' ? 'breadcrumb-h1' : 'breadcrumb-current'}
                      aria-current="page"
                    >
                      {item.label}
                    </Last>
                  ) : item.href ? (
                    <Link href={item.href} className="breadcrumb-link" title={item.label}>
                      {item.label}
                    </Link>
                  ) : (
                    <span className="breadcrumb-current">{item.label}</span>
                  )}
                </li>
              </Fragment>
            );
          })}
        </ol>
      </nav>
      {structured && (
        <JsonLd
          data={{
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            itemListElement: items.map((item, i) => ({
              '@type': 'ListItem',
              position: i + 1,
              name: item.label,
              ...(item.href ? { item: absolute(item.href) } : {}),
            })),
          }}
        />
      )}
    </>
  );
}

/**
 * The standard page-top row: the trail, plus optional right-aligned actions.
 *
 * The column it sits in is the one its route declares — the row reads the
 * page's own max-width by inheritance, so a trail cannot disagree with
 * the content it titles.
 */
export function BreadcrumbsRow({
  actions,
  className = '',
  ...props
}: BreadcrumbsProps & { actions?: ReactNode }) {
  return (
    <div className={`breadcrumbs-row ${actions ? 'spread' : ''} ${className}`.trim()}>
      <Breadcrumbs {...props} />
      {actions}
    </div>
  );
}

// ---- pager --------------------------------------------------------------------

export interface PagerProps {
  /** The page showing, from 1. */
  page: number;
  total: number;
  /** Each page's address: the steps are links and the pager ships no JavaScript. */
  href?: (page: number) => string;
  /** Or what a step does: the steps are buttons. A carousel passes `go`. */
  onPage?: (page: number) => void;
  /** Step round from either end, as a carousel does, instead of stopping. */
  wrap?: boolean;
  /** Both steps inert, as while the next page loads. */
  disabled?: boolean;
  /** What one page is: the middle reads "<noun> 2 of 9", the steps "Previous <noun>". */
  noun?: string;
  prev?: ReactNode;
  next?: ReactNode;
  /** The steps at the ends of the line rather than beside the count. */
  spread?: boolean;
  /** The landmark's name, when the page has more than one pager. */
  label?: string;
  link?: WikiLinkComponent;
  className?: string;
}

const Arrow = ({ children }: { children: string }) => <span aria-hidden="true">{children}</span>;

/**
 * "← Previous · Page 2 of 9 · Next →", for search results and for a carousel.
 *
 * Three sites wrote this line by hand, two of them for paged results (one with
 * links, one with buttons) and one for a snap row of points, and each stopped
 * at the ends differently: a disabled button, an empty span, a wrap. Here a
 * step at an end with nowhere to go stays in place, inert, so the count does
 * not jump sideways on the first and last page.
 */
export function Pager({
  page,
  total,
  href,
  onPage,
  wrap = false,
  disabled = false,
  noun = 'Page',
  prev = <><Arrow>←</Arrow> Previous</>,
  next = <>Next <Arrow>→</Arrow></>,
  spread = false,
  label = `${noun}s`,
  link: Link = Anchor,
  className = '',
}: PagerProps) {
  if (total < 2) return null;
  const to = (dir: 1 | -1) => {
    const p = page + dir;
    return p >= 1 && p <= total ? p : wrap ? (p < 1 ? total : 1) : null;
  };
  const name = noun.toLowerCase();
  const step = (dir: 1 | -1, content: ReactNode) => {
    const p = disabled ? null : to(dir);
    const aria = `${dir < 0 ? 'Previous' : 'Next'} ${name}`;
    if (onPage) {
      return (
        <button type="button" className="pager-step" aria-label={aria} disabled={p === null} onClick={() => p !== null && onPage(p)}>
          {content}
        </button>
      );
    }
    return p !== null && href ? (
      <Link href={href(p)} className="pager-step" rel={dir < 0 ? 'prev' : 'next'}>{content}</Link>
    ) : (
      <span className="pager-step" aria-disabled="true">{content}</span>
    );
  };
  return (
    <nav aria-label={label} className={`pager ${className}`.trim()} data-spread={spread || undefined}>
      {step(-1, prev)}
      <span className="pager-count" aria-live={onPage ? 'polite' : undefined}>
        {noun} {page} of {total}
      </span>
      {step(1, next)}
    </nav>
  );
}

export interface SnapDotsProps {
  count: number;
  /** The item showing, from 0: `useSnapRow`'s `at`. */
  at: number;
  /** `useSnapRow`'s `go`: each dot becomes a button. Omit it for dots that only count. */
  onGo?: (i: number) => void;
  /** What one item is, for each button's name: "Go to <noun> 3". */
  noun?: string;
  className?: string;
}

/**
 * A snap row's dots, one per item, the one in view marked.
 *
 * With `onGo` each is a button, named, its 0.5rem mark in a 1.5rem target; on a
 * card whose whole face is already a link it is only a count, `aria-hidden`.
 * The mark is the `<i>` either way, so one rule draws both, and `data-on`
 * marks the current one in both.
 */
export function SnapDots({ count, at, onGo, noun = 'item', className = '' }: SnapDotsProps) {
  if (count < 2) return null;
  const cls = `snap-dots ${className}`.trim();
  const dots = Array.from({ length: count }, (_, i) => i);
  return onGo ? (
    <span className={cls}>
      {dots.map(i => (
        <button key={i} type="button" aria-label={`Go to ${noun} ${i + 1}`} aria-current={i === at || undefined} data-on={i === at || undefined} onClick={() => onGo(i)}>
          <i />
        </button>
      ))}
    </span>
  ) : (
    <span className={cls} aria-hidden="true">
      {dots.map(i => <i key={i} data-on={i === at || undefined} />)}
    </span>
  );
}

// ---- infobox -------------------------------------------------------------------

export interface InfoboxAsideProps {
  /** The landmark's accessible name, e.g. `Key facts about ${title}`. */
  label: string;
  /** Wikipedia's "Part of a series on": the topic's main article. */
  series?: { title: string; href: string } | null;
  link?: WikiLinkComponent;
  /** Added to `infobox`, for a design system's layout utility. */
  className?: string;
  children?: ReactNode;
}

/**
 * The facts panel beside an article. Named, because two of the three asides
 * this replaced had no accessible name, and a complementary landmark without
 * one reads as "complementary" and nothing else.
 */
export function InfoboxAside({ label, series, link: Link = Anchor, className, children }: InfoboxAsideProps) {
  return (
    <aside className={className ? `infobox ${className}` : 'infobox'} aria-label={label}>
      {series && (
        <div className="infobox-series">
          <span>Part of a series on</span>
          <Link href={series.href}>{series.title}</Link>
        </div>
      )}
      {children}
    </aside>
  );
}

/** A file or library suffix no domain ends in: "Node.js", "Cargo.toml" and "setup.py" name things, not sites. */
const NOT_A_TLD = /^(c?js|mjs|jsx|tsx?|json|ya?ml|toml|md|py|sol|wasm|txt|html?|css|pdf|png|jpe?g|svg|gif)$/i;

const looksLikeUrl = (v: string, type: string) => {
  if (type === 'url' || /^https?:\/\//i.test(v)) return true;
  const bare = /^[^\s/]+\.([a-z]{2,})(\/\S*)?$/i.exec(v);
  return !!bare && !NOT_A_TLD.test(bare[1]!);
};

function externalLink(v: string): ReactNode {
  const href = safeLinkHref(/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`);
  if (!href) return v;
  return (
    <a href={href} target="_blank" rel="noopener">
      {v.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '')}
    </a>
  );
}

/**
 * A metadata value for reading: a date as its day, a URL (or a bare domain) as
 * an external link, and a `<br>`-separated list as lines. Rendered as React
 * nodes, never interpolated into markup: the string builders this replaced had
 * to re-escape a `"` that would otherwise close an href, and one did not.
 */
export function formatFactValue(value: string, type: string): ReactNode {
  if (type === 'date') {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return isoDate(new Date(t));
  }
  const parts = value.split(/<br\s*\/?>/i).map(s => s.trim()).filter(Boolean);
  if (parts.length > 1) {
    return parts.map((part, i) => (
      <Fragment key={i}>
        {i > 0 && <br />}
        {looksLikeUrl(part, type) ? externalLink(part) : part}
      </Fragment>
    ));
  }
  return looksLikeUrl(value, type) ? externalLink(value) : value;
}

export interface InfoboxFactsProps {
  /** `metadataRows`, or any rows of the same shape a wiki derives itself. */
  rows: readonly Pick<MetadataRow, 'label' | 'value' | 'type' | 'href'>[];
  link?: WikiLinkComponent;
  /** Overrides how a row without an `href` is shown. */
  formatValue?: (value: string, type: string) => ReactNode;
}

/**
 * The derived facts table. A row with an `href` links into the facet view that
 * shares its value — the way into the set, not dead text.
 */
export function InfoboxFacts({ rows, link: Link = Anchor, formatValue = formatFactValue }: InfoboxFactsProps) {
  if (!rows.length) return null;
  return (
    <table className="infobox-facts">
      <tbody>
        {rows.map(row => (
          <tr key={row.label}>
            <th scope="row">{row.label}</th>
            <td>{row.href ? <Link href={row.href}>{row.value}</Link> : formatValue(row.value, row.type)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const ACTION_LABEL: Record<BlockChange['action'], string> = {
  added: 'Added',
  removed: 'Removed',
  modified: 'Modified',
  moved: 'Moved',
};

export interface RevisionChangesProps {
  /** One revision's changes, from `historyChanges` or `withChanges` in `wiki-formant/history`. */
  changes: readonly HistoryChange[];
  /** What a block type is called where a reader sees it, such as the editor's label. Defaults to the type. */
  label?: (type: string) => string;
}

/**
 * What one revision changed, block by block, each prose leaf with its text
 * diff. Struck and added text are `<del>` and `<ins>`, which a screen reader
 * announces as such; their colours, and the action's, keyed on `data-action`,
 * are the importing stylesheet's.
 */
export function RevisionChanges({ changes, label = type => type }: RevisionChangesProps) {
  if (!changes.length) return null;
  return (
    <ul className="revision-changes">
      {changes.map((c, i) => (
        <li key={i} className="revision-change" data-action={c.action}>
          <span className="revision-change-action">{ACTION_LABEL[c.action]}</span>
          {` – ${label(c.type)} at ${blockLocation(c.path)}`}
          {c.leafDiff && (
            <p className="revision-diff">
              {c.leafDiff.map(([op, text], j) =>
                op === -1 ? <del key={j}>{text}</del> : op === 1 ? <ins key={j}>{text}</ins> : <span key={j}>{text}</span>,
              )}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

// ---- maintenance queues -------------------------------------------------------

export interface MaintenanceQueuesProps {
  queues: readonly MaintenanceQueue[];
  link?: WikiLinkComponent;
  /** Shown when every queue is empty. */
  empty?: ReactNode;
  /** The level each queue's heading takes. */
  headingLevel?: 'h2' | 'h3';
}

/**
 * `maintenanceQueues`' lists, a heading and a count each. The page around them
 * (its title, a sentence on what the queues are) is the wiki's.
 */
export function MaintenanceQueues({ queues, link: Link = Anchor, empty = <p>Nothing needs attention.</p>, headingLevel: H = 'h2' }: MaintenanceQueuesProps) {
  if (!queues.length) return <>{empty}</>;
  return (
    <>
      {queues.map(queue => (
        <section key={queue.key} className="maintenance-queue" aria-labelledby={`queue-${queue.key}`}>
          <H id={`queue-${queue.key}`}>
            {queue.title} <span className="maintenance-count">{queue.items.length}</span>
          </H>
          <p className="maintenance-description">{queue.description}</p>
          <ul className="maintenance-list">
            {queue.items.map(item => (
              <li key={item.href} className="maintenance-item">
                <Link href={item.href}>{item.title}</Link>
                <span className="maintenance-detail">
                  {item.tagPath ? `${item.tagPath} · ` : ''}
                  {item.detail}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

// ---- citation -----------------------------------------------------------------

export interface CiteProps {
  /** Who publishes the page: the site's name. */
  publisher: string;
  title: string;
  /** The day the page last changed, or was published where a wiki keeps that. */
  date: Date | string;
  /** The page's one canonical address. */
  url: string;
  className?: string;
}

/** The citation for a page, one line: `Publisher. "Title." October 22, 2026. url`, as acuiq2 first wrote it. */
const citation = ({ publisher, title, date, url }: Omit<CiteProps, 'className'>): string =>
  `${publisher}. "${title}." ${formatDay(date, { month: 'long' })}. ${url}`;

/**
 * "Cite" in an article's meta line, opening on the citation to copy. Shown,
 * not copied by a button, so it works with no script and a reader can take
 * part of it.
 */
export function Cite({ className = 'article-cite', ...page }: CiteProps) {
  return (
    <details className={className}>
      <summary>Cite</summary>
      <code>{citation(page)}</code>
    </details>
  );
}

// ---- article ------------------------------------------------------------------

export interface ArticleMetaProps {
  /** The day the page last changed: the visible twin of the JSON-LD's `dateModified`. */
  updated?: Date | string;
  /** In place of the date: a relative time, read on the client. */
  updatedLabel?: ReactNode;
  version?: string | null;
  /** How many revisions the page has; linked to its history where `historyHref` is set. */
  revisions?: number;
  historyHref?: string;
  /** The day its facts were last checked, where that differs from the last edit. */
  verified?: Date | string | null;
  /** The grant the page is under. A page under none states none. */
  license?: License;
  cite?: Omit<CiteProps, 'className'>;
  /** Items ahead of the date: who wrote it. */
  children?: ReactNode;
  link?: WikiLinkComponent;
  className?: string;
}

/**
 * An article's one provenance line, under its body: who, Updated, the
 * version, the revisions, Verified, the licence and Cite, dot-separated. Four
 * sites had each written it, under three class names and two separators.
 */
export function ArticleMeta({ updated, updatedLabel, version, revisions, historyHref, verified, license, cite, children, link: Link = Anchor, className = 'article-meta' }: ArticleMetaProps) {
  const count = revisions !== undefined && revisions > 0 && `${revisions} revision${revisions === 1 ? '' : 's'}`;
  return (
    <ul className={className}>
      {children && <li>{children}</li>}
      {(updatedLabel || updated) && (
        <li>{updatedLabel ?? <>Updated <time dateTime={isoDate(new Date(updated!))}>{formatDay(updated!, { month: 'long' })}</time></>}</li>
      )}
      {version && <li>v{version}</li>}
      {count && <li>{historyHref ? <Link href={historyHref}>{count}</Link> : count}</li>}
      {verified && <li>Verified {formatDay(verified, { month: 'long' })}</li>}
      {license && (
        <li>
          <a href={license.url} rel="license" title={license.name}>
            {license.spdx.replaceAll('-', ' ')}
          </a>
        </li>
      )}
      {cite && (
        <li>
          <Cite {...cite} />
        </li>
      )}
    </ul>
  );
}

/**
 * The body beside its facts: `.page-with-infobox`, the prose in
 * `.page-main-content` and the infobox after it, one column with the infobox
 * first below 768px of its column. With no infobox, the body alone.
 */
export function PageWithInfobox({ infobox, children, className }: { infobox?: ReactNode; children: ReactNode; className?: string }) {
  if (!infobox) return <>{children}</>;
  return (
    <div className={className ? `page-with-infobox ${className}` : 'page-with-infobox'}>
      <div className="page-main-content">{children}</div>
      {infobox}
    </div>
  );
}

// ---- section index --------------------------------------------------------------

export interface IndexCard {
  href: string;
  /** Text, or text with a search's words marked (`Highlight`). */
  title: ReactNode;
  /** A section card's sub-line; a page tile's tooltip, so it must then be text. */
  blurb?: ReactNode;
  glyph?: ReactNode;
  /** Pages beneath it, where it stands for a whole section. */
  count?: number;
  /** A page's `status` facet value, beside its title. */
  status?: ReactNode;
  /** A banner along its top: `CardBanner`. */
  thumb?: ReactNode;
}

export interface IndexGroup {
  title: ReactNode;
  /** The section's own page. Without one the head is a label. */
  href?: string;
  /** What the section holds, under its head. */
  blurb?: ReactNode;
  glyph?: ReactNode;
  count?: number;
  /** Its sections, as cards with a sub-line. */
  sections?: readonly IndexCard[];
  /** Its pages, as dense title tiles. */
  pages?: readonly IndexCard[];
  /** A closing link to `href`, where `pages` is only the first few: "All 33 pages". */
  more?: ReactNode;
}

/**
 * A section's card: glyph, title, status and count on one line, the blurb
 * under it, and a banner above them where it has one. The same card wherever a
 * section is listed, so a section looks the same from every page that lists it.
 */
export function IndexCardLink({ card, link: Link = Anchor }: { card: IndexCard; link?: WikiLinkComponent }) {
  const text = (
    <>
      <span className="wiki-card__head">
        {card.glyph && (
          <span className="wiki-card__glyph" aria-hidden>
            {card.glyph}
          </span>
        )}
        <span className="wiki-card__title">{card.title}</span>
        {card.status && <span className="wiki-card__status">{card.status}</span>}
        {card.count !== undefined && <span className="wiki-card__count">{card.count}</span>}
      </span>
      {card.blurb && <span className="wiki-card__blurb">{card.blurb}</span>}
    </>
  );
  return card.thumb ? (
    <Link href={card.href} className="wiki-card wiki-card--section wiki-card--thumb">
      {card.thumb}
      <span className="wiki-card__body">{text}</span>
    </Link>
  ) : (
    <Link href={card.href} className="wiki-card wiki-card--section">
      {text}
    </Link>
  );
}

/** Section cards in a grid of aligned rows. */
export function IndexCards({ cards, link }: { cards: readonly IndexCard[]; link?: WikiLinkComponent }) {
  return (
    <div className="wiki-grid wiki-grid--sections">
      {cards.map(card => (
        <IndexCardLink key={card.href} card={card} link={link} />
      ))}
    </div>
  );
}

/**
 * What a wiki front page or a section page lists below it (STRUCTURE.md S12):
 * one group per section, headed by a link to it and what it holds, then its
 * own sections as cards and its pages as title tiles (a page's blurb its
 * tooltip), every page once.
 * `level` is the heads' heading level.
 */
export function SectionIndex({ groups, level = 2, link: Link = Anchor, className }: { groups: readonly IndexGroup[]; level?: 2 | 3; link?: WikiLinkComponent; className?: string }) {
  const H = `h${level}` as const;
  return (
    <div className={className ? `wiki-cats ${className}` : 'wiki-cats'}>
      {groups.map((group, i) => {
        const head = (
          <>
            {group.glyph && (
              <span className="wiki-cat__glyph" aria-hidden>
                {group.glyph}
              </span>
            )}
            <H className="wiki-cat__title">{group.title}</H>
            {group.count !== undefined && <span className="wiki-cat__count">{group.count}</span>}
          </>
        );
        return (
          <section key={group.href ?? i} className="wiki-cat">
            {group.href ? (
              <Link href={group.href} className="wiki-cat__head">
                {head}
              </Link>
            ) : (
              <div className="wiki-cat__head">{head}</div>
            )}
            {group.blurb && <p className="wiki-cat__blurb">{group.blurb}</p>}
            {group.sections && group.sections.length > 0 && <IndexCards cards={group.sections} link={Link} />}
            {group.pages && group.pages.length > 0 && (
              <div className="wiki-grid">
                {group.pages.map(page => (
                  <Link key={page.href} href={page.href} title={typeof page.blurb === 'string' ? page.blurb : undefined} className="wiki-card">
                    <span className="wiki-card__title">{page.title}</span>
                  </Link>
                ))}
              </div>
            )}
            {group.more && group.href && (
              <Link href={group.href} className="wiki-cat__more">
                {group.more}
              </Link>
            )}
          </section>
        );
      })}
    </div>
  );
}

import { EmptyState } from './empty-state.js';
export { EmptyState, type EmptyStateProps } from './empty-state.js';

/**
 * `text` with every place `query` matched it in `<mark class="search-mark">`,
 * matched as the search matched (`highlightRanges`): every result list, the
 * typeahead's and the results page's, marks its titles and snippets with it.
 * `lead` starts the text at most that many characters before its first mark, at
 * a word and after an ellipsis, so a snippet clamped to a line or two keeps its
 * mark in sight.
 */
export function Highlight({ text, query, lead, className = 'search-mark' }: { text: string; query: string; lead?: number; className?: string }) {
  const ranges = highlightRanges(text, query);
  if (!ranges.length) return <>{text}</>;
  let at = 0;
  const out: ReactNode[] = [];
  const first = ranges[0]![0];
  if (lead !== undefined && first > lead) {
    const space = text.lastIndexOf(' ', first - lead);
    at = space === -1 ? first - lead : space + 1;
    out.push('…');
  }
  for (const [start, end] of ranges) {
    if (start > at) out.push(text.slice(at, start));
    out.push(
      <mark key={start} className={className}>
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

// ---- the document and the shell ---------------------------------------------

export interface SiteDocumentProps extends Omit<ComponentProps<'html'>, 'children'> {
  children: ReactNode;
  bodyClassName?: string;
  /** The site from `defineSite`: its agent-surface `<link>`s and JSON-LD graph. Omitted on a host whose tenants state their own. */
  site?: Pick<SiteDefinition, 'links' | 'graph'>;
  /** Count the page views (`Beacon`). Off where each tenant counts its own. */
  beacon?: boolean;
}

/**
 * The root layout's `<html>`: the rail's boot script first in the head, so a
 * rail the reader collapsed does not paint open and slide shut, then the
 * agent-surface links; the site graph and the page-view beacon first in the
 * body. `suppressHydrationWarning` because the boot script stamps
 * `data-sidebar` on `<html>` before React hydrates, so the server's HTML and the
 * browser's DOM differ by exactly that attribute. A CSP that hashes inline
 * scripts hashes `sidebarBootScript()`. Attributes other than the body's go on
 * `<html>`: the font variables.
 */
export function SiteDocument({ children, bodyClassName, site, beacon = true, lang = 'en', ...html }: SiteDocumentProps) {
  return (
    <html lang={lang} suppressHydrationWarning {...html}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: sidebarBootScript() }} />
        {site && <SiteLinks {...site.links} />}
      </head>
      <body className={bodyClassName}>
        {site && <JsonLd data={site.graph} />}
        {beacon && <Beacon />}
        {children}
      </body>
    </html>
  );
}

export interface SiteShellProps extends Omit<ComponentProps<'div'>, 'children'> {
  /** The header's contents: the shell draws the `header.app-header` around them. None, no header. */
  header?: ReactNode;
  /**
   * The site from `defineSite`: its `footer`, drawn as a `SiteFooter`, and its
   * `logo`. Given a logo, the shell leads the header with the rail toggle and
   * the mark as a link home, `.header-logo`, named for the site, ahead of
   * `header`: every header opened on those two, each written its own way.
   */
  site?: FooterSite & Pick<SiteDefinition, 'logo'> & { name?: string };
  /** In place of the site's footer: a `SiteFooter` with matter of the site's own, or a site's own `footer.app-footer`. */
  footer?: ReactNode;
  /** A site's router link, for the footer's own paths. */
  link?: WikiLinkComponent;
  children: ReactNode;
  className?: string;
  /**
   * The main is the column, `.page-frame`, so no page frames itself; a rail
   * under it takes the full width (`base.css`). False for a site that draws
   * its own column on `.app-main`.
   */
  frame?: boolean;
  /**
   * What stays pinned to the foot of the window on every route: a search, a
   * room, the way into a reference section. Drawn in `.dock`, a click-through
   * strip whose buttons are `.dock-button`.
   */
  dock?: ReactNode;
  /**
   * The boxes' class prefix: `app`, the default, is `base.css`'s
   * `.app-shell` > `.app-header`, `.app-main`. A host that draws a shell of its
   * own, as miow does each tenant's, names it here and keeps the landmarks.
   */
  prefix?: string;
}

/**
 * The four boxes `base.css` lays out, under the rail's shared state:
 * `.app-shell` > skip link, `header.app-header`, `main#main.app-main`, footer.
 * The rail's toggle is in the header on every route and the rail in a
 * section's layout, below `main`; `base.css` hides the toggle on a page with
 * no rail, and the state that spans the two sits around both. A `dock` is
 * pinned to the window's foot, and the `Toaster` that `toast()` fills is
 * mounted here, once for every site.
 */
export function SiteShell({ header, site, footer, link, children, className, frame = true, dock, prefix = 'app', ...shell }: SiteShellProps) {
  const Link = link ?? Anchor;
  const logo = site?.logo;
  return (
    <SidebarProvider>
      <div {...shell} className={className ? `${prefix}-shell ${className}` : `${prefix}-shell`}>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        {(header || logo) && (
          <header className={`${prefix}-header`}>
            {logo && (
              <>
                <RailToggle />
                <Link href="/" className="header-logo" aria-label={site?.name}>
                  {logo}
                </Link>
              </>
            )}
            {header}
          </header>
        )}
        <main id="main" className={frame ? `${prefix}-main page-frame` : `${prefix}-main`}>
          {children}
        </main>
        {footer === undefined && site?.footer ? <SiteFooter site={site} link={link} /> : footer}
        {dock && <div className="dock">{dock}</div>}
      </div>
      <Toaster />
    </SidebarProvider>
  );
}

export interface NotFoundProps {
  /** The site from `defineSite`: its `notFound` words. */
  site: Pick<SiteDefinition, 'notFound'>;
  /** A site's router link, for the way on. */
  link?: WikiLinkComponent;
  /** The way on's classes: `.btn-primary`, as `RouteError`'s Try again, unless given. */
  buttonClassName?: string;
}

/**
 * What `not-found.tsx` draws: "Page not found" as the page's one heading, the
 * site's line on it, and the way on, an `EmptyState` in `.not-found`. Four
 * sites had written four 404s, each with its own title, wrapper and button.
 */
export function NotFound({ site, link, buttonClassName = 'btn-primary' }: NotFoundProps) {
  const Link = link ?? Anchor;
  const home = site.notFound?.home ?? { href: '/', label: 'Home' };
  return (
    <EmptyState
      as="h1"
      title="Page not found"
      description={site.notFound?.description}
      action={<Link href={home.href} className={buttonClassName}>{home.label}</Link>}
      className="not-found"
    />
  );
}

/**
 * A category tree as rail links under `base`: each node a section, lit for the
 * pages beneath it, titled by its description, its children opening while the
 * reader is on its trail. A hidden node is left out with everything under it.
 * `glyph` draws a node's mark. Three rails had each walked their tree into links. Here rather than in
 * `wiki-formant/react`, so a server layout can call it.
 */
export function treeRailLinks<N extends WikiNode>(nodes: readonly N[], base = '', glyph?: (node: N) => ReactNode, parent = ''): RailLink[] {
  return nodes
    .filter(node => !node.hidden)
    .map(node => {
      const path = parent ? `${parent}/${node.slug}` : node.slug;
      return {
        href: `${base}/${path}`,
        label: node.name,
        title: node.description,
        glyph: glyph?.(node),
        tree: true,
        children: treeRailLinks((node.children ?? []) as readonly N[], base, glyph, path),
      };
    });
}

export interface DockLinkProps {
  href: string;
  /** Its name, and the tooltip a glyph needs. */
  label: string;
  /** The glyph. */
  children: ReactNode;
  /** `next/link`, or whatever navigates on this site. */
  link?: WikiLinkComponent;
}

/** A dock disc that is a link: the way into a section from every route. */
export function DockLink({ href, label, children, link: Link = Anchor }: DockLinkProps) {
  return (
    <Link href={href} aria-label={label} title={label} className="dock-button">
      {children}
    </Link>
  );
}

export interface SiteFooterLink {
  href: string;
  label: string;
}

type FooterSite = Pick<SiteDefinition, 'footer' | 'x'>;

export interface SiteFooterProps {
  /** The site from `defineSite`: its footer's links, owner, licence and note, and its X account. Each prop below stands in for its own. */
  site?: FooterSite;
  /** What nothing else on the page links to: about, policies, `llms.txt`. */
  links?: readonly SiteFooterLink[];
  /** The site's X account, last in the row as a follow link. */
  x?: XAccount;
  /** Who holds the copyright, set as `© <this year> <owner>` ahead of `note`. */
  owner?: string;
  /** The licence the content is under, named and linked after the owner. */
  license?: License;
  /** The closing line: a disclaimer, a credit. */
  note?: ReactNode;
  /** The site's own matter ahead of the links: a manifesto, a mission line. */
  children?: ReactNode;
  className?: string;
  /** A site's router link for its own paths; external and file links stay `<a>`. */
  link?: WikiLinkComponent;
}

/**
 * The foot of every page: the site's own matter, a row of links ending on the
 * X account, and a line naming the owner and the licence. Three sites had
 * written this by hand, one with a year that would have gone stale, one with
 * separators in the markup; `base.css` draws it on the `--ui-*` tokens.
 */
export function SiteFooter({
  site,
  links = site?.footer?.links ?? [],
  x = site?.x,
  owner = site?.footer?.owner,
  license = site?.footer?.license,
  note = site?.footer?.note,
  children,
  className,
  link: Link = Anchor,
}: SiteFooterProps) {
  return (
    <footer className={className ? `app-footer ${className}` : 'app-footer'}>
      <div className="page-frame app-footer__frame">
        {children}
        <nav className="app-footer__links" aria-label="Footer">
          {links.map(l =>
            l.href.startsWith('/') && !/\.\w+$/.test(l.href) ? (
              <Link key={l.href} href={l.href}>
                {l.label}
              </Link>
            ) : (
              <a key={l.href} href={l.href}>
                {l.label}
              </a>
            ),
          )}
          {x && <a {...followLinkProps(x)}>{x.label}</a>}
        </nav>
        {(owner || license || note) && (
          <div className="app-footer__note">
            {owner && <p>© {new Date().getFullYear()} {owner}.</p>}
            {license && (
              <p>
                Content licensed under{' '}
                <a href={license.url} rel="license">
                  {license.spdx.replaceAll('-', ' ')}
                </a>
                .
              </p>
            )}
            {typeof note === 'string' ? <p>{note}</p> : note}
          </div>
        )}
      </div>
    </footer>
  );
}

export interface RailFrameProps {
  rail: ReactNode;
  children: ReactNode;
  /**
   * Hover cards for the wiki links in the column (`WikiLinkPreview`), mounted
   * once beside it, or false for none. `endpoint` defaults to
   * `/api/wiki/preview` and `scope` to the column, `.wiki-layout__main`.
   */
  preview?: false | (Omit<WikiLinkPreviewProps, 'scope' | 'endpoint'> & { scope?: string; endpoint?: string });
}

/**
 * A rail beside its section's column, mounted by the section's layout so the
 * rail persists across the section's navigations: `.wiki-layout` > the rail
 * (`RailShell prefix="wiki-sidebar"`) and `.wiki-layout__main` > `.page-frame`.
 * The column is framed here, so no page under a rail frames itself.
 */
export function RailFrame({ rail, children, preview = {} }: RailFrameProps) {
  return (
    <>
      <div className="wiki-layout">
        {rail}
        <div className="wiki-layout__main">
          <div className="page-frame">{children}</div>
        </div>
      </div>
      {/* Outside the column it previews from: the card is fixed at viewport coordinates. */}
      {preview && <WikiLinkPreview {...preview} endpoint={preview.endpoint ?? '/api/wiki/preview'} scope={preview.scope ?? '.wiki-layout__main'} />}
    </>
  );
}
