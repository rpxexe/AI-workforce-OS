"use client";

import { Bar, BarChart, PolarAngleAxis, RadialBar, RadialBarChart, XAxis, YAxis } from "recharts";
import { useChartMotion } from "@/components/chart-motion";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";

const n = (v: number) => v.toLocaleString("en-US");
const pct = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 100));

export type Segment = { key: string; label: string; value: number; color: string };

/** Parts of a whole as one stacked bar with a legend of counts underneath; nothing when the whole is 0. */
export function SplitBar({ segments }: { segments: Segment[] }) {
  const motion = useChartMotion();
  const shown = segments.filter((s) => s.value > 0);
  const total = shown.reduce((sum, s) => sum + s.value, 0);
  if (total === 0) return null;
  const config = Object.fromEntries(shown.map((s) => [s.key, { label: s.label, color: s.color }])) satisfies ChartConfig;
  const row = Object.fromEntries(shown.map((s) => [s.key, s.value]));
  return (
    <div className="flex flex-col gap-2">
      <ChartContainer config={config} className="aspect-auto h-3 w-full">
        <BarChart data={[row]} layout="vertical" stackOffset="expand" margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
          <XAxis type="number" hide />
          <YAxis type="category" hide />
          <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel indicator="dot" formatter={(v, name) => `${config[String(name)]?.label}: ${n(Number(v))} (${pct(Number(v), total)}%)`} />} />
          {shown.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              stackId="split"
              fill={`var(--color-${s.key})`}
              radius={shown.length === 1 ? 4 : i === 0 ? [4, 0, 0, 4] : i === shown.length - 1 ? [0, 4, 4, 0] : 0}
              animationBegin={i * 120}
              {...motion}
            />
          ))}
        </BarChart>
      </ChartContainer>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {shown.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span className="size-2 shrink-0 rounded-[2px]" style={{ backgroundColor: s.color }} aria-hidden />
            <span className="text-muted-foreground">{s.label}</span>
            <span className="tabular-nums">{n(s.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A 0-100 value as a half-circle gauge on a muted track. */
export function Gauge({ value, color }: { value: number; color: string }) {
  const motion = useChartMotion();
  const config = { value: { label: "Value", color } } satisfies ChartConfig;
  return (
    <ChartContainer config={config} className="mx-auto aspect-auto h-16 w-32">
      <RadialBarChart data={[{ value }]} startAngle={180} endAngle={0} cx="50%" cy="100%" innerRadius={44} outerRadius={60}>
        <PolarAngleAxis type="number" domain={[0, 100]} tick={false} axisLine={false} />
        <RadialBar dataKey="value" fill="var(--color-value)" background={{ fill: "var(--muted)" }} cornerRadius={6} {...motion} />
      </RadialBarChart>
    </ChartContainer>
  );
}
