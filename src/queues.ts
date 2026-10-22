// queues.ts — tracking categories, Wikipedia's hidden maintenance categories,
// as work queues.
//
// A cleanup template files a page into `Articles needing update` or `Orphaned
// articles`, and contributors pick work off the list. Every wiki here already
// computed the same signals: `isStale` drives the outdated banner, the content
// standard asks for linked sources, a category declares required facts. Each
// surfaced only on the affected page, where nobody looking for work sees it.
// These are those predicates gathered into lists, derived on every read, so
// fixing a page takes it off the list with no ticket to close.
//
// radix-wiki wrote it over its own Prisma rows; caper, acuiq2 and miow's wikis
// had none. What differs is how a page is addressed and which facts its
// category requires, so those are the arguments.

import { daysSince, isStale, DEFAULT_MAX_AGE_DAYS } from './freshness.js';

export interface QueuePage {
  id: string;
  title: string;
  tagPath: string;
  slug: string;
  content: unknown;
  metadata: unknown;
  updatedAt: Date | string;
  lastVerifiedAt?: Date | string | null;
}

export interface QueueItem {
  title: string;
  href: string;
  tagPath: string;
  detail: string;
}

export type QueueKey = 'outdated' | 'orphaned' | 'unsourced' | 'incomplete';

export interface MaintenanceQueue {
  key: QueueKey;
  title: string;
  description: string;
  items: QueueItem[];
}

export interface QueueOptions<P extends QueuePage> {
  /** A page's address as its links name it: `/guides/install`, no trailing slash. */
  href: (page: P) => string;
  /** The facts a page's category requires, by key and label. */
  required?: (tagPath: string) => readonly { key: string; label: string }[];
  nowMs: number;
  maxAgeDays?: number;
  /** How a page is stamped as checked here, closing the outdated queue's description. */
  verify?: string;
  /** The ids a block names its pages by, for a list that picks pages by id rather than by link. */
  listedIds?: (content: unknown) => Iterable<string>;
}

// An href inside stored JSON, its quotes escaped or not.
const HREF = /href=\\?"([^"\\?#]+)/g;
/** A `references` block keeps each citation in a `url` field, not an href. */
const REF_URL = /"url":"https?:/g;

/**
 * The four queues over a wiki's pages, empty ones dropped. Pass every page
 * outside the home page and the back office: an orphan is a page nothing else
 * links to, so the link graph needs them all. One pass reads each page's
 * content for both the links in and the sources out.
 */
export function maintenanceQueues<P extends QueuePage>(pages: readonly P[], o: QueueOptions<P>): MaintenanceQueue[] {
  const maxAgeDays = o.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const ids = new Set(pages.map(p => p.id));
  const linkedPaths = new Set<string>();
  const linkedIds = new Set<string>();
  const sources = new Map<string, number>();
  for (const page of pages) {
    const text = JSON.stringify(page.content ?? '');
    let outbound = 0;
    for (const [, target] of text.matchAll(HREF)) {
      if (!target) continue;
      if (target.startsWith('/')) linkedPaths.add(target.replace(/\/+$/, '') || '/');
      else if (/^https?:/i.test(target)) outbound++;
    }
    sources.set(page.id, outbound + (text.match(REF_URL)?.length ?? 0));
    for (const id of o.listedIds?.(page.content) ?? []) if (id !== page.id && ids.has(id)) linkedIds.add(id);
  }

  const item = (p: P, detail: string): QueueItem => ({ title: p.title, href: o.href(p), tagPath: p.tagPath, detail });
  const facts = (p: P) => (p.metadata && typeof p.metadata === 'object' ? (p.metadata as Record<string, unknown>) : {});
  const incomplete = pages.flatMap(p => {
    const missing = (o.required?.(p.tagPath) ?? [])
      .filter(k => { const v = facts(p)[k.key]; return typeof v !== 'string' || !v.trim(); })
      .map(k => k.label.replace(/:$/, ''));
    return missing.length ? [item(p, `missing ${missing.join(', ')}`)] : [];
  });

  const queues: MaintenanceQueue[] = [
    {
      key: 'outdated',
      title: 'Outdated',
      description: `Not checked or changed in ${maxAgeDays} days. Re-check the facts against current sources${o.verify ? `, then ${o.verify}` : ''}.`,
      items: pages
        .filter(p => isStale(p, o.nowMs, maxAgeDays))
        .map(p => item(p, `${daysSince(p.lastVerifiedAt ?? p.updatedAt, o.nowMs)} days`)),
    },
    {
      key: 'orphaned',
      title: 'Orphaned',
      description: 'No other page links here, so readers arrive only by search or the category list. Link it from a related page.',
      items: pages.filter(p => !linkedPaths.has(o.href(p)) && !linkedIds.has(p.id)).map(p => item(p, 'no links in')),
    },
    {
      key: 'unsourced',
      title: 'Unsourced',
      description: 'No link out anywhere on the page. Every claim of fact should link to the source it came from.',
      items: pages.filter(p => !sources.get(p.id)).map(p => item(p, 'no links out')),
    },
    {
      key: 'incomplete',
      title: 'Missing facts',
      description: 'A fact the page’s category requires is empty, so its facts panel and the category’s filters leave it out.',
      items: incomplete,
    },
  ];
  return queues.filter(q => q.items.length > 0);
}
