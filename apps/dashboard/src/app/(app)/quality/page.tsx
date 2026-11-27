"use client";

import {
  EVAL_DIMENSION_LABELS,
  EVAL_DIMENSIONS,
  EVALUATOR_KIND_LABELS,
  type DatasetSummary,
  type EvalDimension,
  type EvaluationRecord,
  type EvaluatorInfo,
  type QualityOverview,
  ATTENTION_DEFAULTS,
  type Attention,
} from "@workforce/shared";
import { CircleCheck, CircleX, ClipboardCheck, Database, Gauge, Plus, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, XAxis, YAxis } from "recharts";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { timeAgo } from "@/components/inbox/meta";
import { formatRate, formatScore, Provenance, ResultBadge } from "@/components/quality/meta";
import { Skeleton as Skullet } from "skullet/react";
import { ChartMotionProvider, useGrowMotion } from "@/components/chart-motion";
import { Gauge as GaugeChart, SplitBar } from "@/components/charts";
import { Reveal } from "@/components/reveal";
import { EmptyState, ErrorState, PageHeader, StatTile } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApi, useApiQuery } from "@/lib/api";
import { usePageTab } from "@/lib/tabs";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useIsAdmin, withWorkspace } from "@/lib/workspace";

const PERIODS = [7, 30, 90] as const;
const ALL = "all";

const SAMPLE_DATE = "2026-01-01T00:00:00.000Z";
const SAMPLE_NAMES = ["Priya Support", "Arjun Sales", "Meera Billing", "Rahul Onboarding"];

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE_OVERVIEW: QualityOverview = {
  days: 30,
  evaluations: 128,
  averageScore: 82,
  passRate: 0.86,
  passing: 110,
  judged: 128,
  failures: 18,
  byDimension: EVAL_DIMENSIONS.slice(0, 5).map((dimension) => ({ dimension, results: 120, averageScore: 80, passRate: 0.85 })),
  trend: Array.from({ length: 6 }, (_, i) => ({ day: `2026-01-0${i + 1}`, evaluations: 20, averageScore: 80, passRate: 0.85 })),
  byEmployee: SAMPLE_NAMES.map((name, i) => ({
    employeeId: `sample-${i}`,
    name,
    evaluations: 32,
    averageScore: 82,
    passRate: 0.86,
    dimensions: { correctness: 84, tone: 90, resolution: 76 },
  })),
  byVersion: SAMPLE_NAMES.map((name, i) => ({ employeeId: `sample-${i}`, name, version: 3, evaluations: 32, averageScore: 82, passRate: 0.86 })),
  topFailures: SAMPLE_NAMES.slice(0, 3).map((_, i) => ({ evaluatorId: `sample-${i}`, name: "Answer is grounded in knowledge", dimension: "grounding", failures: 6 })),
};

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE_FAILURES: EvaluationRecord[] = SAMPLE_NAMES.map((name, i) => ({
  id: `sample-${i}`,
  conversationId: `sample-${i}`,
  conversationTitle: "Customer asked about a delayed refund",
  employee: { id: `sample-${i}`, name },
  employeeVersion: 3,
  provider: "openai",
  model: "gpt-4o-mini",
  workflow: null,
  trigger: "auto",
  status: "COMPLETED",
  score: 54,
  passed: false,
  failures: 1,
  messageCount: 12,
  error: null,
  createdAt: SAMPLE_DATE,
  completedAt: SAMPLE_DATE,
  results: [
    {
      id: `sample-result-${i}`,
      evaluatorId: "sample-evaluator",
      evaluatorName: "Answer is grounded in knowledge",
      evaluatorVersion: 1,
      dimension: "grounding",
      kind: "llm",
      status: "scored",
      score: 40,
      passed: false,
      reason: "The reply quoted a refund window that is not in the knowledge base.",
      findings: [],
    },
  ],
}));

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE_EVALUATORS: EvaluatorInfo[] = EVAL_DIMENSIONS.slice(0, 6).map((dimension, i) => ({
  id: `sample-${i}`,
  key: null,
  enabled: true,
  current: {
    id: `sample-version-${i}`,
    number: 1,
    createdBy: "system",
    createdAt: SAMPLE_DATE,
    name: "Answer is grounded in knowledge",
    description: "",
    dimension,
    passScore: 70,
    kind: "llm",
    config: { rubric: "The answer only states facts found in the attached knowledge sources." },
  },
  recent: { results: 120, passed: 104, averageScore: 82 },
}));

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE_DATASETS: DatasetSummary[] = ["Pricing questions", "Refund requests", "Hindi and Hinglish callers"].map((name, i) => ({
  id: `sample-${i}`,
  name,
  description: "Real conversations that went wrong once",
  cases: 12,
  updatedAt: SAMPLE_DATE,
  lastRun: {
    id: `sample-run-${i}`,
    employee: { id: `sample-${i}`, name: "Priya Support" },
    employeeVersion: 3,
    status: "COMPLETED",
    score: 82,
    total: 12,
    passed: 11,
    failed: 1,
    error: null,
    createdAt: SAMPLE_DATE,
    completedAt: SAMPLE_DATE,
  },
}));

const dayLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
type TrendRow = QualityOverview["trend"][number];
/** Trend rows with the pass rate as 0..100, so score and pass rate share one axis. */
const trendRows = (trend: QualityOverview["trend"]) => trend.map((d) => ({ ...d, pass: d.passRate === null ? null : Math.round(d.passRate * 100) }));

/** Gauge colour for a 0-100 score: green from 80, amber from 60, red below. */
/** Gauge colour from the workspace's "quality score below" threshold: red under it, amber within 10 points above, green beyond. */
const scoreColor = (score: number, below: number) => (score < below ? "var(--destructive)" : score < below + 10 ? "var(--warning)" : "var(--success)");

/** Graded conversations split into passing and failing, from the exact counts. */
function PassSplit({ passing, judged }: { passing: number; judged: number }) {
  if (judged === 0) return null;
  return (
    <SplitBar
      segments={[
        { key: "passed", label: "Passed", value: passing, color: "var(--success)" },
        { key: "failed", label: "Failed a check", value: judged - passing, color: "var(--destructive)" },
      ]}
    />
  );
}

const gradedConfig = { evaluations: { label: "Graded", color: "var(--chart-2)" } } satisfies ChartConfig;

/**
 * Conversations graded per day (two weeks or less) or per 7-day week counted back from today, each bar on a faint track
 * so days with nothing graded still read as days. Hidden until at least two bars have something in them.
 */
function GradedBars({ trend }: { trend: QualityOverview["trend"] }) {
  const size = trend.length <= 14 ? 1 : 7;
  const rows: { label: string; evaluations: number }[] = [];
  for (let end = trend.length; end > 0; end -= size) {
    const chunk = trend.slice(Math.max(0, end - size), end);
    const first = chunk[0]!.day;
    const last = chunk.at(-1)!.day;
    rows.unshift({ label: first === last ? dayLabel(first) : `${dayLabel(first)} – ${dayLabel(last)}`, evaluations: chunk.reduce((s, d) => s + d.evaluations, 0) });
  }
  const { rows: drawn, motion } = useGrowMotion(rows, ["evaluations"]);
  if (rows.filter((r) => r.evaluations > 0).length < 2) return null;
  return (
    <ChartContainer config={gradedConfig} className="aspect-auto h-16 w-full">
      <BarChart data={drawn} margin={{ top: 4, right: 0, bottom: 0, left: 0 }} barCategoryGap="20%">
        <XAxis dataKey="label" hide />
        <ChartTooltip cursor={false} content={<ChartTooltipContent hideIndicator />} />
        <Bar dataKey="evaluations" fill="var(--color-evaluations)" background={{ fill: "var(--muted)", radius: 2 }} radius={2} {...motion} />
      </BarChart>
    </ChartContainer>
  );
}

