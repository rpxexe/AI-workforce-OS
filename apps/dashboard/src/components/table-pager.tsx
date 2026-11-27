"use client";

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { useId, useState } from "react";
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
 * Pages a list the server pages: `query` (page=&limit=) goes on the request, and `pager(total)` feeds TablePager
 * once the response says how many rows match. A new filter (resetKey) goes back to page 1.
 */
export function useServerPaged(resetKey: unknown, initialSize = 20) {
  const [page, setPage] = useState(0);
  const [size, setSizeState] = useState(initialSize);
  const [lastKey, setLastKey] = useState(resetKey);
  if (resetKey !== lastKey) {
    setLastKey(resetKey);
    setPage(0);
  }
  const setSize = (next: number) => {
    setSizeState(next);
    setPage(0);
  };
  const pager = (total: number) => {
    const pages = Math.max(1, Math.ceil(total / size));
    // Rows deleted from the last page: step back to the new last page (known only once a response has a total).
    if (total > 0 && page > pages - 1) setPage(pages - 1);
    return { page: Math.min(page, pages - 1), pages, size, total, setPage, setSize };
  };
  return { query: `page=${page + 1}&limit=${size}`, pager };
}

/**
 * Pages a list the server pages with cursors (keyset): the request carries the cursor that opens the page shown,
 * and the cursors of pages already visited are kept, so First and Previous go back to exactly those pages. Pages
 * are reached one at a time with Next; there is no jumping ahead, since a page's cursor comes from the one before.
 * A new filter (resetKey) or page size starts again at page 1.
 */
export function useCursorPaged(resetKey: unknown, initialSize = 20) {
  // cursors[i] opens page i; page 0 needs none.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [page, setPage] = useState(0);
  const [size, setSizeState] = useState(initialSize);
  const [lastKey, setLastKey] = useState(resetKey);
  if (resetKey !== lastKey) {
    setLastKey(resetKey);
    setCursors([null]);
    setPage(0);
  }
  const setSize = (next: number) => {
    setSizeState(next);
    setCursors([null]);
    setPage(0);
  };
  const cursor = cursors[page] ?? null;

  /**
   * TablePager props for the response shown. Pass `nextCursor: null` while a page is loading, so Next cannot reuse
   * the previous page's cursor. `rows` is that page's row count: a page emptied by deletions steps back one.
   */
  const pager = ({ total, nextCursor, rows }: { total: number; nextCursor: string | null; rows: number }): Pager => {
    if (rows === 0 && page > 0) setPage(page - 1);
    const go = (target: number) => {
      if (target <= page) setPage(Math.max(0, target));
      else if (target === page + 1 && nextCursor) {
        setCursors([...cursors.slice(0, page + 1), nextCursor]);
        setPage(page + 1);
      }
    };
    const pages = Math.max(1, page + 1 + (nextCursor ? 1 : 0), Math.ceil(total / size));
    return { page, pages, size, total, setPage: go, setSize, hasNext: nextCursor !== null };
  };
  return { query: `limit=${size}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, pager };
}

/** TablePager's props. `hasNext` is set for cursor paging: Next follows it, and there is no Last page button. */
export type Pager = {
  page: number;
  pages: number;
  size: number;
  total: number;
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
  // Nothing to page or resize when every row fits on the smallest page.
  if (total <= PAGE_SIZES[0]!) return null;
  const sizes = PAGE_SIZES.includes(size) ? PAGE_SIZES : [...PAGE_SIZES, size].sort((a, b) => a - b);
  const first = page === 0;
  const cursorPaged = hasNext !== undefined;
  const last = cursorPaged ? !hasNext : page === pages - 1;

  return (
    // Inside a card the table runs edge to edge (CardContent drops its padding), so the footer adds its own,
    // lining up with the table's first and last columns.
    <div className={cn("flex items-center justify-between pt-3 in-data-[slot=card]:px-4", className)}>
      <p className="hidden flex-1 text-sm text-muted-foreground tabular-nums lg:flex">
        {page * size + 1}–{Math.min((page + 1) * size, total)} of {total}
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
          Page {page + 1} of {pages}
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
