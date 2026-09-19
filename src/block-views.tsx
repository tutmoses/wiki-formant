'use client';

// block-views.tsx — the block leaves the wikis share.
//
// Behind its own subpath for the reason `react.tsx` is: React is an OPTIONAL
// peer, so a consumer that only wants the taxonomy or the MCP transport still
// installs a package with no runtime dependencies.
//
// WHY THESE FIVE AND NOT THE SWITCH. The block union is per-repo and staying
// that way (see the Block Model note in the workspace CLAUDE.md) — a closed
// union is what makes `switch (block.type)` exhaustive, so a new block type is
// a compile error rather than a silent blank. What is NOT per-repo is what a
// codeTabs or a linkGrid LOOKS like once you have dispatched to it, down to the
// class names. So the dispatch stays with the caller and the leaves live here.
//
// The class names are NOT props. They are the shared convention every
// stylesheet implements, and making them configurable would let that convention
// fork. Everything that
// genuinely differs — the prose of a banner, whether references run through an
// HTML processor, the router's link — arrives as a prop.

import { Fragment, useState, type ReactNode } from 'react';
import type { CodeTab, LinkGridGroup, ReferenceItem, ResolvedPageRef, StatItem } from './blocks.js';
import { Anchor } from './react-server.js';
import type { WikiLinkComponent } from './react-server.js';
import { safeLinkHref } from './validation.js';
import { cx } from './html.js';
import { BANNER_LABELS, bannerVariant } from './text.js';


// ---- codeTabs ---------------------------------------------------------------

export interface CodeTabsViewProps {
  tabs: readonly CodeTab[];
  /**
   * Every tab's `code` has already been escaped and highlighted into markup on
   * the server, and is written as HTML. Only a wiki whose render path does that
   * for every tree reaching this view may pass it: without it, `code` is source
   * and renders escaped in a `<pre><code>`, which is the safe default.
   */
  highlighted?: boolean;
}

/**
 * Tabbed code samples. Every tab's body stays mounted and the inactive ones are
 * hidden rather than unmounted: remounting a highlighted panel would re-run
 * whatever the consumer's highlighter attached to it on every tab press.
 */
