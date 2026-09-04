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
  children?: ReactNode;
}

export type WikiLinkComponent = ComponentType<WikiLinkProps>;

/** The default for anything that does not need client-side navigation. */
const Anchor: WikiLinkComponent = ({ href, className, children }) =>
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
 * take that attribute. Two of the three copies this replaces had it wrong.
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

// ---- breadcrumbs ------------------------------------------------------------

export interface BreadcrumbItem {
  label: string;
  href: string;
}

export interface BreadcrumbsProps {
  items: BreadcrumbItem[];
  /**
   * Origin the JSON-LD `item` URLs are resolved against, without a trailing
   * slash. Structured-data URLs must be absolute — Google rejects relative
   * paths — and this package cannot know the site it is rendering for.
   */
  base: string;
  className?: string;
  /** Defaults to a plain `<a>`, which is what a crumb trail wants. */
  link?: WikiLinkComponent;
}

/**
 * The trail, plus the `BreadcrumbList` that makes it a rich result.
 *
 * The two are emitted together on purpose: a trail whose JSON-LD is written
 * somewhere else is a trail that will one day disagree with its own markup, and
 * Google penalises exactly that.
 *
 * Renders nothing for a single crumb. One item is not a trail, and a
 * `BreadcrumbList` of length one is noise in the index.
 */
export function Breadcrumbs({ items, base, className = '', link: Link = Anchor }: BreadcrumbsProps) {
  if (!items || items.length <= 1) return null;

  const absolute = (path: string) =>
    /^https?:\/\//.test(path) ? path : `${base}${path.startsWith('/') ? path : `/${path}`}`;

  return (
    <>
      <nav aria-label="Breadcrumb" className={`breadcrumbs ${className}`}>
        <ol>
          {items.map((item, i) => (
            <Fragment key={item.href}>
              {i > 0 && <li className="separator" aria-hidden="true">/</li>}
              <li>
                {i === items.length - 1 ? (
                  <span className="pl-4" aria-current="page">{item.label}</span>
                ) : (
                  <Link href={item.href}>{item.label}</Link>
                )}
              </li>
            </Fragment>
          ))}
        </ol>
      </nav>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": items.map((item, i) => ({
          "@type": "ListItem", "position": i + 1, "name": item.label, "item": absolute(item.href)
        }))
      }) }} />
    </>
  );
}
