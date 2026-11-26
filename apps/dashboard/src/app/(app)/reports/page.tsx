"use client";

import type { AnalyticsReport, DurationStats, ToolExecutionStatus, WorkflowExecutionStatus } from "@workforce/shared";
import { ChevronDown, CircleCheck, Coins, DollarSign, Gauge as GaugeIcon, Hourglass, MessageSquare, MessagesSquare, Phone, Timer, TriangleAlert, Workflow, Wrench } from "lucide-react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { useState } from "react";
import { CHANNEL_LABELS, formatDuration } from "@/components/inbox/meta";
import { Skeleton as Skullet } from "skullet/react";
import { DateRangePicker } from "@/components/date-range-picker";
import { useGrowMotion } from "@/components/chart-motion";
import { Gauge, SplitBar, type Segment } from "@/components/charts";
import { Reveal } from "@/components/reveal";
import { ErrorState, PageHeader, StatTile } from "@/components/states";
import { TablePager, usePaged } from "@/components/table-pager";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Spinner } from "@/components/ui/spinner";
import { useApiQuery } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useWorkspaces } from "@/lib/workspace";

const ALL = "all";
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000));
const n = (v: number) => v.toLocaleString("en-US");
const usd = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE: AnalyticsReport = {
  from: "2026-01-01T00:00:00.000Z",
  to: "2026-01-31T00:00:00.000Z",
  workspaceId: null,
  conversations: { total: 1240, byChannel: [{ channel: "WEB", count: 820 }, { channel: "WHATSAPP", count: 420 }] },
  calls: { total: 310, completed: 290, minutes: 1450 },
  messages: { customer: 5200, ai: 5100, agent: 300 },
  tokens: { input: 1_200_000, output: 450_000 },
  toolExecutions: { total: 640, byStatus: [{ status: "SUCCEEDED", count: 600 }, { status: "FAILED", count: 40 }] },
  workflowExecutions: { total: 120, byStatus: [{ status: "COMPLETED", count: 110 }, { status: "FAILED", count: 10 }] },
  resolutions: 980,
  escalations: 60,
  humanHandoffs: 45,
  latency: { aiReply: { count: 5100, average: 1800, median: 1500, p90: 3200 }, provider: { count: 5100, average: 1200, median: 1000, p90: 2400 } },
  cost: { billedUsd: 1234.56 },
  quality: { evaluations: 200, averageScore: 86, passRate: 0.9 },
  daily: Array.from({ length: 5 }, (_, i) => ({ date: `2026-01-0${i + 1}`, conversations: 40, messages: 360, billedUsd: 41.2 })),
};

const latency = (s: DurationStats) => (s.count === 0 ? "Nothing measured" : `median ${formatDuration(s.median)} · 90% within ${formatDuration(s.p90)} · ${n(s.count)} measured`);

export default function ReportsPage() {
  const { workspaces } = useWorkspaces();
  const today = isoDay(new Date());
  // The end date is inclusive in the form; the API's `to` is exclusive, so a day is added.
  const [from, setFrom] = useState(addDays(today, -29));
  const [to, setTo] = useState(today);
  const [workspaceId, setWorkspaceId] = useState(ALL);
  const valid = from <= to;
  const query = valid ? `/analytics/report?from=${from}&to=${addDays(to, 1)}${workspaceId === ALL ? "" : `&workspaceId=${workspaceId}`}` : null;
  const { data, error, reload, loading } = useApiQuery<AnalyticsReport>(query, { keepPrevious: true });
  const stale = loading && data !== undefined;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Reports" description="Everything your organization did in a date range: conversations, calls, AI usage, outcomes, latency, cost and quality.">
        <div className="flex flex-wrap items-end gap-3">
          {stale && <Spinner className="mb-2.5 text-muted-foreground" aria-label="Loading the new range" />}
          <div className="flex flex-col gap-1">
            <Label htmlFor="report-range">Date range</Label>
            <DateRangePicker
              id="report-range"
              from={from}
              to={to}
              onChange={(f, t) => {
                setFrom(f);
                setTo(t);
              }}
            />
          </div>
          <Select value={workspaceId} onValueChange={setWorkspaceId}>
            <SelectTrigger aria-label="Workspace" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All workspaces</SelectItem>
              {(workspaces ?? []).map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </PageHeader>

      {!valid ? (
        <p className="text-sm text-destructive">The start date must be on or before the end date.</p>
      ) : error && !data ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : (
        <div className={cn("transition-opacity duration-200", stale && "opacity-60")} aria-busy={stale}>
          <Skullet data={data} sample={SAMPLE} id="reports-summary" label="Loading report">
            {(data) => <Report data={data} resetKey={query} />}
          </Skullet>
        </div>
      )}
    </div>
  );
}

