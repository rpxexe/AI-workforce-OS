// Where a cursor-paged list is: the cursors of the pages visited so far (cursors[i] opens page i; page 0 needs none)
// and the page shown. Plain functions, no React, so the paging rules are tested on their own (cursor-pages.test.ts).

export type CursorPages = { cursors: (string | null)[]; page: number };

export const firstPage: CursorPages = { cursors: [null], page: 0 };

/** The cursor that opens the page shown (null on page 1). */
export const cursorOf = (s: CursorPages) => s.cursors[s.page] ?? null;

/**
 * Moves to `target`: back to any page already visited (its stored cursor), or one page forward with the shown
 * page's `nextCursor`. Anything else (jumping ahead, or forward with no next page) leaves the state as it is.
 */
export function goTo(s: CursorPages, target: number, nextCursor: string | null): CursorPages {
  if (target < s.page) return { ...s, page: Math.max(0, target) };
  if (target === s.page + 1 && nextCursor) return { cursors: [...s.cursors.slice(0, s.page + 1), nextCursor], page: s.page + 1 };
  return s;
}

/** A page whose rows were all deleted meanwhile steps back one page; otherwise nothing changes. */
export const settle = (s: CursorPages, rows: number): CursorPages => (rows === 0 && s.page > 0 ? { ...s, page: s.page - 1 } : s);

/** Pages for the footer: from the total when one is known, never fewer than the pages reached (plus one if more exist). */
export function pageCount(s: CursorPages, size: number, total: number | undefined, nextCursor: string | null) {
  const reached = s.page + 1 + (nextCursor ? 1 : 0);
  return Math.max(1, reached, total === undefined ? 0 : Math.ceil(total / size));
}
