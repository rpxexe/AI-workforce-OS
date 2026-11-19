"use client";

import { HANDOFF_TRIGGER_LABELS, type DurationStats, type HandoffAnalytics } from "@workforce/shared";
import { useState } from "react";
import { formatDuration } from "@/components/inbox/meta";
import { ErrorState, LoadingState, PageHeader } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApiQuery } from "@/lib/api";
import { useMembers } from "@/lib/members";
import { withWorkspace } from "@/lib/workspace";

const PERIODS = [7, 30, 90] as const;

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border p-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

/** A duration headline: the median, with the average, 90th percentile and sample size underneath. */
function DurationTile({ label, stats }: { label: string; stats: DurationStats }) {
  return (
    <Tile
      label={label}
      value={stats.count === 0 ? "—" : formatDuration(stats.median)}
      hint={stats.count === 0 ? "Nothing measured yet" : `median · average ${formatDuration(stats.average)} · 90% within ${formatDuration(stats.p90)} · ${stats.count} measured`}
    />
  );
}

export default withWorkspace(function AnalyticsPage({ workspace }) {
  const [days, setDays] = useState<number>(30);
  const { data, error, reload } = useApiQuery<HandoffAnalytics>(`/workspaces/${workspace.id}/handoffs/analytics?days=${days}`);
  const { nameOf } = useMembers();

  const most = Math.max(1, ...(data?.byTrigger.map((t) => t.count) ?? []));
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Analytics" description="How often AI employees hand conversations to people, why, and how quickly people and the AI answer.">
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
      </PageHeader>

      {error && !data ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : !data ? (
        <LoadingState rows={4} />
      ) : (
        <>
          <section aria-label="Right now" className="grid gap-3 sm:grid-cols-3">
            <Tile label="In the queue now" value={String(data.open.queue)} hint="Waiting, no one assigned" />
            <Tile label="Assigned, not picked up" value={String(data.open.assigned)} />
            <Tile label="Being answered by people" value={String(data.open.humanActive)} />
          </section>

          <section aria-label="Handoffs" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Handoffs" value={String(data.handoffs)} hint={`${data.conversations} active conversations`} />
            <Tile
              label="Handoff rate"
              value={data.handoffRate === null ? "—" : `${Math.round(data.handoffRate * 100)}%`}
              hint="Conversations handed to people at least once"
            />
            <Tile label="Resolved by people" value={String(data.outcomes.resolved)} hint={`${data.outcomes.returnedToAi} returned to the AI · ${data.outcomes.open} still open`} />
            <Tile
              label="Copilot suggestions used"
              value={data.suggestions.total === 0 ? "—" : `${data.suggestions.used} of ${data.suggestions.total}`}
            />
          </section>

          <section aria-label="Response times" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <DurationTile label="Time until a person took over" stats={data.timeToAccept} />
            <DurationTile label="Time to a person's first reply" stats={data.timeToFirstResponse} />
            <DurationTile label="Time to resolve" stats={data.timeToResolve} />
            <DurationTile label="AI reply time" stats={data.replyTime.ai} />
            <DurationTile label="Human reply time" stats={data.replyTime.human} />
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Why conversations were handed off</CardTitle>
              </CardHeader>
              <CardContent>
                {data.byTrigger.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No handoffs in this period.</p>
                ) : (
                  <ul className="flex flex-col gap-3">
                    {data.byTrigger.map((t) => (
                      <li key={t.trigger} className="flex flex-col gap-1" title={`${HANDOFF_TRIGGER_LABELS[t.trigger]}: ${t.count}`}>
                        <div className="flex justify-between gap-2 text-sm">
                          <span>{HANDOFF_TRIGGER_LABELS[t.trigger]}</span>
                          <span className="tabular-nums text-muted-foreground">{t.count}</span>
                        </div>
                        <div className="h-2 rounded-r-[4px] bg-muted" aria-hidden>
                          <div className="h-full rounded-r-[4px] bg-primary" style={{ width: `${(t.count / most) * 100}%` }} />
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

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
      )}
    </div>
  );
});
