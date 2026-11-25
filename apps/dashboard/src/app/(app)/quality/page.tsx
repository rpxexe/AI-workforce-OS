"use client";

import {
  EVAL_DIMENSION_LABELS,
  EVAL_DIMENSIONS,
  EVALUATOR_KIND_LABELS,
  type DatasetSummary,
  type EvaluationRecord,
  type EvaluatorInfo,
  type QualityOverview,
} from "@workforce/shared";
import { CircleCheck, CircleX, ClipboardCheck, Database, Gauge, Plus, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { Bar, BarChart, XAxis, YAxis } from "recharts";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { timeAgo } from "@/components/inbox/meta";
import { formatRate, formatScore, Provenance, ResultBadge } from "@/components/quality/meta";
import { Skeleton as Skullet } from "skullet/react";
import { EmptyState, ErrorState, PageHeader, StatTile } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApi, useApiQuery } from "@/lib/api";
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

const trendConfig = { bar: { label: "Score", color: "var(--primary)" } } satisfies ChartConfig;

/** Average score per day: one series, so no legend; hover a day to read it. */
function Trend({ trend }: { trend: QualityOverview["trend"] }) {
  const [active, setActive] = useState<number>();
  const shown = active === undefined ? trend.findLast((d) => d.evaluations > 0) : trend[active];
  const label = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  const describe = (d: QualityOverview["trend"][number]) => (d.evaluations === 0 ? "no evaluations" : `score ${formatScore(d.averageScore)}, ${d.evaluations} graded`);
  // A score of 0 still draws a sliver, so a graded day is told apart from a day with nothing graded.
  const rows = trend.map((d) => ({ ...d, bar: d.averageScore === null ? 0 : Math.max(1, d.averageScore) }));
  const ends = [trend[0]?.day, trend.at(-1)?.day].filter((d) => d !== undefined);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {shown ? `${label(shown.day)}: ${shown.evaluations === 0 ? "no evaluations" : `score ${formatScore(shown.averageScore)} · ${formatRate(shown.passRate)} passed · ${shown.evaluations} graded`}` : "No evaluations yet."}
      </p>
      <ChartContainer config={trendConfig} className="aspect-auto h-48 w-full" aria-hidden>
        <BarChart
          data={rows}
          margin={{ top: 4, right: 0, bottom: 0, left: 20 }}
          barCategoryGap="15%"
          onMouseMove={(state) => setActive(state.activeTooltipIndex == null ? undefined : Number(state.activeTooltipIndex))}
          onMouseLeave={() => setActive(undefined)}
        >
          <XAxis dataKey="day" ticks={ends} tickFormatter={label} tickLine={false} axisLine={false} interval={0} />
          <YAxis domain={[0, 100]} ticks={[0, 50, 100]} orientation="right" width={32} tickLine={false} axisLine={false} />
          <ChartTooltip
            cursor={false}
            content={<ChartTooltipContent hideIndicator labelFormatter={(_, payload) => label(String(payload[0]?.payload.day))} formatter={(_, __, item) => describe(item.payload)} />}
          />
          <Bar dataKey="bar" fill="var(--color-bar)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ChartContainer>
      {/* The chart is drawn for sighted users; screen readers get every day as a list. */}
      <ul className="sr-only">
        {trend.map((d) => (
          <li key={d.day}>{`${label(d.day)}: ${describe(d)}`}</li>
        ))}
      </ul>
    </div>
  );
}

function ScoreBar({ label, score, hint }: { label: string; score: number | null; hint: string }) {
  return (
    <li className="flex flex-col gap-1">
      <div className="flex justify-between gap-2 text-sm">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {formatScore(score)} <span className="text-xs">· {hint}</span>
        </span>
      </div>
      <Progress value={score ?? 0} className="h-2" aria-hidden />
    </li>
  );
}

function Overview({ workspaceId }: { workspaceId: string }) {
  const [days, setDays] = useState<number>(30);
  const { data, error, reload } = useApiQuery<QualityOverview>(`/workspaces/${workspaceId}/quality?days=${days}`);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-end">
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
        <Skullet data={data} sample={SAMPLE_OVERVIEW} id="quality-overview" label="Loading quality overview">
          {(data) => <OverviewContent data={data} />}
        </Skullet>
      )}
    </div>
  );
}

function OverviewContent({ data }: { data: QualityOverview }) {
  const dims = EVAL_DIMENSIONS.filter((d) => data.byEmployee.some((e) => e.dimensions[d] !== undefined));
  return data.evaluations === 0 ? (
    <EmptyState
      icon={ShieldCheck}
      title="No conversations graded yet"
      description="Conversations are graded automatically about 10 minutes after they go quiet. You can also grade one now from its page in Conversations."
    />
  ) : (
    <>
      <section aria-label="Summary" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Quality score" icon={Gauge} value={formatScore(data.averageScore)} hint="Average of every evaluator's score, 0-100" />
        <StatTile label="Conversations passing" icon={CircleCheck} value={formatRate(data.passRate)} hint="No evaluator failed" />
        <StatTile label="Conversations graded" icon={ClipboardCheck} value={String(data.evaluations)} />
        <StatTile label="Failed checks" icon={CircleX} value={String(data.failures)} hint="See the Failures tab" />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Quality score by day</CardTitle>
          </CardHeader>
          <CardContent>
            <Trend trend={data.trend} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>By dimension</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-3">
              {data.byDimension.map((d) => (
                <ScoreBar key={d.dimension} label={EVAL_DIMENSION_LABELS[d.dimension]} score={d.averageScore} hint={`${formatRate(d.passRate)} passed`} />
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Employee comparison</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead className="text-right">Score</TableHead>
                <TableHead className="text-right">Passing</TableHead>
                <TableHead className="text-right">Graded</TableHead>
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
                  <TableCell className="text-right tabular-nums">{formatScore(e.averageScore)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatRate(e.passRate)}</TableCell>
                  <TableCell className="text-right tabular-nums">{e.evaluations}</TableCell>
                  {dims.map((d) => (
                    <TableCell key={d} className="text-right tabular-nums">
                      {formatScore(e.dimensions[d] ?? null)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>By employee version</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Version</TableHead>
                  <TableHead className="text-right">Score</TableHead>
                  <TableHead className="text-right">Passing</TableHead>
                  <TableHead className="text-right">Graded</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.byVersion.map((v) => (
                  <TableRow key={`${v.employeeId}:${v.version}`}>
                    <TableCell>
                      {v.name} <span className="text-muted-foreground">v{v.version}</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatScore(v.averageScore)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatRate(v.passRate)}</TableCell>
                    <TableCell className="text-right tabular-nums">{v.evaluations}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Most failed checks</CardTitle>
          </CardHeader>
          <CardContent>
            {data.topFailures.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing failed in this period.</p>
            ) : (
              <ul className="flex flex-col divide-y text-sm">
                {data.topFailures.map((f) => (
                  <li key={f.evaluatorId} className="flex justify-between gap-2 py-2 first:pt-0">
                    <Link href={`/quality/evaluators/${f.evaluatorId}`} className="underline-offset-2 hover:underline">
                      {f.name} <span className="text-muted-foreground">· {EVAL_DIMENSION_LABELS[f.dimension]}</span>
                    </Link>
                    <span className="tabular-nums">{f.failures}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
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
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Quality"
        description="How well AI employees answer, graded in the background after each conversation. Grades are for review only: they never change how employees answer."
      />
      <Tabs defaultValue="overview" className="gap-6">
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
    </div>
  );
});