const MOTION = { animationDuration: 700, animationEasing: "ease-out" } as const;
const dayLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const pct = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 100));

/** Median and 90th percentile as two short bars on the same scale, so the spread reads at a glance. */
function LatencyBars({ stats }: { stats: DurationStats }) {
  if (stats.count === 0 || stats.median === null || stats.p90 === null) return null;
  const config = { ms: { label: "Time", color: "var(--chart-2)" } } satisfies ChartConfig;
  const rows = [
    { label: "Median", ms: stats.median },
    { label: "90% within", ms: stats.p90 },
  ];
  return (
    <ChartContainer config={config} className="aspect-auto h-16 w-full" aria-hidden>
      <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 48, bottom: 0, left: 0 }} barCategoryGap="25%">
        <XAxis type="number" hide />
        <YAxis type="category" dataKey="label" width={72} tickLine={false} axisLine={false} tick={{ fontSize: 11 }} />
        <Bar
          dataKey="ms"
          fill="var(--color-ms)"
          background={{ fill: "var(--muted)", radius: 4 }}
          radius={4}
          label={{ position: "right", className: "fill-muted-foreground text-xs tabular-nums", formatter: (v: unknown) => formatDuration(Number(v)) }}
          {...MOTION}
        />
      </BarChart>
    </ChartContainer>
  );
}

/** Every status gets a label and a colour; a status added to the schema without one fails the type check. */
const TOOL_STATUS: Record<ToolExecutionStatus, { label: string; color: string }> = {
  SUCCEEDED: { label: "Succeeded", color: "var(--success)" },
  FAILED: { label: "Failed", color: "var(--destructive)" },
  DENIED: { label: "Not permitted", color: "var(--warning)" },
  INVALID: { label: "Invalid input", color: "var(--warning)" },
};
const WORKFLOW_STATUS: Record<WorkflowExecutionStatus, { label: string; color: string }> = {
  COMPLETED: { label: "Completed", color: "var(--success)" },
  FAILED: { label: "Failed", color: "var(--destructive)" },
  QUEUED: { label: "Queued", color: "var(--info)" },
  RUNNING: { label: "Running", color: "var(--info)" },
  WAITING: { label: "Waiting", color: "var(--info)" },
};
const statusSegments = <S extends string>(rows: { status: S; count: number }[], map: Record<S, { label: string; color: string }>): Segment[] =>
  rows.map((r) => ({ key: r.status.toLowerCase(), label: map[r.status].label, value: r.count, color: map[r.status].color }));

const METRICS = {
  conversations: { label: "Conversations", color: "var(--chart-1)", format: n },
  messages: { label: "Messages", color: "var(--chart-1)", format: n },
  billedUsd: { label: "Usage billed", color: "var(--chart-1)", format: usd },
} as const;
type Metric = keyof typeof METRICS;

/** Daily rows for ranges up to a month, 7-day weeks counted back from the last day beyond that. */
function buckets(daily: AnalyticsReport["daily"]) {
  const size = daily.length <= 31 ? 1 : 7;
  const out: { label: string; conversations: number; messages: number; billedUsd: number }[] = [];
  for (let end = daily.length; end > 0; end -= size) {
    const chunk = daily.slice(Math.max(0, end - size), end);
    const first = chunk[0]!.date;
    const last = chunk.at(-1)!.date;
    out.unshift({
      label: first === last ? dayLabel(first) : `${dayLabel(first)} – ${dayLabel(last)}`,
      conversations: chunk.reduce((s, d) => s + d.conversations, 0),
      messages: chunk.reduce((s, d) => s + d.messages, 0),
      billedUsd: chunk.reduce((s, d) => s + d.billedUsd, 0),
    });
  }
  return { rows: out, weekly: size > 1 };
}