/** The checks that failed most, for the bottom of the failed-checks tile. */
function TopFailed({ rows }: { rows: QualityOverview["topFailures"] }) {
  if (rows.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 text-xs">
      {rows.slice(0, 3).map((f) => (
        <li key={f.evaluatorId} className="flex items-center gap-2">
          <span className="size-2 shrink-0 rounded-[2px] bg-destructive" aria-hidden />
          <Link href={`/quality/evaluators/${f.evaluatorId}`} className="flex-1 truncate text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            {f.name}
          </Link>
          <span className="tabular-nums">{f.failures}</span>
        </li>
      ))}
    </ul>
  );
}

const trendConfig = {
  averageScore: { label: "Score", color: "var(--chart-1)" },
  pass: { label: "Passing %", color: "var(--success)" },
} satisfies ChartConfig;

/**
 * Score and pass rate as two overlapping areas on a 0-100 axis. Only days with grades are plotted, so a sparse period
 * still draws a shape instead of slivers between empty days.
 */
function QualityTrend({ trend }: { trend: QualityOverview["trend"] }) {
  const describe = (d: TrendRow) => (d.evaluations === 0 ? "no evaluations" : `score ${formatScore(d.averageScore)}, ${formatRate(d.passRate)} passed, ${d.evaluations} graded`);
  // Graded days only, placed on a real time axis: a gap of three days looks like three days.
  const rows = trendRows(trend)
    .filter((d) => d.evaluations > 0)
    .map((d) => ({ ...d, t: Date.parse(`${d.day}T00:00:00Z`) }));
  const domain = [Date.parse(`${trend[0]?.day}T00:00:00Z`), Date.parse(`${trend.at(-1)?.day}T00:00:00Z`)];
  const tickLabel = (t: number) => dayLabel(new Date(t).toISOString().slice(0, 10));
  const keys = Object.keys(trendConfig) as (keyof typeof trendConfig)[];
  const { rows: drawn, motion } = useGrowMotion(rows, keys);
  return (
    <>
      <ChartContainer config={trendConfig} className="aspect-auto h-64 w-full">
        <AreaChart data={drawn} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
          <defs>
            {keys.map((k) => (
              <linearGradient key={k} id={`quality-trend-${k}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={`var(--color-${k})`} stopOpacity={0.45} />
                <stop offset="95%" stopColor={`var(--color-${k})`} stopOpacity={0.15} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="t" type="number" scale="time" domain={domain} tickFormatter={tickLabel} tickLine={false} axisLine={false} minTickGap={32} />
          <YAxis domain={[0, 100]} ticks={[0, 50, 100]} tickLine={false} axisLine={false} width={32} />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                indicator="dot"
                labelFormatter={(_, payload) => {
                  const d = payload[0]?.payload as TrendRow | undefined;
                  return d ? `${dayLabel(d.day)} · ${d.evaluations} graded` : "";
                }}
              />
            }
          />
          {keys.map((k, i) => (
            <Area
              key={k}
              dataKey={k}
              type="bumpX" strokeLinejoin="round"
              stroke={`var(--color-${k})`}
              fill={`url(#quality-trend-${k})`}
              strokeWidth={2}
              dot={rows.length < 3 ? { r: 3, fill: `var(--color-${k})` } : false}
              animationBegin={i * 150}
              {...motion}
            />
          ))}
          <ChartLegend content={<ChartLegendContent />} />
        </AreaChart>
      </ChartContainer>
      {/* The chart is drawn for sighted users; screen readers get every day as a list. */}
      <ul className="sr-only">
        {trend.map((d) => (
          <li key={d.day}>{`${dayLabel(d.day)}: ${describe(d)}`}</li>
        ))}
      </ul>
    </>
  );
}

const dimensionConfig = {
  score: { label: "Score", color: "var(--chart-1)" },
  pass: { label: "Passing %", color: "var(--chart-2)" },
} satisfies ChartConfig;

/** A radar axis label, one word per line, so long dimension names stay inside the card instead of being clipped. */
function RadarTick({ x, y, textAnchor, payload }: { x?: number | string; y?: number | string; textAnchor?: "start" | "middle" | "end" | "inherit"; payload?: { value: string } }) {
  const words = payload?.value.split(" ") ?? [];
  const top = Number(y) - ((words.length - 1) * 12) / 2;
  return (
    <text x={x} y={top} textAnchor={textAnchor} dominantBaseline="central" className="fill-muted-foreground text-[11px]">
      {words.map((w, i) => (
        <tspan key={i} x={x} dy={i === 0 ? 0 : 12}>
          {w}
        </tspan>
      ))}
    </text>
  );
}

/** Average score and pass rate per dimension: a radar when there are enough dimensions to make a shape, bars otherwise. */
function Dimensions({ rows }: { rows: QualityOverview["byDimension"] }) {
  const values = rows.map((d) => ({
    label: EVAL_DIMENSION_LABELS[d.dimension],
    score: d.averageScore ?? 0,
    pass: d.passRate === null ? 0 : Math.round(d.passRate * 100),
  }));
  const { rows: data, motion } = useGrowMotion(values, ["score", "pass"], rows.map((d) => d.dimension).join("|"));
  return (
    <>
      <ChartContainer config={dimensionConfig} className="mx-auto aspect-square max-h-72 w-full">
        {data.length >= 3 ? (
          <RadarChart data={data} outerRadius="58%">
            <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
            <PolarGrid />
            <PolarAngleAxis dataKey="label" tick={RadarTick} />
            <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
            <Radar dataKey="score" stroke="var(--color-score)" fill="var(--color-score)" fillOpacity={0.3} strokeWidth={2} {...motion} />
            <Radar dataKey="pass" stroke="var(--color-pass)" fill="var(--color-pass)" fillOpacity={0.1} strokeWidth={2} strokeDasharray="4 3" {...motion} />
            <ChartLegend content={<ChartLegendContent />} />
          </RadarChart>
        ) : (
          <BarChart data={data} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 0 }}>
            <XAxis type="number" domain={[0, 100]} hide />
            <YAxis type="category" dataKey="label" width={120} tickLine={false} axisLine={false} />
            <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
            <Bar dataKey="score" fill="var(--color-score)" radius={4} {...motion} />
            <Bar dataKey="pass" fill="var(--color-pass)" radius={4} {...motion} />
            <ChartLegend content={<ChartLegendContent />} />
          </BarChart>
        )}
      </ChartContainer>
      <ul className="sr-only">
        {rows.map((d) => (
          <li key={d.dimension}>{`${EVAL_DIMENSION_LABELS[d.dimension]}: score ${formatScore(d.averageScore)}, ${formatRate(d.passRate)} passed`}</li>
        ))}
      </ul>
    </>
  );
}

