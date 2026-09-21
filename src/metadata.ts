// metadata.ts — one page's canonical, markdown twin, Open Graph and Twitter
// card, from one input.
//
// Next *replaces* rather than merges these objects per route segment. It does
// fill a missing twitter title, description and image from `openGraph`, but
// only when no `twitter` object was inherited — so under a layout that sets its
// own card, a page that sets openGraph and forgets twitter shows the layout's
// generic card, and a page that restates `alternates` for its twin clobbers its
// canonical. Two
// wikis wrote a helper around exactly that and covered different halves: one
// had the twin and no siteName, the other the siteName and no twin. The third
// wrote each page's metadata by hand.
//
// Plain objects in the shape Next's `Metadata` wants, so no `next` import.
//
// The schema.org nodes live here too, because they state the same facts to a
// different reader. Three wikis built their Article and CollectionPage nodes
// by hand and each dropped something the others kept: two shipped articles
// with no image while their og:image named a card, one listed citations, one
// collection page had no ItemList at all.

import { decodeEntities } from './markdown.js';
import type { ReferenceItem } from './blocks.js';

export interface ArticleMeta {
  publishedTime?: string;
  modifiedTime?: string;
  section?: string;
  tags?: string[];
}

export interface PageMetadataOptions {
  /** The social title. */
  title: string;
  description?: string;
  /** Absolute canonical URL. Omit on a page that should not declare one (a layout default). */
  url?: string;
  type?: 'website' | 'article';
  /** Absolute URL of the card. Omit to let a file-convention `opengraph-image` supply it. */
  image?: string;
  /** Its intrinsic size. Defaults to the 1200×630 of a summary_large_image card. */
  imageSize?: { width: number; height: number };
  /** Defaults to `title`. */
  imageAlt?: string;
  siteName?: string;
  locale?: string;
  /** `@handle`, as both site and creator. */
  handle?: string;
  /**
   * Advertise the page's markdown twin at `${url}.md`, beside the canonical —
   * the only place it can go, since a separate `alternates` would replace this
   * one. Pages only: a section or index has no twin.
   */
  markdownTwin?: boolean;
  /** Open Graph article fields, for `type: 'article'`. */
  article?: ArticleMeta;
}

export function pageMetadata(o: PageMetadataOptions) {
  const { title, description, url, type = 'website', image, imageSize = { width: 1200, height: 630 }, siteName, locale, handle, markdownTwin, article } = o;
  const images = image ? [{ url: image, ...imageSize, alt: o.imageAlt ?? title }] : undefined;
  return {
    ...(url
      ? {
          alternates: {
            canonical: url,
            ...(markdownTwin ? { types: { 'text/markdown': `${url}.md` } } : {}),
          },
        }
      : {}),
    openGraph: {
      type,
      title,
      ...(description ? { description } : {}),
      ...(url ? { url } : {}),
      ...(siteName ? { siteName } : {}),
      ...(locale ? { locale } : {}),
      ...(images ? { images } : {}),
      ...(type === 'article' ? article : {}),
    },
    twitter: {
      card: 'summary_large_image' as const,
      title,
      ...(description ? { description } : {}),
      ...(handle ? { site: handle, creator: handle } : {}),
      ...(images ? { images: images.map(i => i.url) } : {}),
    },
  };
}

// ---- structured data ----------------------------------------------------------

/** A schema.org node: inline, or an `{ '@id' }` reference into the site's graph. */
export type LdNode = Record<string, unknown>;

const iso = (d: Date | string): string => new Date(d).toISOString();

export interface ArticleLdOptions {
  /** `Article` by default; `BlogPosting`, `TechArticle`, `ScholarlyArticle`… */
  type?: string;
  headline: string;
  /** Absolute canonical URL. */
  url: string;
  description?: string;
  /**
   * Absolute URL, and required: Google wants an image on every article. Pass
   * the card `pageMetadata` was given, so the two cannot disagree.
   */
  image: string;
  published?: Date | string;
  modified?: Date | string;
  publisher: LdNode;
  isPartOf?: LdNode;
  /** Omit rather than invent one: a system-authored row has no person to name. */
  author?: LdNode;
  license?: string;
  /** Defaults to `en`. */
  inLanguage?: string;
  /** See `citationsFromReferences`. Left out when empty. */
  citation?: LdNode[];
  /** What only this wiki states — wordCount, articleSection, about, hasPart. Spread last. */
  extra?: LdNode;
}

