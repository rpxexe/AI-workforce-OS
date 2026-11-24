"use client";

import type { AnalyticsReport, DurationStats } from "@workforce/shared";
import { useState } from "react";
import { CHANNEL_LABELS, formatDuration } from "@/components/inbox/meta";
import { ErrorState, LoadingState, PageHeader } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApiQuery } from "@/lib/api";
import { useWorkspaces } from "@/lib/workspace";

const ALL = "all";
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000));
const n = (v: number) => v.toLocaleString("en-US");
const usd = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border p-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

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
  const { data, error, reload } = useApiQuery<AnalyticsReport>(query);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Reports" description="Everything your organization did in a date range: conversations, calls, AI usage, outcomes, latency, cost and quality.">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="report-from">From</Label>
            <Input id="report-from" type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} className="w-40" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="report-to">To</Label>
            <Input id="report-to" type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} className="w-40" />
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
      ) : !data ? (
        <LoadingState rows={4} />
      ) : (
        <>
          <section aria-label="Activity" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Conversations" value={n(data.conversations.total)} hint={data.conversations.byChannel.map((c) => `${CHANNEL_LABELS[c.channel] ?? c.channel} ${n(c.count)}`).join(" · ") || undefined} />
            <Tile label="Calls" value={n(data.calls.total)} hint={`${n(data.calls.completed)} completed · ${n(data.calls.minutes)} minutes`} />
            <Tile label="Messages" value={n(data.messages.customer + data.messages.ai + data.messages.agent)} hint={`${n(data.messages.customer)} customer · ${n(data.messages.ai)} AI · ${n(data.messages.agent)} people`} />
            <Tile label="AI tokens" value={n(data.tokens.input + data.tokens.output)} hint={`${n(data.tokens.input)} in · ${n(data.tokens.output)} out`} />
          </section>
          <section aria-label="Outcomes" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Resolved conversations" value={n(data.resolutions)} />
            <Tile label="Escalations" value={n(data.escalations)} hint={`${n(data.humanHandoffs)} taken over by people`} />
            <Tile
              label="Quality score"
              value={data.quality.averageScore === null ? "—" : String(data.quality.averageScore)}
              hint={data.quality.evaluations === 0 ? "No evaluations" : `${Math.round((data.quality.passRate ?? 0) * 100)}% passed · ${n(data.quality.evaluations)} evaluated`}
            />
            <Tile label="Usage billed" value={usd(data.cost.billedUsd)} />
          </section>
          <section aria-label="Executions and latency" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Tool executions" value={n(data.toolExecutions.total)} hint={data.toolExecutions.byStatus.map((s) => `${s.status.toLowerCase()} ${n(s.count)}`).join(" · ") || undefined} />
            <Tile label="Workflow runs" value={n(data.workflowExecutions.total)} hint={data.workflowExecutions.byStatus.map((s) => `${s.status.toLowerCase()} ${n(s.count)}`).join(" · ") || undefined} />
            <Tile label="AI reply latency" value={formatDuration(data.latency.aiReply.median)} hint={latency(data.latency.aiReply)} />
            <Tile label="Provider latency" value={formatDuration(data.latency.provider.median)} hint={latency(data.latency.provider)} />
          </section>
          <Card>
            <CardHeader>
              <CardTitle>By day (UTC)</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
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
                  {[...data.daily].reverse().map((d) => (
                    <TableRow key={d.date}>
                      <TableCell>{d.date}</TableCell>
                      <TableCell className="text-right tabular-nums">{n(d.conversations)}</TableCell>
                      <TableCell className="text-right tabular-nums">{n(d.messages)}</TableCell>
                      <TableCell className="text-right tabular-nums">{usd(d.billedUsd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