/**
 * Horizontal bars of a 0-100 value per row, coloured by group (one colour per employee), labelled with the value.
 * Clicking a bar opens its page when `href` is given.
 */
function RankedBars({ rows, empty }: { rows: { key: string; label: string; value: number | null; group: number; detail: string; href?: string }[]; empty: string }) {
  const router = useRouter();
  const { rows: data, motion } = useGrowMotion(rows.map((r) => ({ ...r, value: r.value ?? 0 })), ["value"], rows.map((r) => r.key).join("|"));
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  const config = { value: { label: "Score", color: "var(--chart-1)" } } satisfies ChartConfig;
  return (
    <>
      <Reveal height={rows.length * 36 + 8}>
      <ChartContainer config={config} className="aspect-auto w-full" style={{ height: rows.length * 36 + 8 }}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 40, bottom: 0, left: 0 }}>
          <XAxis type="number" domain={[0, 100]} hide />
          <YAxis type="category" dataKey="label" width={150} tickLine={false} axisLine={false} interval={0} />
          <ChartTooltip cursor={false} content={<ChartTooltipContent hideIndicator formatter={(_, __, item) => item.payload.detail} />} />
          <Bar
            dataKey="value"
            radius={4}
            className={rows.some((r) => r.href) ? "cursor-pointer" : undefined}
            onClick={(entry: { payload?: { href?: string } }) => entry.payload?.href && router.push(entry.payload.href)}
            label={{ position: "right", className: "fill-muted-foreground text-xs tabular-nums" }}
            {...motion}
          >
            {data.map((r) => (
              <Cell key={r.key} fill={`var(--chart-${(r.group % 5) + 1})`} />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>
      </Reveal>
      <ul className="sr-only">
        {rows.map((r) => (
          <li key={r.key}>{`${r.label}: ${r.detail}`}</li>
        ))}
      </ul>
    </>
  );
}

/** Failed checks per evaluator, most first; clicking a bar opens the evaluator. */
function FailureBars({ rows }: { rows: QualityOverview["topFailures"] }) {
  const router = useRouter();
  const { rows: data, motion } = useGrowMotion(
    rows.map((f) => ({ ...f, label: f.name, href: `/quality/evaluators/${f.evaluatorId}` })),
    ["failures"],
    rows.map((f) => f.evaluatorId).join("|"),
  );
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">Nothing failed in this period.</p>;
  const config = { failures: { label: "Failures", color: "var(--destructive)" } } satisfies ChartConfig;
  return (
    <>
      <Reveal height={rows.length * 36 + 8}>
      <ChartContainer config={config} className="aspect-auto w-full" style={{ height: rows.length * 36 + 8 }}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 32, bottom: 0, left: 0 }}>
          <XAxis type="number" dataKey="failures" hide />
          <YAxis type="category" dataKey="label" width={180} tickLine={false} axisLine={false} interval={0} />
          <ChartTooltip
            cursor={false}
            content={<ChartTooltipContent hideIndicator formatter={(_, __, item) => `${item.payload.failures} failed · ${EVAL_DIMENSION_LABELS[item.payload.dimension as EvalDimension]}`} />}
          />
          <Bar
            dataKey="failures"
            fill="var(--color-failures)"
            fillOpacity={0.8}
            radius={4}
            className="cursor-pointer"
            onClick={(entry: { payload?: { href?: string } }) => entry.payload?.href && router.push(entry.payload.href)}
            label={{ position: "right", className: "fill-muted-foreground text-xs tabular-nums" }}
            {...motion}
          />
        </BarChart>
      </ChartContainer>
      </Reveal>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {rows.map((f) => (
          <li key={f.evaluatorId}>
            <Link href={`/quality/evaluators/${f.evaluatorId}`} className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
              {f.name}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

function Overview({ workspaceId }: { workspaceId: string }) {
  const [days, setDays] = useState<number>(30);
  const { data, error, reload, loading } = useApiQuery<QualityOverview>(`/workspaces/${workspaceId}/quality?days=${days}`, { keepPrevious: true });
  // The workspace's threshold for a low score (set on the dashboard); the default until it loads.
  const below = useApiQuery<Attention>(`/workspaces/${workspaceId}/attention`).data?.qualityScoreBelow ?? ATTENTION_DEFAULTS.qualityScoreBelow;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-end gap-2">
        {loading && data !== undefined && <Spinner className="text-muted-foreground" aria-label="Loading the new period" />}
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
      {error && !data ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : (
        <div className={cn("transition-opacity duration-200", loading && data !== undefined && "opacity-60")} aria-busy={loading}>
          <Skullet data={data} sample={SAMPLE_OVERVIEW} id="quality-overview" label="Loading quality overview">
            {(data) => <OverviewContent data={data} below={below} />}
          </Skullet>
        </div>
      )}
    </div>
  );
}

function OverviewContent({ data, below }: { data: QualityOverview; below: number }) {
  const dims = EVAL_DIMENSIONS.filter((d) => data.byEmployee.some((e) => e.dimensions[d] !== undefined));
  const employeeIndex = new Map(data.byEmployee.map((e, i) => [e.employeeId, i]));
  const versions = [...data.byVersion].sort((a, b) => a.name.localeCompare(b.name) || a.version - b.version);
  return data.evaluations === 0 ? (
    <EmptyState
      icon={ShieldCheck}
      title="No conversations graded yet"
      description="Conversations are graded automatically about 10 minutes after they go quiet. You can also grade one now from its page in Conversations."
    />
  ) : (
    // Skullet wraps its children in plain block divs, so the gap between rows has to live here.
    <div className="flex flex-col gap-6">
      <section aria-label="Summary" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Quality score" icon={Gauge} value={formatScore(data.averageScore)} hint="Average of every evaluator's score, 0-100">
          {data.averageScore !== null && <GaugeChart value={data.averageScore} color={scoreColor(data.averageScore, below)} />}
        </StatTile>
        <StatTile label="Conversations passing" icon={CircleCheck} value={formatRate(data.passRate)} hint="No evaluator failed">
          <PassSplit passing={data.passing} judged={data.judged} />
        </StatTile>
        <StatTile label="Conversations graded" icon={ClipboardCheck} value={String(data.evaluations)} hint={`Over the last ${data.days} days`}>
          <GradedBars trend={data.trend} />
        </StatTile>
        <StatTile label="Failed checks" icon={CircleX} value={String(data.failures)} hint={data.topFailures.length > 0 ? "Failed most:" : "Each one is listed in the Failures tab"}>
          <TopFailed rows={data.topFailures} />
        </StatTile>
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Quality over time</CardTitle>
            <CardDescription>Score and share passing on each day that had grades</CardDescription>
          </CardHeader>
          <CardContent>
            <QualityTrend trend={data.trend} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>By dimension</CardTitle>
            <CardDescription>Where answers are strong and where they slip</CardDescription>
          </CardHeader>
          <CardContent>
            <Dimensions rows={data.byDimension} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Employees</CardTitle>
            <CardDescription>Average score; click a bar to open the employee</CardDescription>
          </CardHeader>
          <CardContent>
            <RankedBars
              empty="No employee graded in this period."
              rows={[...data.byEmployee]
                .sort((a, b) => (b.averageScore ?? 0) - (a.averageScore ?? 0))
                .map((e) => ({
                  key: e.employeeId,
                  label: e.name,
                  value: e.averageScore,
                  group: employeeIndex.get(e.employeeId) ?? 0,
                  detail: `score ${formatScore(e.averageScore)} · ${formatRate(e.passRate)} passing · ${e.evaluations} graded`,
                  href: `/employees/${e.employeeId}`,
                }))}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>By employee version</CardTitle>
            <CardDescription>Each employee in its own colour, so a new version can be compared with the last</CardDescription>
          </CardHeader>
          <CardContent>
            <RankedBars
              empty="No version graded in this period."
              rows={versions.map((v) => ({
                key: `${v.employeeId}:${v.version}`,
                label: `${v.name} v${v.version}`,
                value: v.averageScore,
                group: employeeIndex.get(v.employeeId) ?? 0,
                detail: `score ${formatScore(v.averageScore)} · ${formatRate(v.passRate)} passing · ${v.evaluations} graded`,
              }))}
            />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Most failed checks</CardTitle>
            <CardDescription>Click a bar to open the evaluator</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <FailureBars rows={data.topFailures} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Scores by dimension and employee</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  {dims.map((d) => (
                    <TableHead key={d} className="text-right">
                      {EVAL_DIMENSION_LABELS[d]}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.byEmployee.map((e) => (
                  <TableRow key={e.employeeId}>
                    <TableCell>
                      <Link href={`/employees/${e.employeeId}`} className="font-medium underline-offset-2 hover:underline">
                        {e.name}
                      </Link>
                    </TableCell>
                    {dims.map((d) => {
                      const score = e.dimensions[d];
                      return (
                        <TableCell key={d} className={cn("text-right tabular-nums", score !== undefined && score < below && "text-destructive")}>
                          {formatScore(score ?? null)}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Failures({ workspaceId }: { workspaceId: string }) {
  const [dimension, setDimension] = useState<string>(ALL);
  const query = `/workspaces/${workspaceId}/evaluations?failed=true${dimension === ALL ? "" : `&dimension=${dimension}`}`;
  const { data, error, reload } = useApiQuery<EvaluationRecord[]>(query);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Select value={dimension} onValueChange={setDimension}>
          <SelectTrigger aria-label="Dimension" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All dimensions</SelectItem>
            {EVAL_DIMENSIONS.map((d) => (
              <SelectItem key={d} value={d}>
                {EVAL_DIMENSION_LABELS[d]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {error && !data ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : (
        <Skullet data={data} sample={SAMPLE_FAILURES} id="quality-failures" label="Loading failures">
          {(data) =>
            data.length === 0 ? (
              <EmptyState icon={ShieldCheck} title="No failures" description="No graded conversation failed a check in the last 30 days." />
            ) : (
              <Card className="gap-0 py-0">
                <ul className="flex flex-col divide-y">
                  {data.map((e) => {
                    const failed = e.results.filter((r) => r.passed === false && (dimension === ALL || r.dimension === dimension));
                    return (
                      <li key={e.id}>
                        <Link href={`/conversations/${e.conversationId}`} className="flex flex-col gap-1.5 px-4 py-3 hover:bg-muted/50">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="truncate font-medium">{e.conversationTitle}</span>
                            <span className="text-xs text-muted-foreground">
                              score {formatScore(e.score)} · {timeAgo(e.createdAt)}
                            </span>
                          </div>
                          <Provenance evaluation={e} />
                          <ul className="flex flex-col gap-0.5 text-sm">
                            {failed.map((r) => (
                              <li key={r.id}>
                                <span className="font-medium">{r.evaluatorName}</span>
                                <span className="text-muted-foreground"> · {r.findings[0]?.message ?? r.reason}</span>
                              </li>
                            ))}
                          </ul>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            )
          }
        </Skullet>
      )}
    </div>
  );
}

function Evaluators({ workspaceId }: { workspaceId: string }) {
  const api = useApi();
  const isAdmin = useIsAdmin();
  const { data, error, reload, setData } = useApiQuery<EvaluatorInfo[]>(`/workspaces/${workspaceId}/evaluators`);

  const toggle = async (e: EvaluatorInfo, enabled: boolean) => {
    if (!data) return;
    setData(data.map((x) => (x.id === e.id ? { ...x, enabled } : x)));
    try {
      await api(`/workspaces/${workspaceId}/evaluators/${e.id}`, {
        method: "PATCH",
        body: { enabled },
        toast: `${e.current.name} turned ${enabled ? "on" : "off"}`,
      });
    } catch {
      // The toast in useApi shows why it failed; reload puts the switch back.
      reload();
    }
  };

  if (error && !data) return <ErrorState message={error.message} onRetry={reload} />;
  return (
    <Skullet data={data} sample={SAMPLE_EVALUATORS} id="quality-evaluators" label="Loading evaluators">
      {(data) => (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">Enabled evaluators grade every conversation. Editing one saves a new version; past results keep theirs.</p>
            {isAdmin && (
              <Button asChild>
                <Link href="/quality/evaluators/new">
                  <Plus aria-hidden />
                  New evaluator
                </Link>
              </Button>
            )}
          </div>
          <Card className="overflow-x-auto py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Evaluator</TableHead>
                  <TableHead>Dimension</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead className="text-right">Last 30 days</TableHead>
                  <TableHead className="text-right">On</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell>
                      <Link href={`/quality/evaluators/${e.id}`} className="font-medium underline-offset-2 hover:underline">
                        {e.current.name}
                      </Link>
                      <span className="ml-1.5 text-xs text-muted-foreground">v{e.current.number}</span>
                    </TableCell>
                    <TableCell>{EVAL_DIMENSION_LABELS[e.current.dimension]}</TableCell>
                    <TableCell>{EVALUATOR_KIND_LABELS[e.current.kind]}</TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {e.recent.results === 0 ? "—" : `${e.recent.passed} of ${e.recent.results} passed · avg ${formatScore(e.recent.averageScore)}`}
                    </TableCell>
                    <TableCell className="text-right">
                      <Switch
                        checked={e.enabled}
                        onCheckedChange={(v) => toggle(e, v)}
                        disabled={!isAdmin}
                        aria-label={`${e.enabled ? "Turn off" : "Turn on"} ${e.current.name}`}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </div>
      )}
    </Skullet>
  );
}

function Datasets({ workspaceId }: { workspaceId: string }) {
  const api = useApi();
  const router = useRouter();
  const isAdmin = useIsAdmin();
  const { data, error, reload } = useApiQuery<DatasetSummary[]>(`/workspaces/${workspaceId}/datasets`);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const { id } = await api<{ id: string }>(`/workspaces/${workspaceId}/datasets`, {
        method: "POST",
        body: { name },
        toast: `${name.trim()} created`,
      });
      router.push(`/quality/datasets/${id}`);
    } catch {
      // The toast in useApi shows why it failed.
    } finally {
      setBusy(false);
    }
  };

  if (error && !data) return <ErrorState message={error.message} onRetry={reload} />;
  return (
    <Skullet data={data} sample={SAMPLE_DATASETS} id="quality-datasets" label="Loading datasets">
      {(data) => (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Regression datasets replay conversations against an employee version and grade the answers, so you can compare a draft with what is live before
            publishing. Add real conversations from their page in Conversations, or write cases by hand.
          </p>
          {isAdmin && (
            <form onSubmit={create} className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="dataset-name">New dataset</Label>
                <Input id="dataset-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pricing questions" maxLength={100} className="w-64" />
              </div>
              <Button type="submit" disabled={busy || name.trim() === ""}>
                <Plus aria-hidden />
                Create
              </Button>
            </form>
          )}
          {data.length === 0 ? (
            <EmptyState icon={Database} title="No datasets yet" description="Create one, then add cases to it." />
          ) : (
            <Card className="gap-0 py-0">
              <ul className="flex flex-col divide-y">
                {data.map((d) => (
                  <li key={d.id}>
                    <Link href={`/quality/datasets/${d.id}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-muted/50">
                      <span className="flex flex-col">
                        <span className="font-medium">{d.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {d.cases} {d.cases === 1 ? "case" : "cases"}
                          {d.description && ` · ${d.description}`}
                        </span>
                      </span>
                      <span className="flex items-center gap-2 text-sm text-muted-foreground">
                        {d.lastRun ? (
                          <>
                            {d.lastRun.employee.name} v{d.lastRun.employeeVersion} · score {formatScore(d.lastRun.score)} · {d.lastRun.passed}/{d.lastRun.total} passed
                            {d.lastRun.status === "COMPLETED" && <ResultBadge passed={d.lastRun.failed === 0} />}
                          </>
                        ) : (
                          "Never run"
                        )}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}
    </Skullet>
  );
}

export default withWorkspace(function QualityPage({ workspace }) {
  const [tab, setTab] = usePageTab("/quality");
  // Charts animate on the first load only; after a tab switch (click, Alt+number or the command menu) they appear straight away.
  const [shownTab, setShownTab] = useState(tab);
  const [switched, setSwitched] = useState(false);
  if (tab !== shownTab) {
    setShownTab(tab);
    setSwitched(true);
  }
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Quality"
        description="How well AI employees answer, graded in the background after each conversation. Grades are for review only: they never change how employees answer."
      />
      <ChartMotionProvider animate={!switched}>
      <Tabs value={tab} onValueChange={setTab} className="gap-6">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="failures">Failures</TabsTrigger>
          <TabsTrigger value="evaluators">Evaluators</TabsTrigger>
          <TabsTrigger value="datasets">Datasets</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <Overview workspaceId={workspace.id} />
        </TabsContent>
        <TabsContent value="failures">
          <Failures workspaceId={workspace.id} />
        </TabsContent>
        <TabsContent value="evaluators">
          <Evaluators workspaceId={workspace.id} />
        </TabsContent>
        <TabsContent value="datasets">
          <Datasets workspaceId={workspace.id} />
        </TabsContent>
      </Tabs>
      </ChartMotionProvider>
    </div>
  );
});

