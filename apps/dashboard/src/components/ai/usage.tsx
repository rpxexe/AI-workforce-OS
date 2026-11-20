"use client";

import { AI_TASK_LABELS, type AiTask, type AiUsageSummary } from "@workforce/shared";
import { Activity } from "lucide-react";
import { useState } from "react";
import { timeAgo } from "@/components/inbox/meta";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApiQuery } from "@/lib/api";

const money = (v: number | null) => (v === null ? "—" : v < 0.01 && v > 0 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
const count = (n: number) => n.toLocaleString();
const taskLabel = (t: string) => AI_TASK_LABELS[t as AiTask]?.split(" (")[0] ?? t;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border px-4 py-3">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

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
        ) : !data ? (
          <LoadingState rows={3} />
        ) : data.totals.calls === 0 ? (
          <EmptyState icon={Activity} title="No model calls yet" description="Calls appear here as employees answer, graders run and memory is learned." />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <Stat label="Calls" value={count(data.totals.calls)} />
              <Stat label="Failed" value={count(data.totals.failures)} />
              <Stat label="Fallbacks" value={count(data.totals.fallbacks)} />
              <Stat label="Cost" value={money(data.totals.costUsd)} />
              <Stat label="Avg. time" value={`${count(data.totals.avgLatencyMs)} ms`} />
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

            <div className="flex flex-wrap gap-2">
              {data.byTask.map((t) => (
                <Badge key={t.task} variant="outline">
                  {taskLabel(t.task)}: {count(t.calls)} calls, {money(t.costUsd)}
                </Badge>
              ))}
            </div>

            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Recent calls</h3>
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
                    {data.recent.map((r) => (
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
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
