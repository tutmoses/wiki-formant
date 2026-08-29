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

/** `page` clamped to ≥1, `pageSize` clamped to 1–100. Never trust either. */
export function parsePagination(
  searchParams: URLSearchParams,
  defaults?: { pageSize?: number },
): Pagination {
  const rawPage = parseInt(searchParams.get('page') || '1', 10);
  const rawSize = parseInt(
    searchParams.get('pageSize') || String(defaults?.pageSize ?? DEFAULT_PAGE_SIZE),
    10,
  );
  return {
    page: Number.isFinite(rawPage) ? Math.max(1, rawPage) : 1,
    pageSize: Number.isFinite(rawSize)
      ? Math.min(MAX_PAGE_SIZE, Math.max(1, rawSize))
      : (defaults?.pageSize ?? DEFAULT_PAGE_SIZE),
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
