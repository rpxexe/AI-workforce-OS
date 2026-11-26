"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const ChartMotion = createContext(true);

const ANIMATED = { animationDuration: 700, animationEasing: "ease-out" } as const;
const STATIC = { isAnimationActive: false } as const;

/**
 * `animate={false}` drops the entrance animation below it (e.g. after the first tab switch) so charts appear straight
 * away; changes after that, like a new period, still move smoothly. Without a provider charts make an entrance.
 * Recharts skips every animation under reduced motion.
 */
export function ChartMotionProvider({ animate, children }: { animate: boolean; children: ReactNode }) {
  return <ChartMotion.Provider value={animate}>{children}</ChartMotion.Provider>;
}

/** False on the first frame after mount, true from the next one. */
function useMounted() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return mounted;
}

/** Animation props to spread onto a Recharts series (Bar, Line, Pie, Radar, RadialBar). Bars grow from their base. */
export function useChartMotion() {
  const entrance = useContext(ChartMotion);
  const mounted = useMounted();
  return entrance || mounted ? ANIMATED : STATIC;
}

/**
 * For area and bar charts: rows to draw and animation props. Recharts reveals a new area left to right and, when the
 * points change, matches old points to new ones by position, so days or categories land in the wrong place
 * mid-animation. Instead, whenever the chart is new or its `shape` changes, one frame draws the series at zero without
 * animation and the next animation grows it up from the baseline. Same shape (another metric, new numbers for the
 * same days or categories): it morphs from what was there. After a tab switch (`animate={false}`) the first draw is
 * instant. `shape` defaults to the number of rows; pass the category labels joined when the categories can change.
 */
export function useGrowMotion<R extends object>(rows: R[], keys: readonly string[], shape: number | string = rows.length) {
  const entrance = useContext(ChartMotion);
  // The shape the chart last settled on, and whether it has been drawn at all.
  const [settled, setSettled] = useState<number | string | null>(null);
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      setSettled(shape);
      setDrawn(true);
    });
    return () => cancelAnimationFrame(id);
  }, [shape]);
  if (settled === shape) return { rows, motion: ANIMATED };
  const flat = drawn || entrance;
  return { rows: flat ? rows.map((r) => ({ ...r, ...Object.fromEntries(keys.map((k) => [k, 0])) }) as R) : rows, motion: STATIC };
}
