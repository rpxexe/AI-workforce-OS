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

type Pager = ReturnType<typeof usePaged>["pager"];

/**
 * The data-table footer from the shadcn dashboard-01 block (rows per page, page number, first/previous/
 * next/last), built from shadcn Button, Select and Label as the block does. The shadcn Pagination
 * primitive is a different design (numbered page links), so it is not used here.
 */
export function TablePager({ page, pages, size, total, setPage, setSize, className }: Pager & { className?: string }) {
  const sizeId = useId();
  // Nothing to page or resize when every row fits on the smallest page.
  if (total <= PAGE_SIZES[0]!) return null;
  const sizes = PAGE_SIZES.includes(size) ? PAGE_SIZES : [...PAGE_SIZES, size].sort((a, b) => a - b);
  const first = page === 0;
  const last = page === pages - 1;

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
          <Button variant="outline" size="icon-sm" className="hidden lg:inline-flex" disabled={last} onClick={() => setPage(pages - 1)} aria-label="Last page">
            <ChevronsRight aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  );
}
