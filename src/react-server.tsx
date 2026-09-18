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
import type { ComponentType, ReactNode } from 'react';
import type { Control, FacetControlGroup } from './taxonomy.js';

/**
 * The shape a router's link component has to satisfy here.
 *
 * Deliberately the intersection the three rails and three facet bars actually
 * use, not a re-declaration of `AnchorHTMLAttributes`: a wider surface would
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
  children?: ReactNode;
}

export type WikiLinkComponent = ComponentType<WikiLinkProps>;

/**
 * The default for anything that does not need client-side navigation.
 *
 * Exported because `block-views` renders links too and had declared the same
 * three lines; a default that exists twice is a default that can diverge.
 */
export const Anchor: WikiLinkComponent = ({ href, className, children }) =>
  <a href={href} className={className}>{children}</a>;

// ---- facet bar --------------------------------------------------------------

/**
 * Class names differ per wiki and always will — unlike the rail's `wiki-rail__*`
 * tree, which is a shared convention, these are each design system's own words
 * for a chip and a row. Defaults are given so a consumer that shares them writes
 * nothing.
 */
export interface FacetBarClassNames {
  root?: string;
  row?: string;
  label?: string;
  control?: string;
  controlActive?: string;
}

export interface FacetBarProps {
  link: WikiLinkComponent;
  facets: FacetControlGroup[];
  letters: Control[];
  /** The label on the A–Z row. */
  alphaLabel?: string;
  classNames?: FacetBarClassNames;
}

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
  classNames = {},
}: FacetBarProps) {
  if (!facets.length && !letters.length) return null;

  const {
    root = 'stack tight',
    row = 'cluster',
    label = 'form-label',
    control = 'tag',
    controlActive = 'tag tag-removable',
  } = classNames;

  return (
    <div className={root}>
      {facets.map(facet => (
        <div key={facet.key} className={row}>
          <span className={label}>{facet.label}</span>
          {facet.options.map(option => (
            <Link
              key={option.value}
              href={option.href}
              className={option.active ? controlActive : control}
              aria-current={option.active ? 'true' : undefined}
            >
              {option.value} ({option.count})
            </Link>
          ))}
        </div>
      ))}

      {letters.length > 0 && (
        <div className={row}>
          <span className={label}>{alphaLabel}</span>
          {letters.map(letter => (
            <Link
              key={letter.value || 'all'}
              href={letter.href}
              className={letter.active ? controlActive : control}
              aria-current={letter.active ? 'true' : undefined}
            >
              {letter.label} ({letter.count})
            </Link>
          ))}
        </div>
      )}
    </div>
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
 */
export function jsonLdScript(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

/** A `<script type="application/ld+json">` for `data`, escaped by `jsonLdScript`. */
export function JsonLd({ data }: { data: unknown }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(data) }} />;
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

// ---- previous / next --------------------------------------------------------

/** One end of the foot nav: where it goes and what it is called. */
export interface PageNavRef {
  title: string;
  href: string;
}

export interface PageNavProps {
  prev?: PageNavRef | null;
  next?: PageNavRef | null;
  link?: WikiLinkComponent;
  /** The landmark's accessible name. */
  label?: string;
  prevLabel?: string;
  nextLabel?: string;
  /**
   * The arrows. `ReactNode` rather than a string because both wikis draw them
   * with an icon component, and this package is not acquiring an icon peer to
   * hold two glyphs.
   */
  prevGlyph?: ReactNode;
  nextGlyph?: ReactNode;
}

/**
 * The sequential read at the foot of an article — the move the infobox rail's
 * lateral links do not cover.
 *
 * Ordering is entirely the caller's; pair this with `adjacentPages` from
 * `wiki-formant/pagination` over a list you already hold.
 *
 * The `page-nav__*` class names are NOT props: they are the convention every
 * stylesheet implements, and making them configurable is how a convention
 * forks. The empty `<div>` holds the first article's left column so the next
 * link stays in the right one.
 */
export function PageNav({
  prev,
  next,
  link: Link = Anchor,
  label = 'Article navigation',
  prevLabel = 'Previous',
  nextLabel = 'Next',
  prevGlyph = '\u2190',
  nextGlyph = '\u2192',
}: PageNavProps) {
  if (!prev && !next) return null;
  return (
    <nav className="page-nav" aria-label={label}>
      {prev ? (
        <Link href={prev.href} className="page-nav-link" rel="prev">
          <span className="page-nav-label">{prevGlyph}{prevLabel}</span>
          <span className="page-nav-title">{prev.title}</span>
        </Link>
      ) : (
        <div />
      )}
      {next && (
        <Link href={next.href} className="page-nav-link page-nav-link--end" rel="next">
          <span className="page-nav-label page-nav-label--end">{nextLabel}{nextGlyph}</span>
          <span className="page-nav-title">{next.title}</span>
        </Link>
      )}
    </nav>
  );
}
