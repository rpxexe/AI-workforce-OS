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
import { Database, Plus, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { timeAgo } from "@/components/inbox/meta";
import { formatRate, formatScore, Provenance, ResultBadge } from "@/components/quality/meta";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApi, useApiQuery } from "@/lib/api";
import { useIsAdmin, withWorkspace } from "@/lib/workspace";

const PERIODS = [7, 30, 90] as const;
const ALL = "all";

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border p-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

/** Average score per day: one series, so no legend; hover or focus a day to read it. */
function Trend({ trend }: { trend: QualityOverview["trend"] }) {
  const [active, setActive] = useState<number>();
  const shown = active === undefined ? trend.findLast((d) => d.evaluations > 0) : trend[active];
  const label = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {shown ? `${label(shown.day)}: ${shown.evaluations === 0 ? "no evaluations" : `score ${formatScore(shown.averageScore)} · ${formatRate(shown.passRate)} passed · ${shown.evaluations} graded`}` : "No evaluations yet."}
      </p>
      <div className="relative h-40" onMouseLeave={() => setActive(undefined)}>
        {[0, 50, 100].map((v) => (
          <div key={v} className="absolute inset-x-0 border-t border-dashed border-border/70" style={{ bottom: `${v}%` }} aria-hidden>
            <span className="absolute -top-2 right-0 bg-card pl-1 text-[10px] text-muted-foreground">{v}</span>
          </div>
        ))}
        <div className="absolute inset-0 right-6 flex items-end gap-0.5">
          {trend.map((d, i) => (
            <button
              key={d.day}
              type="button"
              className="group flex h-full min-w-0 flex-1 items-end focus-visible:outline-none"
              onMouseEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(undefined)}
              aria-label={`${label(d.day)}: ${d.evaluations === 0 ? "no evaluations" : `score ${formatScore(d.averageScore)}, ${d.evaluations} graded`}`}
            >
              <span
                className={`w-full rounded-t-[4px] ${active === i ? "bg-primary" : "bg-primary/70"} group-focus-visible:ring-2 group-focus-visible:ring-ring`}
                style={{ height: d.averageScore === null ? 0 : `${Math.max(1, d.averageScore)}%` }}
              />
            </button>
          ))}
        </div>
      </div>
      <div className="flex justify-between pr-6 text-[10px] text-muted-foreground" aria-hidden>
        <span>{trend[0] && label(trend[0].day)}</span>
        <span>{trend.at(-1) && label(trend.at(-1)?.day ?? "")}</span>
      </div>
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
      <div className="h-2 rounded-r-[4px] bg-muted" aria-hidden>
        <div className="h-full rounded-r-[4px] bg-primary" style={{ width: `${score ?? 0}%` }} />
      </div>
    </li>
  );
}

function Overview({ workspaceId }: { workspaceId: string }) {
  const [days, setDays] = useState<number>(30);
  const { data, error, reload } = useApiQuery<QualityOverview>(`/workspaces/${workspaceId}/quality?days=${days}`);
  const dims = EVAL_DIMENSIONS.filter((d) => data?.byEmployee.some((e) => e.dimensions[d] !== undefined));

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
      ) : !data ? (
        <LoadingState rows={4} />
      ) : data.evaluations === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No conversations graded yet"
          description="Conversations are graded automatically about 10 minutes after they go quiet. You can also grade one now from its page in Conversations."
        />
      ) : (
        <>
          <section aria-label="Summary" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Quality score" value={formatScore(data.averageScore)} hint="Average of every evaluator's score, 0-100" />
            <Tile label="Conversations passing" value={formatRate(data.passRate)} hint="No evaluator failed" />
            <Tile label="Conversations graded" value={String(data.evaluations)} />
            <Tile label="Failed checks" value={String(data.failures)} hint="See the Failures tab" />
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
      )}
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
      ) : !data ? (
        <LoadingState rows={4} />
      ) : data.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="No failures" description="No graded conversation failed a check in the last 30 days." />
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
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
      )}
    </div>
  );
}

function Evaluators({ workspaceId }: { workspaceId: string }) {
  const api = useApi();
  const isAdmin = useIsAdmin();
  const { data, error, reload, setData } = useApiQuery<EvaluatorInfo[]>(`/workspaces/${workspaceId}/evaluators`);
  const [failure, setFailure] = useState<string>();

  const toggle = async (e: EvaluatorInfo, enabled: boolean) => {
    if (!data) return;
    setFailure(undefined);
    setData(data.map((x) => (x.id === e.id ? { ...x, enabled } : x)));
    try {
      await api(`/workspaces/${workspaceId}/evaluators/${e.id}`, { method: "PATCH", body: { enabled } });
    } catch (err) {
      setFailure(err instanceof Error ? err.message : "Could not change the evaluator.");
      reload();
    }
  };

  if (error && !data) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data) return <LoadingState rows={6} />;
  return (
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
      {failure && (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}
      <div className="overflow-x-auto rounded-lg border">
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
      </div>
    </div>
  );
}

function Datasets({ workspaceId }: { workspaceId: string }) {
  const api = useApi();
  const router = useRouter();
  const isAdmin = useIsAdmin();
  const { data, error, reload } = useApiQuery<DatasetSummary[]>(`/workspaces/${workspaceId}/datasets`);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFailure(undefined);
    try {
      const { id } = await api<{ id: string }>(`/workspaces/${workspaceId}/datasets`, { method: "POST", body: { name } });
      router.push(`/quality/datasets/${id}`);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : "Could not create the dataset.");
    } finally {
      setBusy(false);
    }
  };

  if (error && !data) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data) return <LoadingState rows={3} />;
  return (
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
          {failure && (
            <p role="alert" className="w-full text-sm text-destructive">
              {failure}
            </p>
          )}
        </form>
      )}
      {data.length === 0 ? (
        <EmptyState icon={Database} title="No datasets yet" description="Create one, then add cases to it." />
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
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
      )}
    </div>
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

