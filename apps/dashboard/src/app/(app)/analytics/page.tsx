"use client";

import { ArrowRightLeft, TrendingDown, TrendingUp, CircleCheck, Frown, Headset, Inbox, Languages, MessagesSquare, Percent, Sparkles, Timer, TriangleAlert, UserCheck, UserRoundCheck } from "lucide-react";
import {
  DETECTED_LANGUAGES,
  REPLY_BANDS,
  ENTITY_TYPES,
  HANDOFF_TRIGGER_LABELS,
  INTENTS,
  type DurationStats,
  type HandoffAnalytics,
  type InsightsOverview,
} from "@workforce/shared";
import { useState, type ReactNode } from "react";
import { Area, AreaChart, Bar, BarChart, Cell, Pie, PieChart, ReferenceLine, XAxis, YAxis } from "recharts";
import { RESOLUTION_LABELS, SENTIMENT_LABELS } from "@/components/inbox/conversation-insight";
import { ChartMotionProvider, useGrowMotion, useChartMotion } from "@/components/chart-motion";
import { formatDuration } from "@/components/inbox/meta";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { Skeleton as Skullet } from "skullet/react";
import { ErrorState, PageHeader, StatTile } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApiQuery } from "@/lib/api";
import { usePageTab } from "@/lib/tabs";
import { useMembers } from "@/lib/members";
import { withWorkspace } from "@/lib/workspace";

const PERIODS = [7, 30, 90] as const;

const SAMPLE_DURATION: DurationStats = { count: 42, average: 312, median: 245, p90: 840 };

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE_HANDOFFS: HandoffAnalytics = {
  days: 30,
  conversations: 1240,
  handoffs: 186,
  handoffRate: 0.15,
  previousHandoffRate: 0.18,
  weekly: Array.from({ length: 5 }, (_, i) => ({
    from: new Date(Date.UTC(2026, 0, 1 + i * 7)).toISOString().slice(0, 10),
    to: new Date(Date.UTC(2026, 0, 7 + i * 7)).toISOString().slice(0, 10),
    active: 300,
    handedOff: 40 + i * 3,
  })),
  byTrigger: [
    { trigger: "customer_request", count: 72 },
    { trigger: "low_confidence", count: 48 },
    { trigger: "policy_risk", count: 31 },
    { trigger: "repeated_failure", count: 22 },
    { trigger: "agent", count: 13 },
  ],
  outcomes: { resolved: 140, returnedToAi: 28, open: 18 },
  open: { queue: 6, assigned: 3, humanActive: 9 },
  timeToAccept: SAMPLE_DURATION,
  timeToFirstResponse: SAMPLE_DURATION,
  timeToResolve: SAMPLE_DURATION,
  replyTime: { ai: SAMPLE_DURATION, human: SAMPLE_DURATION },
  previousReplyMedian: { ai: 280, human: 280 },
  replyBands: { ai: [30, 8, 3, 1], human: [20, 12, 6, 4] },
  byAgent: Array.from({ length: 5 }, (_, i) => ({
    agentId: `sample-${i}`,
    handoffs: 40 - i * 5,
    resolved: 32 - i * 4,
    firstResponse: SAMPLE_DURATION,
  })),
  suggestions: { total: 120, used: 84 },
  daily: Array.from({ length: 31 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    conversations: 30 + ((i * 7) % 20),
    handoffs: 4 + ((i * 3) % 6),
    resolved: 3 + ((i * 5) % 4),
    active: 60 + ((i * 7) % 20),
    handedOff: 4 + ((i * 3) % 6),
  })),
};

type Daily = HandoffAnalytics["daily"];
const SPARK_COLORS = { conversations: "var(--chart-1)", handoffs: "var(--chart-2)", resolved: "var(--chart-3)" } as const;
const dayLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const total = (rows: Daily, k: keyof typeof SPARK_COLORS) => rows.reduce((s, d) => s + d[k], 0);

