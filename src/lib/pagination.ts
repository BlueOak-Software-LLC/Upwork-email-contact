export type PageItem = number | "ellipsis";

/**
 * The numbered pager used by the lead table:
 *
 *   page 1 of 10  ->  1 2 3 4 5 ... 10
 *   page 5 of 10  ->  1 ... 4 5 6 ... 10
 *   page 10 of 10 ->  1 ... 6 7 8 9 10
 *
 * Seven slots at most, so the pager never turns into a second table.
 */
export function paginationItems(page: number, totalPages: number): PageItem[] {
  const total = Math.max(1, Math.floor(totalPages));
  const current = Math.min(Math.max(1, Math.floor(page)), total);

  if (total <= 7) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }
  if (current <= 4) {
    return [1, 2, 3, 4, 5, "ellipsis", total];
  }
  if (current >= total - 3) {
    return [1, "ellipsis", total - 4, total - 3, total - 2, total - 1, total];
  }
  return [1, "ellipsis", current - 1, current, current + 1, "ellipsis", total];
}
