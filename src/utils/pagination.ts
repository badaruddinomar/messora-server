import { z } from "zod";

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** Query params for cursor pagination: `?cursor=<id>&limit=20`. */
export const paginationQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type PaginationQuery = z.infer<typeof paginationQuery>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Prisma args for a cursor page. Fetches one extra row to know whether another page exists.
 * The query must also have a stable `orderBy` ending in a unique column (e.g. `[{ createdAt: "desc" }, { id: "desc" }]`).
 */
export const cursorArgs = ({ cursor, limit }: PaginationQuery) => ({
  take: limit + 1,
  ...(cursor && { cursor: { id: cursor }, skip: 1 }),
});

/** Turns the `limit + 1` rows from `cursorArgs` into a page. */
export function toPage<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}
