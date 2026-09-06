// pagination.ts — one offset-pagination shape, everywhere.
//
// Forked three ways once: a re-typed clamp that dropped `totalPages`, and an
// offset redone by hand in raw SQL. The response shape is the contract a client
// codes against, so reshaping it per repo is a breaking change nobody declared.

export interface Pagination {
  page: number;
  pageSize: number;
}

export interface PaginatedResponse<T> extends Pagination {
  items: T[];
  total: number;
  totalPages: number;
}

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

/**
 * `page` clamped to ≥1, `pageSize` clamped to 1–`max`. Never trust either.
 *
 * `max` defaults to 100 and exists because the cap is a per-route decision, not
 * a package-wide one: a route whose rows are whole pages caps lower than one
 * whose rows are titles. Without it the one consumer that caps at 50 could not
 * express itself here, so it kept its own clamp — and then disagreed with
 * itself, capping at 50 in the REST route and 100 in the MCP tool beside it.
 */
export function parsePagination(
  searchParams: URLSearchParams,
  defaults?: { pageSize?: number; max?: number },
): Pagination {
  const max = defaults?.max ?? MAX_PAGE_SIZE;
  const fallbackSize = Math.min(max, defaults?.pageSize ?? DEFAULT_PAGE_SIZE);
  const rawPage = parseInt(searchParams.get('page') || '1', 10);
  const rawSize = parseInt(searchParams.get('pageSize') || String(fallbackSize), 10);
  return {
    page: Number.isFinite(rawPage) ? Math.max(1, rawPage) : 1,
    pageSize: Number.isFinite(rawSize) ? Math.min(max, Math.max(1, rawSize)) : fallbackSize,
  };
}

export function paginatedResponse<T>(
  items: T[],
  total: number,
  page: number,
  pageSize: number,
): PaginatedResponse<T> {
  return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}

/**
 * The envelope an MCP listing answers with.
 *
 * `paginatedResponse` names its array `items` because a REST caller reads the
 * shape from a spec. A tool result is read by a model, which has no spec and
 * will simply stop at twenty rows unless the envelope says otherwise — so this
 * one states `totalPages`, whether there is more, and the exact number to pass
 * back. Two wikis returning the same rows disagreed on precisely that: one
 * carried the three fields, the other returned `total/page/pageSize` and left
 * every agent to infer the rest.
 */
export function listEnvelope<T>(
  pages: T[],
  total: number,
  page: number,
  pageSize: number,
  emptyNote?: string,
): {
  total: number; page: number; pageSize: number; totalPages: number;
  hasMore: boolean; nextPage?: number; note?: string; pages: T[];
} {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasMore = page < totalPages;
  return {
    total, page, pageSize, totalPages, hasMore,
    ...(hasMore ? { nextPage: page + 1 } : {}),
    // Nought results is the one answer a model cannot act on, and an envelope
    // of zeroes does not say whether the term was wrong, the filter too narrow,
    // or the wiki simply silent on it. One surface here answered that with a
    // note and two answered it with `pages: []`.
    ...(total === 0 && emptyNote ? { note: emptyNote } : {}),
    pages,
  };
}

/** The `skip`/`take` an ORM wants, from the same clamped pair. */
export function toOffset({ page, pageSize }: Pagination): { skip: number; take: number } {
  return { skip: (page - 1) * pageSize, take: pageSize };
}

/**
 * The entries either side of the current one in an already-ordered list.
 *
 * The ordering is the caller's, deliberately — it is the one thing here that is
 * never portable. A wiki's sequence is its section's configured sort, a
 * knowledge base's is a taxonomy walk, and a company log's is `updatedAt` desc.
 * What both wikis had written twice is this scan, not the sort.
 *
 * `null` on both sides when the page is not in the list, so a page reached by a
 * URL its own section does not list renders no nav rather than a wrong one.
 *
 * No query. Both callers already hold the ordered siblings for something else —
 * a related-pages panel, a section listing — and the two indexed lookups the
 * neighbours used to cost were the reason one wiki dropped the control.
 */
export function adjacentPages<T>(
  ordered: readonly T[],
  isCurrent: (page: T) => boolean,
): { prev: T | null; next: T | null } {
  const i = ordered.findIndex(isCurrent);
  if (i < 0) return { prev: null, next: null };
  return { prev: ordered[i - 1] ?? null, next: ordered[i + 1] ?? null };
}
