"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useApi } from "@/lib/api";

type Page<T> = { data: T[]; nextCursor: string | null };

/**
 * Adds the server's next pages to a first page loaded with useApiQuery. A new first page (another
 * search or filter, or a reload after a change) drops the extra pages, so they never go stale.
 */
export function useLoadMore<T extends { id: string }>(path: string, first: Page<T> | undefined) {
  const api = useApi();
  const [more, setMore] = useState<{ first: Page<T>; rows: T[]; cursor: string | null }>();
  const [loading, setLoading] = useState(false);
  const current = more && more.first === first ? more : undefined;
  const cursor = current ? current.cursor : (first?.nextCursor ?? null);
  // A row that moved up between pages (seen again, edited) comes back twice; keep its first place.
  const rows = first && [...new Map([...first.data, ...(current?.rows ?? [])].map((r) => [r.id, r])).values()];

  const loadMore = async () => {
    if (!first || !cursor) return;
    setLoading(true);
    try {
      const page = await api<Page<T>>(`${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`);
      setMore({ first, rows: [...(current?.rows ?? []), ...page.data], cursor: page.nextCursor });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load more. Try again.");
    } finally {
      setLoading(false);
    }
  };
  return { rows, hasMore: cursor !== null, loading, loadMore };
}

export function LoadMoreButton({ hasMore, loading, loadMore, label = "Load more" }: { hasMore: boolean; loading: boolean; loadMore: () => void; label?: string }) {
  if (!hasMore) return null;
  return (
    <Button variant="outline" size="sm" className="self-center" onClick={loadMore} disabled={loading}>
      {loading && <Spinner />}
      {label}
    </Button>
  );
}
