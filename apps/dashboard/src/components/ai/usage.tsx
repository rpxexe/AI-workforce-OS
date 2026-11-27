"use client";

import { AI_TASK_LABELS, type AiTask, type AiUsageSummary } from "@workforce/shared";
import { Activity, CircleX, DollarSign, Shuffle, Timer } from "lucide-react";
import { useState } from "react";
import { timeAgo } from "@/components/inbox/meta";
import { Skeleton as Skullet } from "skullet/react";
import { EmptyState, ErrorState, StatTile } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApiQuery } from "@/lib/api";
import { TablePager, usePaged } from "@/components/table-pager";

const money = (v: number | null) => (v === null ? "—" : v < 0.01 && v > 0 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
const count = (n: number) => n.toLocaleString();
const taskLabel = (t: string) => AI_TASK_LABELS[t as AiTask]?.split(" (")[0] ?? t;

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE: AiUsageSummary = {
  days: 30,
  totals: { calls: 1200, failures: 12, fallbacks: 8, inputTokens: 900_000, outputTokens: 300_000, costUsd: 12.34, avgLatencyMs: 1450 },
  byModel: ["gpt-4o-mini", "claude-sonnet-4", "gemini-2.5-flash"].map((model) => ({
    provider: "openai",
    model,
    calls: 400,
    failures: 4,
    inputTokens: 300_000,
    outputTokens: 100_000,
    costUsd: 4.11,
    avgLatencyMs: 1450,
  })),
  byTask: ["chat", "voice", "memory"].map((task) => ({ task, calls: 400, costUsd: 4.11 })),
  recent: Array.from({ length: 5 }, (_, i) => ({
    id: `sample-${i}`,
    task: "chat",
    requestId: `sample-request-${i}`,
    attempt: 1,
    provider: "openai",
    model: "gpt-4o-mini",
    credentialId: null,
    inputTokens: 1200,
    outputTokens: 300,
    costUsd: 0.0012,
    latencyMs: 1450,
    success: true,
    errorKind: null,
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  })),
};

export function Usage() {
  const [days, setDays] = useState("30");
  const { data, error, reload } = useApiQuery<AiUsageSummary>(`/ai/usage?days=${days}`);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <CardTitle>Usage</CardTitle>
          <CardDescription>Every model call: who answered, tokens, cost (reported by the provider, else estimated from known prices) and time.</CardDescription>
        </div>
        <Select value={days} onValueChange={setDays}>
          <SelectTrigger className="w-36" aria-label="Period">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1">Last 24 hours</SelectItem>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
            <SelectItem value="90">Last 90 days</SelectItem>
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {error && !data ? (
          <ErrorState message={error.message} onRetry={reload} />
        ) : (
          <Skullet data={data} sample={SAMPLE} id="ai-usage" label="Loading usage">
            {(data) => <UsageReport data={data} days={days} />}
          </Skullet>
        )}
      </CardContent>
    </Card>
  );
}

function UsageReport({ data, days }: { data: AiUsageSummary; days: string }) {
  const calls = usePaged(data.recent, 20, days);
  return data.totals.calls === 0 ? (
    <EmptyState icon={Activity} title="No model calls yet" description="Calls appear here as employees answer, graders run and memory is learned." />
  ) : (
    // Skullet wraps its content in a block, so this keeps the gaps the card content used to give.
    <div className="flex flex-col gap-6">
      {/* The card drops its side padding around tables so they run edge to edge; everything else gets it back. */}
      <div className="grid grid-cols-2 gap-3 px-4 md:grid-cols-5">
        <StatTile label="Calls" icon={Activity} value={count(data.totals.calls)} />
        <StatTile label="Failed" icon={CircleX} value={count(data.totals.failures)} />
        <StatTile label="Fallbacks" icon={Shuffle} value={count(data.totals.fallbacks)} />
        <StatTile label="Cost" icon={DollarSign} value={money(data.totals.costUsd)} />
        <StatTile label="Avg. time" icon={Timer} value={`${count(data.totals.avgLatencyMs)} ms`} />
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead className="text-right">Calls</TableHead>
              <TableHead className="text-right">Failed</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Tokens in / out</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="hidden text-right md:table-cell">Avg. time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.byModel.map((g) => (
              <TableRow key={`${g.provider}:${g.model}`}>
                <TableCell>
                  <span className="block font-medium">{g.model}</span>
                  <span className="text-xs text-muted-foreground">{g.provider}</span>
                </TableCell>
                <TableCell className="text-right tabular-nums">{count(g.calls)}</TableCell>
                <TableCell className="text-right tabular-nums">{count(g.failures)}</TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">
                  {count(g.inputTokens)} / {count(g.outputTokens)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{money(g.costUsd)}</TableCell>
                <TableCell className="hidden text-right tabular-nums md:table-cell">{count(g.avgLatencyMs)} ms</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-wrap gap-2 px-4">
        {data.byTask.map((t) => (
          <Badge key={t.task} variant="outline">
            {taskLabel(t.task)}: {count(t.calls)} calls, {money(t.costUsd)}
          </Badge>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="px-4 text-sm font-medium">Recent calls</h3>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Task</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Result</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Tokens</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="hidden text-right md:table-cell">Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {calls.rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{timeAgo(r.createdAt)}</TableCell>
                  <TableCell>{taskLabel(r.task)}</TableCell>
                  <TableCell>
                    <span className="block">{r.model}</span>
                    <span className="text-xs text-muted-foreground">
                      {r.provider}
                      {r.credentialId ? " · your key" : ""}
                      {r.attempt > 1 ? ` · fallback ${r.attempt - 1}` : ""}
                    </span>
                  </TableCell>
                  <TableCell>
                    {r.success ? (
                      <Badge variant="secondary">Answered</Badge>
                    ) : (
                      <span className="flex flex-col gap-1">
                        <Badge variant="destructive">{r.errorKind ?? "Failed"}</Badge>
                        {r.error && <span className="max-w-xs truncate text-xs text-muted-foreground" title={r.error}>{r.error}</span>}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="hidden text-right tabular-nums sm:table-cell">
                    {count(r.inputTokens)} / {count(r.outputTokens)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(r.costUsd)}</TableCell>
                  <TableCell className="hidden text-right tabular-nums md:table-cell">{count(r.latencyMs)} ms</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <TablePager {...calls.pager} />
        </div>
      </div>
    </div>
  );
}
