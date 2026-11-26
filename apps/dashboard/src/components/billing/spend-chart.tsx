"use client";

import type { BillingOverview } from "@workforce/shared";
import { Area, AreaChart, XAxis } from "recharts";
import { useGrowMotion } from "@/components/chart-motion";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const spendConfig = { amountUsd: { label: "Billed", color: "var(--chart-1)" } } satisfies ChartConfig;
const dayLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

/** Amount billed per day of the period, small, for the bottom of the usage tile. */
export function SpendSpark({ rows: data }: { rows: BillingOverview["usage"]["daily"] }) {
  const { rows, motion } = useGrowMotion(data, ["amountUsd"]);
  if (rows.length === 0) return null;
  return (
    <ChartContainer config={spendConfig} className="aspect-auto h-16 w-full">
      <AreaChart data={rows} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="spark-spend" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-amountUsd)" stopOpacity={0.5} />
            <stop offset="95%" stopColor="var(--color-amountUsd)" stopOpacity={0.15} />
          </linearGradient>
        </defs>
        <XAxis dataKey="date" hide />
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent indicator="dot" labelFormatter={(_, payload) => dayLabel(String(payload[0]?.payload.date))} formatter={(v) => `${usd(Number(v))} billed`} />}
        />
        <Area dataKey="amountUsd" type="bumpX" strokeLinejoin="round" stroke="var(--color-amountUsd)" fill="url(#spark-spend)" strokeWidth={2} {...motion} />
      </AreaChart>
    </ChartContainer>
  );
}