export function CodeTabsView({ tabs, highlighted = false }: CodeTabsViewProps) {
  const [activeTab, setActiveTab] = useState(0);
  if (!tabs.length) return null;

  return (
    <div className="code-tabs">
      <div className="code-tabs-list">
        {tabs.map((tab, i) => (
          <button
            key={i}
            type="button"
            className={cx('code-tabs-btn', i === activeTab && 'code-tabs-btn-active')}
            onClick={() => setActiveTab(i)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {/* The `hidden` attribute, not a utility class: a class reaches the page
          only if the site's Tailwind scans this package, and one did not. */}
      {tabs.map((tab, i) =>
        highlighted ? (
          <div key={i} className="code-tabs-panel" hidden={i !== activeTab} dangerouslySetInnerHTML={{ __html: tab.code }} />
        ) : (
          <div key={i} className="code-tabs-panel" hidden={i !== activeTab}>
            <pre>
              <code className={tab.language ? `language-${tab.language}` : undefined}>{tab.code}</code>
            </pre>
          </div>
        ),
      )}
    </div>
  );
}

// ---- columns ----------------------------------------------------------------

export interface ColumnsViewProps<B extends { id: string }> {
  columns: ReadonlyArray<{ id: string; blocks?: readonly B[] }>;
  gap?: 'sm' | 'md' | 'lg';
  align?: 'start' | 'center' | 'end' | 'stretch';
  /** The caller's own dispatch, because the block union is the caller's. */
  render: (block: B) => ReactNode;
}

/**
 * A row of columns, each holding blocks the caller renders.
 *
 * Children are wrapped in a `Fragment`, not a `<div>`. One repo used a div and
 * it was a layout bug rather than a style: `.column-view` is the flow context
 * its stylesheet spaces children in, and an extra element between them means
 * every gap rule inside a column silently matches nothing.
 *
 * Gap and alignment are data attributes that `wiki-formant/base.css` reads.
 * They were Tailwind utilities, which reached a page only if the site's
 * Tailwind scanned this package — and on one site `end` and `stretch` did not.
 */
export function ColumnsView<B extends { id: string }>({
  columns,
  gap = 'md',
  align = 'start',
  render,
}: ColumnsViewProps<B>) {
  return (
    <div className="columns-layout" data-gap={gap} data-align={align}>
      {columns.map(col => (
        <div key={col.id} className="column-view">
          {(col.blocks ?? []).map(bl => (
            <Fragment key={bl.id}>{render(bl)}</Fragment>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---- linkGrid ---------------------------------------------------------------

/**
 * Banded groups of link pills.
 *
 * A link whose href fails `safeLinkHref` is DROPPED, not rendered inert. These
 * hrefs are author-supplied, and a `javascript:` URL fails the http test above
 * — so without the guard it falls through to the router's link component, which
 * renders it looking like an ordinary pill and executes it on click.
 */
export function LinkGridView({
  groups,
  intro,
  link: Link = Anchor,
}: {
  groups?: readonly (LinkGridGroup & { id?: string })[];
  intro?: string;
  link?: WikiLinkComponent;
}) {
  return (
    <div className="link-grid">
      {intro && <p>{intro}</p>}
      {(groups ?? []).map((group, gi) => (
        <section key={group.id ?? gi} className="link-grid-group">
          <h3>{group.heading}</h3>
          {group.description && (
            <div
              className="link-grid-group-description"
              dangerouslySetInnerHTML={{ __html: group.description }}
            />
          )}
          <div className="link-grid-pills">
            {(group.links ?? []).map((item, i) => {
              const href = safeLinkHref(item.href);
              if (!href) return null;
              return /^https?:\/\//.test(href) ? (
                <a key={i} href={href} target="_blank" rel="noopener">{item.label}</a>
              ) : (
                <Link key={i} href={href}>{item.label}</Link>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

// ---- recentPages / pageList -------------------------------------------------

/**
 * A list of resolved page references — the body of a `recentPages` or
 * `pageList` block. A real list, with each age in a `<time>` carrying its ISO
 * date: the copies this replaced were bare `<div>` rows, one emitted a
 * `<time>` with no `dateTime`, and their empty states were three different
 * things (a sentence, a different sentence, nothing).
 *
 * `renderItem` replaces the row's inner markup for a wiki with its own row
 * component; the list, its semantics and the empty state stay here.
 */
export function PageRefsView({
  refs,
  empty,
  link: Link = Anchor,
  renderItem,
}: {
  refs: readonly ResolvedPageRef[];
  /** Said when there are none. Omit to render nothing. */
  empty?: string;
  link?: WikiLinkComponent;
  renderItem?: (ref: ResolvedPageRef) => ReactNode;
}) {
  if (!refs.length) return empty ? <p className="page-refs-empty">{empty}</p> : null;
  return (
    <ul className="page-refs">
      {refs.map(ref => (
        <li key={ref.href}>
          {renderItem ? (
            renderItem(ref)
          ) : (
            <Link href={ref.href} className="page-ref">
              <span className="page-ref-title">{ref.title}</span>
              {ref.timeAgo &&
                (ref.updated ? (
                  <time className="page-ref-time" dateTime={ref.updated}>
                    {ref.timeAgo}
                  </time>
                ) : (
                  <span className="page-ref-time">{ref.timeAgo}</span>
                ))}
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}

// ---- references -------------------------------------------------------------

/**
 * The numbered citation list, with the `#cite-n` back-links the inline markers
 * point at. `processHtml` is a prop because only one wiki runs reference text
 * through its HTML pipeline, and running it in the other would rewrite anchors
 * that were minted under different rules.
 */
export function ReferencesView({
  items,
  title = 'References',
  processHtml = (html: string) => html,
}: {
  items?: readonly (ReferenceItem & { id?: string })[];
  title?: string;
  processHtml?: (html: string) => string;
}) {
  const rows = items ?? [];
  if (!rows.length) return null;

  return (
    <section className="references-block" aria-labelledby="references-heading">
      <h2 id="references-heading">{title}</h2>
      <ol className="references-list">
        {rows.map((item, i) => {
          const url = safeLinkHref(item.url);
          return (
            <li key={item.id ?? i} id={`ref-${i + 1}`} className="reference-item">
              <a href={`#cite-${i + 1}`} className="ref-backlink" aria-label="Back to citation">↑</a>{' '}
              <span dangerouslySetInnerHTML={{ __html: processHtml(item.text) }} />
              {url && (
                <>
                  {' '}
                  <a href={url} target="_blank" rel="noopener" className="reference-link" aria-label="Open source">↗</a>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ---- stats ------------------------------------------------------------------

/**
 * A row of measured figures.
 *
 * The column count is a class (`stat-grid-4`), never an inline
 * `gridTemplateColumns`. One repo did it inline, which put a layout decision
 * outside the stylesheet that owns every other one — invisible to the dead-class
 * check, unreachable from a media query, and so a four-up row that could not
 * become a two-up row on a phone.
 */
export function StatsView({
  items,
  columns = 4,
}: {
  items?: readonly (StatItem & { id?: string })[];
  columns?: number;
}) {
  const rows = items ?? [];
  if (!rows.length) return null;

  return (
    <div className={cx('stat-grid', `stat-grid-${columns}`)}>
      {rows.map((item, i) => (
        <div key={item.id ?? i} className="stat-card">
          <span className="stat-value">
            {item.value}
            {item.suffix && <span className="stat-suffix">{item.suffix}</span>}
          </span>
          <span className="stat-label">{item.label}</span>
        </div>
      ))}
    </div>
  );
}

// ---- banner -----------------------------------------------------------------

/**
 * A maintenance notice.
 *
 * The label is `BANNER_LABELS`, looked up here: three renderers each did the
 * unknown-variant fallback and the lookup, and one restated all six labels.
 * The fallback `message` arrives as a prop because it is the wiki's editorial
 * voice — "You can help RADIX Wiki by expanding it" has a name in it. `icon`
 * is optional: a component library that hardcoded an icon set would make its
 * consumers install that icon set.
 */
export function BannerView({
  variant,
  text,
  message,
  icon,
}: {
  variant: string;
  text?: string | null;
  message: string;
  icon?: ReactNode;
}) {
  const known = bannerVariant(variant);
  return (
    <div className={cx('editorial-banner', `editorial-banner-${known}`)} role="note">
      {icon}
      <p className="editorial-banner-body">
        <strong>{BANNER_LABELS[known]}.</strong> {text?.trim() || message}
      </p>
    </div>
  );
}