export function articleLd(o: ArticleLdOptions): LdNode {
  return {
    '@context': 'https://schema.org',
    '@type': o.type ?? 'Article',
    headline: o.headline,
    url: o.url,
    mainEntityOfPage: { '@type': 'WebPage', '@id': o.url },
    ...(o.description ? { description: o.description } : {}),
    image: o.image,
    ...(o.published ? { datePublished: iso(o.published) } : {}),
    ...(o.modified ? { dateModified: iso(o.modified) } : {}),
    inLanguage: o.inLanguage ?? 'en',
    ...(o.author ? { author: o.author } : {}),
    publisher: o.publisher,
    ...(o.isPartOf ? { isPartOf: o.isPartOf } : {}),
    ...(o.license ? { license: o.license } : {}),
    ...(o.citation?.length ? { citation: o.citation } : {}),
    ...o.extra,
  };
}

export interface CollectionLdOptions {
  name: string;
  /** Absolute. */
  url: string;
  description?: string;
  isPartOf?: LdNode;
  license?: string;
  /** In display order; `url` absolute. */
  items: readonly { name: string; url: string }[];
  /** How many are listed. `numberOfItems` still counts every one. Defaults to 100. */
  max?: number;
  extra?: LdNode;
}

/** An index page and the pages it lists, as a CollectionPage over an ItemList. */
export function collectionLd(o: CollectionLdOptions): LdNode {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: o.name,
    url: o.url,
    ...(o.description ? { description: o.description } : {}),
    ...(o.isPartOf ? { isPartOf: o.isPartOf } : {}),
    ...(o.license ? { license: o.license } : {}),
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: o.items.length,
      itemListElement: o.items.slice(0, o.max ?? 100).map((item, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: item.name,
        url: item.url,
      })),
    },
    ...o.extra,
  };
}

/**
 * A page's `references` items as `Article.citation`, read off the block data
 * rather than re-parsed out of rendered HTML. Tags out and entities decoded, so
 * an authored `&amp;` is not what a crawler reads.
 */
export function citationsFromReferences(items: readonly ReferenceItem[], max = 50): LdNode[] {
  return items
    .flatMap(ref => {
      const name = decodeEntities(ref.text.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
      return name ? [{ '@type': 'CreativeWork', name: name.slice(0, 250), ...(ref.url ? { url: ref.url } : {}) }] : [];
    })
    .slice(0, max);
}

/**
 * Characters a document `<title>` has before a search result truncates it.
 *
 * Google measures pixels, not characters, so this is the round number that
 * approximates ~580px of the default result font and is what every audit in
 * these repos has counted against. The budget covers the WHOLE rendered title,
 * template included: a wiki spending 13 of it on " | RADIX Wiki" has 47 left,
 * which is the number that matters to whoever writes the title.
 */
export const TITLE_BUDGET = 60;

/**
 * Past this, a title is not merely trimmed but cut into.
 *
 * Between the budget and this limit a title loses its tail, which is often the
 * site name and no loss at all. Past it, the words carrying what the page is
 * about are going too: the radix.wiki ideas board spent its first sixteen
 * characters on a working group and reached 93, and the symptom pages on
 * acuiq.com reached 88 before naming the symptom. That is the line worth
 * failing a build over; the band below it is worth reporting and no more.
 */
export const TITLE_LIMIT = 70;

/**
 * The document `<title>` for a page: its short form where the page carries one,
 * else its own title.
 *
 * A wiki title is written for the H1 and the listing card, where a prefix that
 * groups the page earns its space — "Governance WG · ", "Radix Week in Review: ".
 * In a search result the same prefix spends the budget before the topic arrives,
 * so a page may store a short form under `key` and the document title takes it.
 * Nothing else does: the H1, the listing card, the markdown twin and the social
 * card all keep the page's own title, and `pageMetadata` above is deliberately
 * not wired to this, because a social card is not length-constrained the same
 * way and the full title reads better on one.
 */
export function documentTitle(title: string, metadata: unknown, key = 'seoTitle'): string {
  const short = (metadata as Record<string, unknown> | null | undefined)?.[key];
  return typeof short === 'string' && short.trim() ? short : title;
}
