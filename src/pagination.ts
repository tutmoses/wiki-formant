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

/** The `skip`/`take` an ORM wants, from the same clamped pair. */
export function toOffset({ page, pageSize }: Pagination): { skip: number; take: number } {
  return { skip: (page - 1) * pageSize, take: pageSize };
}
