"use client";

import { useEffect, useRef } from "react";
import { Spinner } from "@/components/ui/spinner";

/**
 * A sentinel at the edge of a list that loads its next page by cursor: `onView` runs when it scrolls into view, and
 * again after each load while it stays in view (a page too short to push it out). Shows a Spinner while loading.
 * Render it only while there is a page left to load.
 */
export function LoadOnView({ onView, loading, label }: { onView: () => void; loading: boolean; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(onView);
  useEffect(() => {
    latest.current = onView;
  });
  // A new observer reports the sentinel's current state at once, so re-observing after a load continues while visible.
  useEffect(() => {
    const element = ref.current;
    if (!element || loading) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) latest.current();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [loading]);
  return (
    <div ref={ref} className="flex min-h-8 shrink-0 items-center justify-center">
      {loading && <Spinner aria-label={label} />}
    </div>
  );
}