/** A small per-day area chart for the bottom of a StatTile: no axes, hover a day to read it. */
function Spark({ rows: data, series, label }: { rows: Daily; series: keyof typeof SPARK_COLORS; label: string }) {
  const { rows, motion } = useGrowMotion(data, [series]);
  const config = { [series]: { label, color: SPARK_COLORS[series] } } satisfies ChartConfig;
  return (
    <ChartContainer config={config} className="aspect-auto h-16 w-full">
      <AreaChart data={rows} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={`spark-${series}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={`var(--color-${series})`} stopOpacity={0.5} />
            <stop offset="95%" stopColor={`var(--color-${series})`} stopOpacity={0.15} />
          </linearGradient>
        </defs>
        <XAxis dataKey="date" hide />
        <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" labelFormatter={(_, payload) => dayLabel(String(payload[0]?.payload.date))} />} />
        <Area dataKey={series} type="bumpX" strokeLinejoin="round" stroke={`var(--color-${series})`} fill={`url(#spark-${series})`} strokeWidth={2} {...motion} />
      </AreaChart>
    </ChartContainer>
  );
}

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE_INSIGHTS: InsightsOverview = {
  days: 30,
  conversations: 1240,
  analyzed: 1000,
  languages: [
    { language: "en", conversations: 520 },
    { language: "hinglish", conversations: 310 },
    { language: "hi", conversations: 120 },
    { language: "ta", conversations: 30 },
    { language: "bn", conversations: 20 },
  ],
  codeSwitched: 340,
  withSwitches: 210,
  sentiment: { positive: 420, negative: 180, neutral: 340, mixed: 60 },
  intents: [
    { intent: "order_status", conversations: 280 },
    { intent: "refund", conversations: 160 },
    { intent: "delivery", conversations: 140 },
    { intent: "payment", conversations: 90 },
    { intent: "complaint", conversations: 60 },
  ],
  entities: [
    { type: "order_id", count: 410 },
    { type: "phone", count: 260 },
    { type: "person_name", count: 180 },
    { type: "address", count: 90 },
    { type: "amount", count: 70 },
  ],
  resolution: { resolved: 700, with_people: 150, open: 150 },
  escalation: { conversations: 186, rate: 0.15, withSignals: 24 },
  sentimentDaily: Array.from({ length: 31 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    positive: 12 + ((i * 3) % 6),
    neutral: 10 + ((i * 5) % 5),
    mixed: 2 + (i % 3),
    negative: 5 + ((i * 7) % 4),
  })),
};

/** A duration headline: the median, with the average, 90th percentile and sample size underneath. */
function DurationTile({ label, stats, children }: { label: string; stats: DurationStats; children?: ReactNode }) {
  return (
    <StatTile
      label={label} icon={Timer}
      value={stats.count === 0 ? "—" : formatDuration(stats.median)}
      hint={stats.count === 0 ? "Nothing measured yet" : `median · average ${formatDuration(stats.average)} · 90% within ${formatDuration(stats.p90)} · ${stats.count} measured`}
    >
      {children}
    </StatTile>
  );
}

const pct = (n: number, of: number) => (of === 0 ? "—" : `${Math.round((n / of) * 100)}%`);

/** A horizontal bar chart on a card, one bar per row, longest first; the rows are also listed for screen readers. */
function Bars({ title, rows, empty }: { title: string; rows: { label: string; count: number }[]; empty: string }) {
  const { rows: drawn, motion } = useGrowMotion(rows, ["count"], rows.map((r) => r.label).join("|"));
  const config = { count: { label: "Count", color: "var(--chart-1)" } } satisfies ChartConfig;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <>
            <ChartContainer config={config} className="aspect-auto w-full" style={{ height: rows.length * 36 + 8 }}>
              <BarChart data={drawn} layout="vertical" margin={{ top: 0, right: 32, bottom: 0, left: 0 }}>
                <XAxis type="number" dataKey="count" hide />
                <YAxis type="category" dataKey="label" width={140} tickLine={false} axisLine={false} interval={0} />
                <ChartTooltip cursor={false} content={<ChartTooltipContent hideIndicator />} />
                <Bar dataKey="count" fill="var(--color-count)" radius={4} {...motion} label={{ position: "right", className: "fill-muted-foreground text-xs tabular-nums" }} />
              </BarChart>
            </ChartContainer>
            <ul className="sr-only">
              {rows.map((r) => (
                <li key={r.label}>{`${r.label}: ${r.count}`}</li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** A change against the previous period; lower is better for every metric shown with it (reply time, handoff rate). */
function TrendBadge({ change, days, text }: { change: number; days: number; text: (abs: number) => string }) {
  if (change === 0) return <Badge variant="outline" className="self-start font-normal text-muted-foreground">Same as previous {days} days</Badge>;
  const better = change < 0;
  const Icon = better ? TrendingDown : TrendingUp;
  return (
    <Badge variant="outline" className={better ? "self-start font-normal text-success" : "self-start font-normal text-destructive"}>
      <Icon aria-hidden />
      {text(Math.abs(change))} than previous {days} days
    </Badge>
  );
}

const rateConfig = { rate: { label: "Handoff rate", color: "var(--chart-2)" } } satisfies ChartConfig;

/**
 * Handoff rate per day (7 days) or per 7-day week counted back from now (longer periods), so quiet days do not swing
 * the chart. Weeks come from the server, which counts each conversation once per week.
 */
function rateBuckets(data: HandoffAnalytics) {
  const rows =
    data.daily.length <= 8
      ? data.daily.map((d) => ({ label: dayLabel(d.date), active: d.active, handedOff: d.handedOff }))
      : data.weekly.map((w) => ({ label: `${dayLabel(w.from)} – ${dayLabel(w.to)}`, active: w.active, handedOff: w.handedOff }));
  // A handoff can land on a day its conversation had no message, so the rate is capped at 100%.
  return rows.map((r) => ({ ...r, rate: r.active === 0 ? null : Math.min(100, Math.round((r.handedOff / r.active) * 100)) }));
}

/** The handoff rate, its change from the previous period in points, and bars per day or week with the period's average. */
function HandoffRateTile({ data }: { data: HandoffAnalytics }) {
  const bars = rateBuckets(data);
  const { rows: drawnBars, motion } = useGrowMotion(bars, ["rate"]);
  const active = bars.reduce((s, b) => s + b.active, 0);
  const average = active === 0 ? null : Math.round((bars.reduce((s, b) => s + b.handedOff, 0) / active) * 100);
  const now = data.handoffRate;
  const before = data.previousHandoffRate;
  const points = now === null || before === null ? null : Math.round((now - before) * 100);
  return (
    <StatTile label="Handoff rate" icon={Percent} value={now === null ? "—" : `${Math.round(now * 100)}%`} hint="Active conversations handed to people at least once">
      <div className="flex flex-col gap-3">
        {points !== null && <TrendBadge change={points} days={data.days} text={(n) => `${n} ${n === 1 ? "pt" : "pts"} ${points < 0 ? "lower" : "higher"}`} />}
        {average !== null && (
          <ChartContainer config={rateConfig} className="aspect-auto h-16 w-full">
            <BarChart data={drawnBars} margin={{ top: 4, right: 0, bottom: 0, left: 0 }} barCategoryGap="15%">
              <XAxis dataKey="label" hide />
              <YAxis domain={[0, (max: number) => Math.max(max, average) * 1.1]} hide />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    hideIndicator
                    formatter={(_, __, item) => (item.payload.rate === null ? "No conversations" : `${item.payload.rate}% · ${item.payload.handedOff} of ${item.payload.active} handed off`)}
                  />
                }
              />
              <ReferenceLine y={average} stroke="var(--muted-foreground)" strokeDasharray="3 3" ifOverflow="extendDomain" />
              <Bar dataKey="rate" fill="var(--color-rate)" radius={[2, 2, 0, 0]} {...motion} />
            </BarChart>
          </ChartContainer>
        )}
      </div>
    </StatTile>
  );
}

const BAND_KEYS = ["b0", "b1", "b2", "b3"] as const;
const BAND_COLORS = ["var(--success)", "var(--info)", "var(--warning)", "var(--destructive)"] as const;

/** "under 5s", "5s–15s", "15s–1m", "over 1m" for one side's band edges. */
const bandLabels = (edges: readonly number[]) => [
  `under ${formatDuration(edges[0]!)}`,
  ...edges.slice(1).map((e, i) => `${formatDuration(edges[i]!)}–${formatDuration(e)}`),
  `over ${formatDuration(edges.at(-1)!)}`,
];

/** Median against the period before: green when faster, red when slower, nothing when either side is missing. */
function ChangeBadge({ now, before, days }: { now: number | null; before: number | null; days: number }) {
  if (now === null || before === null || before === 0) return null;
  const change = Math.round(((now - before) / before) * 100);
  return <TrendBadge change={change} days={days} text={(n) => `${n}% ${change < 0 ? "faster" : "slower"}`} />;
}

/** Share of replies in each speed band, as one stacked bar with a legend underneath. */
function ReplyBands({ counts, edges }: { counts: number[]; edges: readonly number[] }) {
  const motion = useChartMotion();
  const total = counts.reduce((s, n) => s + n, 0);
  if (total === 0) return null;
  const labels = bandLabels(edges);
  const config = Object.fromEntries(BAND_KEYS.map((k, i) => [k, { label: labels[i], color: BAND_COLORS[i] }])) satisfies ChartConfig;
  const row = Object.fromEntries(BAND_KEYS.map((k, i) => [k, counts[i] ?? 0]));
  const share = (n: number) => `${Math.round((n / total) * 100)}%`;
  return (
    <div className="flex flex-col gap-2">
      <ChartContainer config={config} className="aspect-auto h-3 w-full">
        <BarChart data={[row]} layout="vertical" stackOffset="expand" margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
          <XAxis type="number" hide />
          <YAxis type="category" hide />
          <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel indicator="dot" formatter={(v, name) => `${config[name as (typeof BAND_KEYS)[number]].label}: ${v} (${share(Number(v))})`} />} />
          {BAND_KEYS.map((k, i) => (
            <Bar key={k} dataKey={k} stackId="bands" fill={`var(--color-${k})`} radius={i === 0 ? [4, 0, 0, 4] : i === BAND_KEYS.length - 1 ? [0, 4, 4, 0] : 0} animationBegin={i * 120} {...motion} />
          ))}
        </BarChart>
      </ChartContainer>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        {BAND_KEYS.map((k, i) => (
          <li key={k} className="flex items-center gap-2">
            <span className="size-2 shrink-0 rounded-[2px]" style={{ backgroundColor: BAND_COLORS[i] }} aria-hidden />
            <span className="flex-1 truncate text-muted-foreground">{labels[i]}</span>
            <span className="tabular-nums">{share(counts[i] ?? 0)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A reply-time tile: the median, its change from the previous period, and how replies spread across speed bands. */
function ReplyTile({ label, side, data }: { label: string; side: "ai" | "human"; data: HandoffAnalytics }) {
  const stats = data.replyTime[side];
  return (
    <DurationTile label={label} stats={stats}>
      <div className="flex flex-col gap-3">
        <ChangeBadge now={stats.median} before={data.previousReplyMedian[side]} days={data.days} />
        <ReplyBands counts={data.replyBands[side]} edges={REPLY_BANDS[side]} />
      </div>
    </DurationTile>
  );
}

const sentimentConfig = {
  positive: { label: SENTIMENT_LABELS.positive, color: "var(--success)" },
  neutral: { label: SENTIMENT_LABELS.neutral, color: "var(--muted-foreground)" },
  mixed: { label: SENTIMENT_LABELS.mixed, color: "var(--warning)" },
  negative: { label: SENTIMENT_LABELS.negative, color: "var(--destructive)" },
} satisfies ChartConfig;

/** Analyzed conversations per day as stacked bars by sentiment, small, for the bottom of the sentiment tile. */
function SentimentSpark({ rows }: { rows: InsightsOverview["sentimentDaily"] }) {
  const keys = Object.keys(sentimentConfig) as (keyof typeof sentimentConfig)[];
  const { rows: drawn, motion } = useGrowMotion(rows, keys);
  if (rows.length === 0) return null;
  return (
    <ChartContainer config={sentimentConfig} className="aspect-auto h-16 w-full">
      <BarChart data={drawn} margin={{ top: 4, right: 0, bottom: 0, left: 0 }} barCategoryGap="15%">
        <XAxis dataKey="date" hide />
        <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" labelFormatter={(d) => dayLabel(String(d))} />} />
        {keys.map((k, i) => (
          <Bar key={k} dataKey={k} stackId="sentiment" fill={`var(--color-${k})`} radius={i === keys.length - 1 ? [2, 2, 0, 0] : 0} animationBegin={i * 120} {...motion} />
        ))}
      </BarChart>
    </ChartContainer>
  );
}

const resolutionConfig = {
  resolved: { label: RESOLUTION_LABELS.resolved, color: "var(--success)" },
  with_people: { label: RESOLUTION_LABELS.with_people, color: "var(--info)" },
  open: { label: RESOLUTION_LABELS.open, color: "var(--warning)" },
} satisfies ChartConfig;

/** How the analyzed conversations stand: a small donut beside a legend with counts, for the bottom of the resolved tile. */
function ResolutionDonut({ resolution }: { resolution: InsightsOverview["resolution"] }) {
  const motion = useChartMotion();
  const data = (Object.keys(resolutionConfig) as (keyof typeof resolutionConfig)[]).map((k) => ({ key: k, count: resolution[k] }));
  if (data.every((d) => d.count === 0)) return null;
  return (
    <div className="flex items-center gap-4">
      <ChartContainer config={resolutionConfig} className="aspect-square h-16 shrink-0">
        <PieChart>
          <ChartTooltip cursor={false} content={<ChartTooltipContent nameKey="key" hideLabel />} />
          <Pie data={data} dataKey="count" nameKey="key" innerRadius={20} outerRadius={32} strokeWidth={2} {...motion}>
            {data.map((d) => (
              <Cell key={d.key} fill={`var(--color-${d.key})`} />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
      <ul className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
        {data.map((d) => (
          <li key={d.key} className="flex items-center gap-2">
            <span className="size-2 shrink-0 rounded-[2px]" style={{ backgroundColor: resolutionConfig[d.key].color }} aria-hidden />
            <span className="flex-1 truncate text-muted-foreground">{resolutionConfig[d.key].label}</span>
            <span className="tabular-nums">{d.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Phase 15: languages, code-switching, sentiment, intents, entities, resolution and escalation over the period. */
function Insights({ data }: { data: InsightsOverview }) {
  const n = data.analyzed;
  return (
    <>
      <div>
        <p className="text-sm text-muted-foreground">
          Read from customers&apos; messages: {n === data.conversations ? `${n} conversations` : `the newest ${n} of ${data.conversations} conversations`}. Languages
          describe messages, not people.
        </p>
      </div>
      <section aria-label="Conversation intelligence" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Mixed-language conversations" icon={Languages} value={pct(data.codeSwitched, n)} hint={`${data.codeSwitched} with Hinglish or mixed scripts · ${data.withSwitches} switched language`} />
        <StatTile label="Negative sentiment" icon={Frown} value={pct(data.sentiment.negative, n)} hint={`${data.sentiment.positive} positive · ${data.sentiment.mixed} mixed · ${data.sentiment.neutral} neutral`}>
          <SentimentSpark rows={data.sentimentDaily} />
        </StatTile>
        <StatTile label="Resolved" icon={CircleCheck} value={pct(data.resolution.resolved, n)} hint={`${data.resolution.with_people} with people · ${data.resolution.open} open`}>
          <ResolutionDonut resolution={data.resolution} />
        </StatTile>
        <StatTile
          label="Escalated" icon={TriangleAlert}
          value={data.escalation.rate === null ? "—" : `${Math.round(data.escalation.rate * 100)}%`}
          hint={`${data.escalation.conversations} handed off · ${data.escalation.withSignals} customers threatened to escalate`}
        />
      </section>
      <div className="grid gap-4 lg:grid-cols-3">
        <Bars
          title="Languages"
          rows={data.languages.map((l) => ({ label: DETECTED_LANGUAGES[l.language], count: l.conversations }))}
          empty="No customer messages in this period."
        />
        <Bars title="Intents" rows={data.intents.map((i) => ({ label: INTENTS[i.intent], count: i.conversations }))} empty="No customer messages in this period." />
        <Bars
          title="Details customers gave"
          rows={data.entities.map((e) => ({ label: ENTITY_TYPES[e.type], count: e.count }))}
          empty="No names, numbers, addresses, dates or amounts found."
        />
      </div>
    </>
  );
}

/** Overview tab: the four trends and what is waiting for people right now. */
function OverviewTab({ data }: { data: HandoffAnalytics }) {
  return (
    <>
      <section aria-label="Trends" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Conversations started" icon={MessagesSquare} value={String(total(data.daily, "conversations"))} hint={`${data.conversations} active in this period`}>
          <Spark rows={data.daily} series="conversations" label="Started" />
        </StatTile>
        <StatTile label="Handoffs" icon={ArrowRightLeft} value={String(data.handoffs)} hint="Handed to people">
          <Spark rows={data.daily} series="handoffs" label="Handoffs" />
        </StatTile>
        <HandoffRateTile data={data} />
        <StatTile label="Resolved by people" icon={UserRoundCheck} value={String(data.outcomes.resolved)} hint={`${data.outcomes.returnedToAi} returned to the AI · ${data.outcomes.open} still open`}>
          <Spark rows={data.daily} series="resolved" label="Resolved" />
        </StatTile>
      </section>
      <section aria-label="Right now" className="grid gap-3 sm:grid-cols-3">
        <StatTile label="In the queue now" icon={Inbox} value={String(data.open.queue)} hint="Waiting, no one assigned" />
        <StatTile label="Assigned, not picked up" icon={UserCheck} value={String(data.open.assigned)} />
        <StatTile label="Being answered by people" icon={Headset} value={String(data.open.humanActive)} />
      </section>
    </>
  );
}

/** Handoffs tab: how fast people take over, why conversations were handed off, and each agent's share. */
function HandoffsTab({ data, nameOf }: { data: HandoffAnalytics; nameOf: (id: string) => string }) {
  return (
    <>
      <section aria-label="Handoff times" className="grid gap-3 sm:grid-cols-3">
        <DurationTile label="Time until a person took over" stats={data.timeToAccept} />
        <DurationTile label="Time to a person's first reply" stats={data.timeToFirstResponse} />
        <DurationTile label="Time to resolve" stats={data.timeToResolve} />
      </section>
      <div className="grid gap-4 lg:grid-cols-2">
        <Bars
          title="Why conversations were handed off"
          rows={data.byTrigger.map((t) => ({ label: HANDOFF_TRIGGER_LABELS[t.trigger], count: t.count }))}
          empty="No handoffs in this period."
        />
        <Card>
          <CardHeader>
            <CardTitle>By agent</CardTitle>
          </CardHeader>
          <CardContent>
            {data.byAgent.length === 0 ? (
              <p className="text-sm text-muted-foreground">No agent has handled a handoff in this period.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    <TableHead className="text-right">Handoffs</TableHead>
                    <TableHead className="text-right">Resolved</TableHead>
                    <TableHead className="text-right">First reply (median)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.byAgent.map((a) => (
                    <TableRow key={a.agentId}>
                      <TableCell>{nameOf(a.agentId)}</TableCell>
                      <TableCell className="text-right tabular-nums">{a.handoffs}</TableCell>
                      <TableCell className="text-right tabular-nums">{a.resolved}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatDuration(a.firstResponse.median)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

/** Reply times tab: AI and human reply speed against the previous period, and how much of the Copilot's help was used. */
function RepliesTab({ data }: { data: HandoffAnalytics }) {
  return (
    <section aria-label="Reply times" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <ReplyTile label="AI reply time" side="ai" data={data} />
      <ReplyTile label="Human reply time" side="human" data={data} />
      <StatTile
        label="Copilot suggestions used" icon={Sparkles}
        value={data.suggestions.total === 0 ? "—" : `${data.suggestions.used} of ${data.suggestions.total}`}
        hint={data.suggestions.total === 0 ? "No suggestions in this period" : `${pct(data.suggestions.used, data.suggestions.total)} of suggestions went into a reply`}
      />
    </section>
  );
}

const HANDOFF_TABS = [
  { value: "overview", label: "Overview" },
  { value: "handoffs", label: "Handoffs" },
  { value: "replies", label: "Reply times" },
] as const;

export default withWorkspace(function AnalyticsPage({ workspace }) {
  const [days, setDays] = useState<number>(30);
  const { data, error, reload, loading: handoffsLoading } = useApiQuery<HandoffAnalytics>(`/workspaces/${workspace.id}/handoffs/analytics?days=${days}`, { keepPrevious: true });
  const [tab, setTab] = usePageTab("/analytics");
  // Conversation intelligence is the costliest report; it loads once its tab is first opened, then stays loaded.
  const [intelligenceOpened, setIntelligenceOpened] = useState(false);
  if (tab === "intelligence" && !intelligenceOpened) setIntelligenceOpened(true);
  const insights = useApiQuery<InsightsOverview>(intelligenceOpened || tab === "intelligence" ? `/workspaces/${workspace.id}/insights?days=${days}` : null, { keepPrevious: true });
  const { nameOf } = useMembers();
  // Charts animate on the first load only; after a tab switch (click, Alt+number or the command menu) they appear straight away.
  const [shownTab, setShownTab] = useState(tab);
  const [switched, setSwitched] = useState(false);
  if (tab !== shownTab) {
    setShownTab(tab);
    setSwitched(true);
  }
  // A new period is loading while the last one is still shown.
  const stale = (handoffsLoading && data !== undefined) || (insights.loading && insights.data !== undefined);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Analytics"
        description="How often AI employees hand conversations to people, why, how quickly people and the AI answer, and what customers talk about."
      >
        <div className="flex items-center gap-2">
        {stale && <Spinner className="text-muted-foreground" aria-label="Loading the new period" />}
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger aria-label="Period" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIODS.map((d) => (
              <SelectItem key={d} value={String(d)}>
                Last {d} days
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        </div>
      </PageHeader>

      <ChartMotionProvider animate={!switched}>
      <Tabs value={tab} onValueChange={setTab} className="gap-4">
        <TabsList>
          {HANDOFF_TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
          <TabsTrigger value="intelligence">Conversation intelligence</TabsTrigger>
        </TabsList>

        {HANDOFF_TABS.map((t) => (
          <TabsContent key={t.value} value={t.value} className={cn("flex flex-col gap-4 transition-opacity duration-200", stale && "opacity-60")} aria-busy={stale}>
            {error && !data ? (
              <ErrorState message={error.message} onRetry={reload} />
            ) : (
              <Skullet data={data} sample={SAMPLE_HANDOFFS} id={`analytics-${t.value}`} label="Loading analytics">
                {(data) =>
                  t.value === "overview" ? <OverviewTab data={data} /> : t.value === "handoffs" ? <HandoffsTab data={data} nameOf={nameOf} /> : <RepliesTab data={data} />
                }
              </Skullet>
            )}
          </TabsContent>
        ))}

        <TabsContent value="intelligence" className={cn("flex flex-col gap-4 transition-opacity duration-200", stale && "opacity-60")} aria-busy={stale}>
          {insights.error && !insights.data ? (
            <ErrorState message={insights.error.message} onRetry={insights.reload} />
          ) : (
            <Skullet data={insights.data} sample={SAMPLE_INSIGHTS} id="analytics-insights" label="Loading conversation intelligence">
              {(data) => <Insights data={data} />}
            </Skullet>
          )}
        </TabsContent>
      </Tabs>
      </ChartMotionProvider>
    </div>
  );
});