/** One metric over the range, picked from its total in the header (the shadcn interactive-chart pattern). */
function ActivityChart({ data }: { data: AnalyticsReport }) {
  const [metric, setMetric] = useState<Metric>("conversations");
  const { rows, weekly } = buckets(data.daily);
  const totals: Record<Metric, number> = {
    conversations: rows.reduce((s, r) => s + r.conversations, 0),
    messages: rows.reduce((s, r) => s + r.messages, 0),
    billedUsd: rows.reduce((s, r) => s + r.billedUsd, 0),
  };
  const m = METRICS[metric];
  const config = { [metric]: { label: m.label, color: m.color } } satisfies ChartConfig;
  // One Area for every metric, so switching metric or range morphs the shape instead of redrawing it.
  const { rows: drawn, motion } = useGrowMotion(rows, [metric]);
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex flex-col gap-4 border-b py-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-col gap-1">
          <CardTitle>Activity over time</CardTitle>
          <CardDescription>{weekly ? "Per week, counted back from the last day (UTC)" : "Per day (UTC)"}</CardDescription>
        </div>
        <ToggleGroup type="single" variant="outline" value={metric} onValueChange={(v) => v && setMetric(v as Metric)} aria-label="Metric">
          {(Object.keys(METRICS) as Metric[]).map((k) => (
            <ToggleGroupItem key={k} value={k} className="h-auto flex-col items-start gap-0.5 px-4 py-2">
              <span className="text-xs text-muted-foreground">{METRICS[k].label}</span>
              <span className="text-lg font-bold tabular-nums">{METRICS[k].format(totals[k])}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </CardHeader>
      <CardContent className="py-5">
        <ChartContainer config={config} className="aspect-auto h-64 w-full">
          <AreaChart data={drawn} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
            <defs>
              <linearGradient id="report-activity" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={`var(--color-${metric})`} stopOpacity={0.5} />
                <stop offset="95%" stopColor={`var(--color-${metric})`} stopOpacity={0.15} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={32} tickFormatter={(v: string) => v.split(" – ")[0] ?? v} />
            <YAxis tickLine={false} axisLine={false} width={metric === "billedUsd" ? 56 : 40} allowDecimals={metric === "billedUsd"} tickFormatter={(v: number) => m.format(v)} />
            <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" formatter={(v) => `${m.label}: ${m.format(Number(v))}`} />} />
            <Area dataKey={metric} type="bumpX" strokeLinejoin="round" stroke={`var(--color-${metric})`} fill="url(#report-activity)" strokeWidth={2} {...motion} />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

const CATEGORY_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"] as const;

function Report({ data, resetKey }: { data: AnalyticsReport; resetKey: string | null }) {
  const days = usePaged([...data.daily].reverse(), 14, resetKey);
  const messages = data.messages.customer + data.messages.ai + data.messages.agent;
  const resolvedShare = pct(data.resolutions, data.conversations.total);
  const score = data.quality.averageScore;
  return (
    // Skullet wraps its content in a block, so this keeps the gaps the page used to give.
    <div className="flex flex-col gap-6">
      <section aria-label="Activity" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Conversations" icon={MessagesSquare} value={n(data.conversations.total)} hint="By channel">
          <SplitBar
            segments={data.conversations.byChannel.map((c, i) => ({
              key: c.channel.toLowerCase(),
              label: CHANNEL_LABELS[c.channel] ?? c.channel,
              value: c.count,
              color: CATEGORY_COLORS[i % CATEGORY_COLORS.length]!,
            }))}
          />
        </StatTile>
        <StatTile label="Calls" icon={Phone} value={n(data.calls.total)} hint={`${n(data.calls.minutes)} minutes`}>
          <SplitBar
            segments={[
              { key: "completed", label: "Completed", value: data.calls.completed, color: "var(--success)" },
              { key: "other", label: "Not completed", value: data.calls.total - data.calls.completed, color: "var(--muted-foreground)" },
            ]}
          />
        </StatTile>
        <StatTile label="Messages" icon={MessageSquare} value={n(messages)} hint="By who sent them">
          <SplitBar
            segments={[
              { key: "customer", label: "Customers", value: data.messages.customer, color: "var(--chart-1)" },
              { key: "ai", label: "AI", value: data.messages.ai, color: "var(--chart-3)" },
              { key: "agent", label: "People", value: data.messages.agent, color: "var(--info)" },
            ]}
          />
        </StatTile>
        <StatTile label="AI tokens" icon={Coins} value={n(data.tokens.input + data.tokens.output)} hint="Read and written by the AI">
          <SplitBar
            segments={[
              { key: "input", label: "In", value: data.tokens.input, color: "var(--chart-2)" },
              { key: "output", label: "Out", value: data.tokens.output, color: "var(--chart-4)" },
            ]}
          />
        </StatTile>
      </section>

      <ActivityChart data={data} />

      <section aria-label="Outcomes" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Resolved conversations" icon={CircleCheck} value={n(data.resolutions)} hint={data.conversations.total === 0 ? "No conversations" : `${resolvedShare}% of conversations in the range`}>
          {data.conversations.total > 0 && (
            <Reveal height={64}>
              <Gauge value={Math.min(100, resolvedShare)} color="var(--success)" />
            </Reveal>
          )}
        </StatTile>
        <StatTile label="Escalations" icon={TriangleAlert} value={n(data.escalations)} hint="Handed to people">
          <Reveal height={40}>
          <SplitBar
            segments={[
              { key: "accepted", label: "Accepted by a person", value: data.humanHandoffs, color: "var(--info)" },
              // Both counts are handoffs requested in the range; accepted ones are a subset, so this is never negative.
              { key: "waiting", label: "Not accepted", value: data.escalations - data.humanHandoffs, color: "var(--warning)" },
            ]}
          />
          </Reveal>
        </StatTile>
        <StatTile
          label="Quality score" icon={GaugeIcon}
          value={score === null ? "—" : String(score)}
          hint={data.quality.evaluations === 0 ? "No evaluations" : `${pct(data.quality.passRate ?? 0, 1)}% passed · ${n(data.quality.evaluations)} evaluated`}
        >
          {score !== null && (
            <Reveal height={64}>
              <Gauge value={score} color={score >= 80 ? "var(--success)" : score >= 60 ? "var(--warning)" : "var(--destructive)"} />
            </Reveal>
          )}
        </StatTile>
        <StatTile
          label="Usage billed" icon={DollarSign} value={usd(data.cost.billedUsd)}
          hint={data.daily.length > 0 ? `${usd(data.cost.billedUsd / data.daily.length)} a day on average` : undefined}
        />
      </section>

      <section aria-label="Executions and latency" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Tool executions" icon={Wrench} value={n(data.toolExecutions.total)} hint="By status">
          <Reveal height={40}>
            <SplitBar segments={statusSegments(data.toolExecutions.byStatus, TOOL_STATUS)} />
          </Reveal>
        </StatTile>
        <StatTile label="Workflow runs" icon={Workflow} value={n(data.workflowExecutions.total)} hint="By status">
          <Reveal height={40}>
            <SplitBar segments={statusSegments(data.workflowExecutions.byStatus, WORKFLOW_STATUS)} />
          </Reveal>
        </StatTile>
        <StatTile label="AI reply latency" icon={Timer} value={formatDuration(data.latency.aiReply.median)} hint={latency(data.latency.aiReply)}>
          <Reveal height={64}>
            <LatencyBars stats={data.latency.aiReply} />
          </Reveal>
        </StatTile>
        <StatTile label="Provider latency" icon={Hourglass} value={formatDuration(data.latency.provider.median)} hint={latency(data.latency.provider)}>
          <Reveal height={64}>
            <LatencyBars stats={data.latency.provider} />
          </Reveal>
        </StatTile>
      </section>

      <Collapsible asChild>
        <Card className="gap-0 py-0">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="group h-auto justify-between rounded-xl px-6 py-4">
              <span className="font-semibold">Daily numbers (UTC)</span>
              <ChevronDown className="transition-transform group-data-[state=open]:rotate-180" aria-hidden />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="overflow-x-auto border-t py-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Day</TableHead>
                    <TableHead className="text-right">Conversations</TableHead>
                    <TableHead className="text-right">Messages</TableHead>
                    <TableHead className="text-right">Usage billed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {days.rows.map((d) => (
                    <TableRow key={d.date}>
                      <TableCell>{d.date}</TableCell>
                      <TableCell className="text-right tabular-nums">{n(d.conversations)}</TableCell>
                      <TableCell className="text-right tabular-nums">{n(d.messages)}</TableCell>
                      <TableCell className="text-right tabular-nums">{usd(d.billedUsd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <TablePager {...days.pager} />
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>
    </div>
  );
}
