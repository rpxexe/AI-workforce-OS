"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/** True once the element has scrolled into view; stays true, so a chart mounted on it animates once. */
function useRevealed<T extends Element>() {
  const ref = useRef<T>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || shown) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setShown(true);
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.2 },
    );
    observer.observe(el);
    // Printing shows every chart, not empty boxes for the ones never scrolled to.
    const print = () => setShown(true);
    window.addEventListener("beforeprint", print);
    return () => {
      observer.disconnect();
      window.removeEventListener("beforeprint", print);
    };
  }, [shown]);
  return [ref, shown] as const;
}

/**
 * Holds a chart's space and mounts it when it scrolls into view, so its entry animation is seen.
 * Recharts skips the animation under reduced motion; screen-reader text belongs outside, so it is always there.
 */
export function Reveal({ height, children }: { height: number; children: ReactNode }) {
  const [ref, shown] = useRevealed<HTMLDivElement>();
  return (
    <div ref={ref} style={{ minHeight: height }}>
      {shown && children}
    </div>
  );
}
