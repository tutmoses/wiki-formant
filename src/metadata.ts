// metadata.ts — one page's canonical, markdown twin, Open Graph and Twitter
// card, from one input.
//
// Next *replaces* rather than merges these objects per route segment, and it
// does not derive `twitter.title` from `openGraph`. So a page that sets its own
// openGraph and forgets twitter regresses to the layout's generic card, and a
// page that restates `alternates` for its twin clobbers its canonical. Two
// wikis wrote a helper around exactly that and covered different halves: one
// had the twin and no siteName, the other the siteName and no twin. The third
// wrote each page's metadata by hand.
//
// Plain objects in the shape Next's `Metadata` wants, so no `next` import.

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
  /** Absolute canonical URL. */
  url: string;
  type?: 'website' | 'article';
  /** Absolute URL of a 1200×630 card. Omit to let a file-convention `opengraph-image` supply it. */
  image?: string;
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
  const { title, description, url, type = 'website', image, siteName, locale, handle, markdownTwin, article } = o;
  const images = image ? [{ url: image, width: 1200, height: 630, alt: o.imageAlt ?? title }] : undefined;
  return {
    alternates: {
      canonical: url,
      ...(markdownTwin ? { types: { 'text/markdown': `${url}.md` } } : {}),
    },
    openGraph: {
      type,
      title,
      ...(description ? { description } : {}),
      url,
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
