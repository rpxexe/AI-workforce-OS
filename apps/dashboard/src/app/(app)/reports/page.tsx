"use client";

import type { AnalyticsReport, DurationStats } from "@workforce/shared";
import { CircleCheck, Coins, DollarSign, Gauge, Hourglass, MessageSquare, MessagesSquare, Phone, Timer, TriangleAlert, Workflow, Wrench } from "lucide-react";
import { useState } from "react";
import { CHANNEL_LABELS, formatDuration } from "@/components/inbox/meta";
import { Skeleton as Skullet } from "skullet/react";
import { DateRangePicker } from "@/components/date-range-picker";
import { ErrorState, PageHeader, StatTile } from "@/components/states";
import { TablePager, usePaged } from "@/components/table-pager";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  const { data, error, reload } = useApiQuery<AnalyticsReport>(query);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Reports" description="Everything your organization did in a date range: conversations, calls, AI usage, outcomes, latency, cost and quality.">
        <div className="flex flex-wrap items-end gap-3">
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
        <Skullet data={data} sample={SAMPLE} id="reports-summary" label="Loading report">
          {(data) => <Report data={data} resetKey={query} />}
        </Skullet>
      )}
    </div>
  );
}

function Report({ data, resetKey }: { data: AnalyticsReport; resetKey: string | null }) {
  const days = usePaged([...data.daily].reverse(), 14, resetKey);
  return (
    // Skullet wraps its content in a block, so this keeps the gaps the page used to give.
    <div className="flex flex-col gap-6">
      <section aria-label="Activity" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Conversations" icon={MessagesSquare} value={n(data.conversations.total)} hint={data.conversations.byChannel.map((c) => `${CHANNEL_LABELS[c.channel] ?? c.channel} ${n(c.count)}`).join(" · ") || undefined} />
        <StatTile label="Calls" icon={Phone} value={n(data.calls.total)} hint={`${n(data.calls.completed)} completed · ${n(data.calls.minutes)} minutes`} />
        <StatTile label="Messages" icon={MessageSquare} value={n(data.messages.customer + data.messages.ai + data.messages.agent)} hint={`${n(data.messages.customer)} customer · ${n(data.messages.ai)} AI · ${n(data.messages.agent)} people`} />
        <StatTile label="AI tokens" icon={Coins} value={n(data.tokens.input + data.tokens.output)} hint={`${n(data.tokens.input)} in · ${n(data.tokens.output)} out`} />
      </section>
      <section aria-label="Outcomes" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Resolved conversations" icon={CircleCheck} value={n(data.resolutions)} />
        <StatTile label="Escalations" icon={TriangleAlert} value={n(data.escalations)} hint={`${n(data.humanHandoffs)} taken over by people`} />
        <StatTile
          label="Quality score" icon={Gauge}
          value={data.quality.averageScore === null ? "—" : String(data.quality.averageScore)}
          hint={data.quality.evaluations === 0 ? "No evaluations" : `${Math.round((data.quality.passRate ?? 0) * 100)}% passed · ${n(data.quality.evaluations)} evaluated`}
        />
        <StatTile label="Usage billed" icon={DollarSign} value={usd(data.cost.billedUsd)} />
      </section>
      <section aria-label="Executions and latency" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Tool executions" icon={Wrench} value={n(data.toolExecutions.total)} hint={data.toolExecutions.byStatus.map((s) => `${s.status.toLowerCase()} ${n(s.count)}`).join(" · ") || undefined} />
        <StatTile label="Workflow runs" icon={Workflow} value={n(data.workflowExecutions.total)} hint={data.workflowExecutions.byStatus.map((s) => `${s.status.toLowerCase()} ${n(s.count)}`).join(" · ") || undefined} />
        <StatTile label="AI reply latency" icon={Timer} value={formatDuration(data.latency.aiReply.median)} hint={latency(data.latency.aiReply)} />
        <StatTile label="Provider latency" icon={Hourglass} value={formatDuration(data.latency.provider.median)} hint={latency(data.latency.provider)} />
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
      </Card>
    </div>
  );
}
