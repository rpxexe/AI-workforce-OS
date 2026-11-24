"use client";

import {
  DETECTED_LANGUAGES,
  ENTITY_TYPES,
  HANDOFF_TRIGGER_LABELS,
  INTENTS,
  type DurationStats,
  type HandoffAnalytics,
  type InsightsOverview,
} from "@workforce/shared";
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

const pct = (n: number, of: number) => (of === 0 ? "—" : `${Math.round((n / of) * 100)}%`);

/** A labelled horizontal bar per row, longest first. */
function Bars({ title, rows, empty }: { title: string; rows: { label: string; count: number }[]; empty: string }) {
  const most = Math.max(1, ...rows.map((r) => r.count));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {rows.map((r) => (
              <li key={r.label} className="flex flex-col gap-1" title={`${r.label}: ${r.count}`}>
                <div className="flex justify-between gap-2 text-sm">
                  <span>{r.label}</span>
                  <span className="tabular-nums text-muted-foreground">{r.count}</span>
                </div>
                <div className="h-2 rounded-r-[4px] bg-muted" aria-hidden>
                  <div className="h-full rounded-r-[4px] bg-primary" style={{ width: `${(r.count / most) * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Phase 15: languages, code-switching, sentiment, intents, entities, resolution and escalation over the period. */
function Insights({ data }: { data: InsightsOverview }) {
  const n = data.analyzed;
  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">Conversation intelligence</h2>
        <p className="text-sm text-muted-foreground">
          Read from customers&apos; messages: {n === data.conversations ? `${n} conversations` : `the newest ${n} of ${data.conversations} conversations`}. Languages
          describe messages, not people.
        </p>
      </div>
      <section aria-label="Conversation intelligence" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Mixed-language conversations" value={pct(data.codeSwitched, n)} hint={`${data.codeSwitched} with Hinglish or mixed scripts · ${data.withSwitches} switched language`} />
        <Tile label="Negative sentiment" value={pct(data.sentiment.negative, n)} hint={`${data.sentiment.positive} positive · ${data.sentiment.mixed} mixed · ${data.sentiment.neutral} neutral`} />
        <Tile label="Resolved" value={pct(data.resolution.resolved, n)} hint={`${data.resolution.with_people} with people · ${data.resolution.open} open`} />
        <Tile
          label="Escalated"
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

export default withWorkspace(function AnalyticsPage({ workspace }) {
  const [days, setDays] = useState<number>(30);
  const { data, error, reload } = useApiQuery<HandoffAnalytics>(`/workspaces/${workspace.id}/handoffs/analytics?days=${days}`);
  const insights = useApiQuery<InsightsOverview>(`/workspaces/${workspace.id}/insights?days=${days}`);
  const { nameOf } = useMembers();

  const most = Math.max(1, ...(data?.byTrigger.map((t) => t.count) ?? []));
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Analytics"
        description="How often AI employees hand conversations to people, why, how quickly people and the AI answer, and what customers talk about."
      >
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

      {insights.error && !insights.data ? (
        <ErrorState message={insights.error.message} onRetry={insights.reload} />
      ) : !insights.data ? (
        <LoadingState rows={3} />
      ) : (
        <Insights data={insights.data} />
      )}
    </div>
  );
});
