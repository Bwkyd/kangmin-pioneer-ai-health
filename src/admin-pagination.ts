export const ADMIN_CONTENT_PAGE_SIZE = 20;

export function pageCountFor(totalItems: number, pageSize = ADMIN_CONTENT_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(totalItems / pageSize));
}

export function clampPage(page: number, totalItems: number, pageSize = ADMIN_CONTENT_PAGE_SIZE): number {
  return Math.min(Math.max(1, page), pageCountFor(totalItems, pageSize));
}

export function itemsForPage<T>(items: T[], page: number, pageSize = ADMIN_CONTENT_PAGE_SIZE): T[] {
  const safePage = clampPage(page, items.length, pageSize);
  const start = (safePage - 1) * pageSize;
  return items.slice(start, start + pageSize);
}
