"use client";

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { useId, useState } from "react";
import { cursorOf, firstPage, goTo, pageCount, settle, type CursorPages } from "@/lib/cursor-pages";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const PAGE_SIZES = [10, 20, 30, 40, 50];

/**
 * Pages a list that is already in the browser. Every list endpoint caps its rows on the server,
 * so paging here costs no extra requests.
 */
export function usePaged<T>(rows: T[], initialSize = 20, resetKey?: unknown) {
  const [page, setPage] = useState(0);
  const [size, setSizeState] = useState(initialSize);
  // A new filter (resetKey) goes back to page 1; a reload or poll of the same filter keeps the page.
  const [lastKey, setLastKey] = useState(resetKey);
  if (resetKey !== lastKey) {
    setLastKey(resetKey);
    setPage(0);
  }
  const pages = Math.max(1, Math.ceil(rows.length / size));
  // The list can shrink after a filter or reload; never point past its end.
  const current = Math.min(page, pages - 1);
  const setSize = (next: number) => {
    setSizeState(next);
    setPage(0);
  };
  return { rows: rows.slice(current * size, (current + 1) * size), pager: { page: current, pages, size, total: rows.length, setPage, setSize } };
}

/**
 * Pages a list the server pages with cursors (keyset): the request carries the cursor that opens the page shown,
 * and the cursors of pages already visited are kept, so First and Previous go back to exactly those pages. Pages
 * are reached one at a time with Next; there is no jumping ahead, since a page's cursor comes from the one before.
 * A new filter (resetKey) or page size starts again at page 1 with no cursor. The rules live in lib/cursor-pages.
 */
export function useCursorPaged(resetKey: unknown, initialSize = 20) {
  const [state, setState] = useState<CursorPages>(firstPage);
  const [size, setSizeState] = useState(initialSize);
  const [lastKey, setLastKey] = useState(resetKey);
  if (resetKey !== lastKey) {
    setLastKey(resetKey);
    setState(firstPage);
  }
  const setSize = (next: number) => {
    setSizeState(next);
    setState(firstPage);
  };
  const cursor = cursorOf(state);

  /**
   * TablePager props for the response shown. Pass `nextCursor: null` while a page loads, so Next cannot reuse the
   * previous page's cursor. `rows` is the shown page's row count (a page emptied by deletions steps back one);
   * `total`, when the list has one, puts "of N" in the footer.
   */
  const pager = ({ nextCursor, rows, total }: { nextCursor: string | null; rows: number; total?: number }): Pager => {
    const settled = settle(state, rows);
    if (settled !== state) setState(settled);
    return {
      page: state.page,
      pages: pageCount(state, size, total, nextCursor),
      size,
      total,
      setPage: (target) => setState((s) => goTo(s, target, nextCursor)),
      setSize,
      hasNext: nextCursor !== null,
    };
  };
  return { query: `limit=${size}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, pager };
}

/**
 * TablePager's props. `hasNext` is set for cursor paging: Next follows it, and there is no Last page button.
 * `total` is left out by cursor lists that do not count (a log): the footer then shows only the page number.
 */
export type Pager = {
  page: number;
  pages: number;
  size: number;
  total?: number;
  setPage: (page: number) => void;
  setSize: (size: number) => void;
  hasNext?: boolean;
};

/**
 * The data-table footer from the shadcn dashboard-01 block (rows per page, page number, first/previous/
 * next/last), built from shadcn Button, Select and Label as the block does. The shadcn Pagination
 * primitive is a different design (numbered page links), so it is not used here.
 */
export function TablePager({ page, pages, size, total, setPage, setSize, hasNext, className }: Pager & { className?: string }) {
  const sizeId = useId();
  const cursorPaged = hasNext !== undefined;
  const first = page === 0;
  const last = cursorPaged ? !hasNext : page === pages - 1;
  // Nothing to page or resize when every row fits on the smallest page.
  if (first && last && (total === undefined || total <= PAGE_SIZES[0]!)) return null;
  const sizes = PAGE_SIZES.includes(size) ? PAGE_SIZES : [...PAGE_SIZES, size].sort((a, b) => a - b);

  return (
    // Inside a card the table runs edge to edge (CardContent drops its padding), so the footer adds its own,
    // lining up with the table's first and last columns.
    <div className={cn("flex items-center justify-between pt-3 in-data-[slot=card]:px-4", className)}>
      <p className="hidden flex-1 text-sm text-muted-foreground tabular-nums lg:flex">
        {total !== undefined && `${(page * size + 1).toLocaleString()}–${Math.min((page + 1) * size, total).toLocaleString()} of ${total.toLocaleString()}`}
      </p>
      <div className="flex w-full items-center gap-8 lg:w-fit">
        <div className="hidden items-center gap-2 lg:flex">
          <Label htmlFor={sizeId} className="text-sm font-medium">
            Rows per page
          </Label>
          <Select value={String(size)} onValueChange={(v) => setSize(Number(v))}>
            <SelectTrigger id={sizeId} size="sm" className="w-20">
              <SelectValue />
            </SelectTrigger>
            <SelectContent side="top">
              {sizes.map((s) => (
                <SelectItem key={s} value={String(s)}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="flex w-fit items-center justify-center text-sm font-medium tabular-nums">
          Page {page + 1}
          {total !== undefined && ` of ${pages.toLocaleString()}`}
        </p>
        <div className="ml-auto flex items-center gap-2 lg:ml-0">
          <Button variant="outline" size="icon-sm" className="hidden lg:inline-flex" disabled={first} onClick={() => setPage(0)} aria-label="First page">
            <ChevronsLeft aria-hidden />
          </Button>
          <Button variant="outline" size="icon-sm" disabled={first} onClick={() => setPage(page - 1)} aria-label="Previous page">
            <ChevronLeft aria-hidden />
          </Button>
          <Button variant="outline" size="icon-sm" disabled={last} onClick={() => setPage(page + 1)} aria-label="Next page">
            <ChevronRight aria-hidden />
          </Button>
          {/* A cursor page is only reached from the one before it, so there is no jump to the end. */}
          {!cursorPaged && (
            <Button variant="outline" size="icon-sm" className="hidden lg:inline-flex" disabled={last} onClick={() => setPage(pages - 1)} aria-label="Last page">
              <ChevronsRight aria-hidden />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
