"use client";

import { ArrowRightLeft, CircleCheck, Frown, Headset, Inbox, Languages, Percent, Sparkles, Timer, TriangleAlert, UserCheck, UserRoundCheck } from "lucide-react";
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
import { Skeleton as Skullet } from "skullet/react";
import { ErrorState, PageHeader, StatTile } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApiQuery } from "@/lib/api";
import { useMembers } from "@/lib/members";
import { withWorkspace } from "@/lib/workspace";

const PERIODS = [7, 30, 90] as const;

const SAMPLE_DURATION: DurationStats = { count: 42, average: 312, median: 245, p90: 840 };

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE_HANDOFFS: HandoffAnalytics = {
  days: 30,
  conversations: 1240,
  handoffs: 186,
  handoffRate: 0.15,
  byTrigger: [
    { trigger: "customer_request", count: 72 },
    { trigger: "low_confidence", count: 48 },
    { trigger: "policy_risk", count: 31 },
    { trigger: "repeated_failure", count: 22 },
    { trigger: "agent", count: 13 },
  ],
  outcomes: { resolved: 140, returnedToAi: 28, open: 18 },
  open: { queue: 6, assigned: 3, humanActive: 9 },
  timeToAccept: SAMPLE_DURATION,
  timeToFirstResponse: SAMPLE_DURATION,
  timeToResolve: SAMPLE_DURATION,
  replyTime: { ai: SAMPLE_DURATION, human: SAMPLE_DURATION },
  byAgent: Array.from({ length: 5 }, (_, i) => ({
    agentId: `sample-${i}`,
    handoffs: 40 - i * 5,
    resolved: 32 - i * 4,
    firstResponse: SAMPLE_DURATION,
  })),
  suggestions: { total: 120, used: 84 },
};

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE_INSIGHTS: InsightsOverview = {
  days: 30,
  conversations: 1240,
  analyzed: 1000,
  languages: [
    { language: "en", conversations: 520 },
    { language: "hinglish", conversations: 310 },
    { language: "hi", conversations: 120 },
    { language: "ta", conversations: 30 },
    { language: "bn", conversations: 20 },
  ],
  codeSwitched: 340,
  withSwitches: 210,
  sentiment: { positive: 420, negative: 180, neutral: 340, mixed: 60 },
  intents: [
    { intent: "order_status", conversations: 280 },
    { intent: "refund", conversations: 160 },
    { intent: "delivery", conversations: 140 },
    { intent: "payment", conversations: 90 },
    { intent: "complaint", conversations: 60 },
  ],
  entities: [
    { type: "order_id", count: 410 },
    { type: "phone", count: 260 },
    { type: "person_name", count: 180 },
    { type: "address", count: 90 },
    { type: "amount", count: 70 },
  ],
  resolution: { resolved: 700, with_people: 150, open: 150 },
  escalation: { conversations: 186, rate: 0.15, withSignals: 24 },
};

/** A duration headline: the median, with the average, 90th percentile and sample size underneath. */
function DurationTile({ label, stats }: { label: string; stats: DurationStats }) {
  return (
    <StatTile
      label={label} icon={Timer}
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
                <Progress value={(r.count / most) * 100} className="h-2" aria-hidden />
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
        <StatTile label="Mixed-language conversations" icon={Languages} value={pct(data.codeSwitched, n)} hint={`${data.codeSwitched} with Hinglish or mixed scripts · ${data.withSwitches} switched language`} />
        <StatTile label="Negative sentiment" icon={Frown} value={pct(data.sentiment.negative, n)} hint={`${data.sentiment.positive} positive · ${data.sentiment.mixed} mixed · ${data.sentiment.neutral} neutral`} />
        <StatTile label="Resolved" icon={CircleCheck} value={pct(data.resolution.resolved, n)} hint={`${data.resolution.with_people} with people · ${data.resolution.open} open`} />
        <StatTile
          label="Escalated" icon={TriangleAlert}
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
      ) : (
        <Skullet data={data} sample={SAMPLE_HANDOFFS} id="analytics-handoffs" label="Loading analytics">
          {(data) => {
            const most = Math.max(1, ...data.byTrigger.map((t) => t.count));
            return (
        <>
          <section aria-label="Right now" className="grid gap-3 sm:grid-cols-3">
            <StatTile label="In the queue now" icon={Inbox} value={String(data.open.queue)} hint="Waiting, no one assigned" />
            <StatTile label="Assigned, not picked up" icon={UserCheck} value={String(data.open.assigned)} />
            <StatTile label="Being answered by people" icon={Headset} value={String(data.open.humanActive)} />
          </section>

          <section aria-label="Handoffs" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Handoffs" icon={ArrowRightLeft} value={String(data.handoffs)} hint={`${data.conversations} active conversations`} />
            <StatTile
              label="Handoff rate" icon={Percent}
              value={data.handoffRate === null ? "—" : `${Math.round(data.handoffRate * 100)}%`}
              hint="Conversations handed to people at least once"
            />
            <StatTile label="Resolved by people" icon={UserRoundCheck} value={String(data.outcomes.resolved)} hint={`${data.outcomes.returnedToAi} returned to the AI · ${data.outcomes.open} still open`} />
            <StatTile
              label="Copilot suggestions used" icon={Sparkles}
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
                        <Progress value={(t.count / most) * 100} className="h-2" aria-hidden />
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
            );
          }}
        </Skullet>
      )}

      {insights.error && !insights.data ? (
        <ErrorState message={insights.error.message} onRetry={insights.reload} />
      ) : (
        <Skullet data={insights.data} sample={SAMPLE_INSIGHTS} id="analytics-insights" label="Loading conversation intelligence">
          {(data) => <Insights data={data} />}
        </Skullet>
      )}
    </div>
  );
});
