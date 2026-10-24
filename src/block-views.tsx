'use client';

// block-views.tsx — the block leaves the wikis share.
//
// Behind its own subpath for the reason `react.tsx` is: React is an optional
// peer, so a consumer that only wants the taxonomy or the MCP transport needs no React.
//
// WHY THE LEAVES AND NOT THE SWITCH. The block union is per-repo and staying
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

import { Fragment, useState, useSyncExternalStore, type ImgHTMLAttributes, type ReactNode } from 'react';
import { eventBegun, eventWhen, splitEvents, today } from './blocks.js';
import type { CodeTab, EventItem, LinkGridGroup, PlaceItem, ReferenceItem, ResolvedPageRef, StatItem } from './blocks.js';
import { clock, DEFAULT_ZONE, hoursRows, mapEmbed, mapHref, openState, type Hours } from './hours.js';
import { Anchor } from './react-server.js';
import type { WikiLinkComponent } from './react-server.js';
import { safeLinkHref } from './validation.js';
import { cx } from './html.js';
import { BANNER_LABELS, BANNER_MESSAGES, bannerVariant } from './text.js';


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
  id,
  items,
  title = 'References',
  processHtml = (html: string) => html,
}: {
  /**
   * The block's id, which keys the heading's: `references-<id>`. Without it the
   * heading is `references-heading`, which a second references block on the
   * page would repeat, labelling both sections with the first one's heading.
   */
  id?: string;
  items?: readonly (ReferenceItem & { id?: string })[];
  title?: string;
  processHtml?: (html: string) => string;
}) {
  const rows = items ?? [];
  if (!rows.length) return null;
  const headingId = id ? `references-${id}` : 'references-heading';

  return (
    <section className="references-block" aria-labelledby={headingId}>
      <h2 id={headingId}>{title}</h2>
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

// ---- testimonial ------------------------------------------------------------

export interface TestimonialViewProps {
  quote: string;
  author: string;
  role?: string;
  avatarUrl?: string;
  /**
   * The photo's sized `<img>` attributes, for a site with an image pipeline.
   * Data, not a function: a server component renders this client view.
   */
  photo?: Pick<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcSet' | 'sizes'>;
}

/** Someone's words over who said them, with their photo when there is one. */
export function TestimonialView({ quote, author, role, avatarUrl, photo }: TestimonialViewProps) {
  if (!quote.trim()) return null;
  const src = avatarUrl && safeLinkHref(avatarUrl);
  return (
    <figure className="testimonial">
      <blockquote>{quote}</blockquote>
      <figcaption>
        {src && <img src={src} {...photo} alt="" loading="lazy" />}
        <span>
          <strong>{author}</strong>
          {role && <small>{role}</small>}
        </span>
      </figcaption>
    </figure>
  );
}

// ---- events -----------------------------------------------------------------

const still = () => () => {};

export interface EventsViewProps {
  items: readonly (EventItem & { id?: string })[];
  /** The heading over those to come or on now. Default `Upcoming`. */
  upcoming?: string | null;
  /** The heading over those that have ended. Default `Past`. */
  past?: string | null;
  /**
   * The day the server split them by, `today()` where it rendered. A page is
   * drawn by that day, so hydration matches it, then by the visitor's own: a
   * cached page can be a day old, and a show that closed since then is past.
   * Omitted, the server and the browser each use their own clock.
   */
  day?: string | null;
}

/**
 * Events under two `h2`s, those to come or on now soonest first and those that
 * have ended latest first, as `section.events` holding an `ol.event-list` under
 * each heading. A row is the `<time>` and a `span` of the event's inline HTML,
 * with `small.event-now` on one that has begun. `base.css` sets every row's
 * dates in one column shared by both lists. The text is written as HTML, so it
 * reaches here through `sanitizeCoreLeaf`, as a reference's does.
 */
export function EventsView({ items, upcoming, past, day }: EventsViewProps) {
  const now = useSyncExternalStore(still, today, () => day || today());
  const split = splitEvents(items, now);
  return (
    <section className="events">
      {(
        [
          [upcoming || 'Upcoming', split.upcoming],
          [past || 'Past', split.past],
        ] as const
      ).map(([heading, rows], ended) =>
        rows.length ? (
          <Fragment key={ended}>
            <h2>{heading}</h2>
            <ol className="event-list">
              {rows.map((e, i) => (
                <li key={e.id ?? i}>
                  <time dateTime={e.date}>{eventWhen(e)}</time>
                  <span>
                    <span dangerouslySetInnerHTML={{ __html: e.text }} />
                    {!ended && eventBegun(e, now) && <small className="event-now">Now on</small>}
                  </span>
                </li>
              ))}
            </ol>
          </Fragment>
        ) : null,
      )}
    </section>
  );
}

// ---- locations --------------------------------------------------------------

const everyMinute = (tick: () => void) => {
  const timer = setInterval(tick, 60_000);
  return () => clearInterval(timer);
};

/**
 * A place's week of hours, with whether it is open and today's row marked by
 * its own clock. A cached page cannot know the moment it is read, so the
 * server draws the hours alone and the visitor's browser says the rest.
 */
export function PlaceHours({ hours, timeZone = DEFAULT_ZONE }: { hours: readonly Hours[]; timeZone?: string }) {
  const now = useSyncExternalStore(everyMinute, () => clock(new Date(), timeZone).minute, () => null);
  const state = now === null ? null : openState([...hours], now);
  const day = now === null ? null : clock(new Date(), timeZone).day;
  return (
    <>
      {state && (
        <p className="place-state" data-open={state.open || undefined}>
          {state.words}
        </p>
      )}
      <table className="place-hours">
        <tbody>
          {hoursRows([...hours]).map(r => (
            <tr key={r.label} aria-current={day && r.days.includes(day) ? 'date' : undefined}>
              <th scope="row">{r.label}</th>
              <td>{r.times}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export interface LocationsViewProps {
  /** An h2 over the places, whose names are then h3s; unset, each name is an h2. */
  heading?: string | null;
  /** A map of each address under it. */
  map?: boolean | null;
  /**
   * The places. `photo` is a picture's sized `<img>` attributes, for a site
   * with an image pipeline: data, not a function, since a server component
   * renders this client view.
   */
  items: readonly (PlaceItem & { id?: string; photo?: Pick<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcSet' | 'sizes'> })[];
}

/**
 * Where a business is and when it is open, as `section.locations` holding
 * `ul.places`, a `li.place` for each: its picture (`.place-picture`), its name,
 * its `address` (linked to its map), whether it is open now
 * (`.place-state[data-open]`) over its week of hours (`table.place-hours`,
 * today's row `aria-current`), its note, its phone and email
 * (`.place-contact`) and, with `map`, an embedded map (`.place-map`). The note
 * is written as HTML, so it reaches here through `sanitizeCoreLeaf`.
 */
export function LocationsView({ heading, map, items }: LocationsViewProps) {
  const Name = heading ? 'h3' : 'h2';
  return (
    <section className="locations">
      {heading && <h2>{heading}</h2>}
      <ul className="places">
        {items.map((p, i) => {
          const link = safeLinkHref(mapHref(p));
          const image = p.image && safeLinkHref(p.image);
          return (
            <li key={p.id ?? i} className="place">
              {image && <img src={image} {...p.photo} alt="" className="place-picture" loading="lazy" />}
              {p.name && <Name>{p.name}</Name>}
              {p.address && <address>{link ? <a href={link}>{p.address.trim()}</a> : p.address.trim()}</address>}
              {!!p.hours?.length && <PlaceHours hours={p.hours} timeZone={p.timeZone} />}
              {p.note && <p dangerouslySetInnerHTML={{ __html: p.note }} />}
              {(p.phone || p.email) && (
                <p className="place-contact">
                  {p.phone && <a href={`tel:${p.phone.replace(/[^\d+]/g, '')}`}>{p.phone}</a>}
                  {p.email && <a href={`mailto:${p.email}`}>{p.email}</a>}
                </p>
              )}
              {map && p.address && (
                <iframe
                  className="place-map"
                  src={mapEmbed({ address: p.address, map: p.map })}
                  title={`Map of ${p.name || p.address.split('\n')[0]}`}
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
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
 * consumers install that icon set. `policy` is the wiki's page for the
 * standard the notice enforces; given, the label links to it, so a reader who
 * meets "Needs citations" can find out what a citation has to be.
 */
export function BannerView({
  variant,
  text,
  message,
  icon,
  policy,
}: {
  variant: string;
  text?: string | null;
  /** The sentence when the block has none. Defaults to `BANNER_MESSAGES`. */
  message?: string;
  icon?: ReactNode;
  policy?: string;
}) {
  const known = bannerVariant(variant);
  message ??= BANNER_MESSAGES[known];
  const label = BANNER_LABELS[known];
  return (
    <div className={cx('editorial-banner', `editorial-banner-${known}`)} role="note">
      {icon}
      <p className="editorial-banner-body">
        <strong>{policy ? <a href={policy}>{label}</a> : label}.</strong> {text?.trim() || message}
      </p>
    </div>
  );
}
