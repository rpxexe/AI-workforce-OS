"use client";

import type { DashboardSummary, EmployeeStatus, EmployeeSummary, LimitUsage } from "@workforce/shared";
import { ATTENTION_DEFAULTS, DASHBOARD_DAYS, DASHBOARD_PERIODS, LIMIT_LABELS } from "@workforce/shared";
import {
  ArrowRight,
  Bot,
  CalendarClock,
  CircleCheck,
  CirclePause,
  FilePen,
  Gauge as GaugeIcon,
  Headset,
  Inbox,
  MessagesSquare,
  Percent,
  Plus,
  ShieldAlert,
  TrendingUp,
  UserCheck,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Skeleton as Skullet } from "skullet/react";
import { AttentionThresholds } from "@/components/attention-thresholds";
import { EmployeeAvatar, StatusBadge, formatDate } from "@/components/employees/meta";
import { EmptyState, ErrorState, PageHeader, StatTile } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { useApiQuery } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useIsAdmin, withWorkspace } from "@/lib/workspace";

// The dashboard answers "what needs me now?" with numbers and actions; the charts live on Analytics, Quality,
// Reports and Billing, and every number here links to its page.

/** "the last 7 days" / "the 7 days before", for hints that follow the chosen period. */
const span = (days: number) => `${days} days`;
const n = (v: number) => v.toLocaleString("en-US");
const usd = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shareOf = (l: LimitUsage) => (l.limit > 0 ? Math.min(1, l.used / l.limit) : 1);
/** Handoff-rate change against the period before, in percentage points; null when either period has no rate. */
const ratePoints = (h: Pick<DashboardSummary, "handoffRate" | "previousHandoffRate">) => (h.handoffRate === null || h.previousHandoffRate === null ? null : Math.round((h.handoffRate - h.previousHandoffRate) * 100));

// Stands in for the real list so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE_EMPLOYEES: EmployeeSummary[] = Array.from({ length: 5 }, (_, i) => ({
  id: `sample-${i}`,
  name: "Sample employee",
  role: "Customer support agent",
  description: "",
  avatar: "bot",
  language: "en",
  status: "ACTIVE",
  latestVersion: 1,
  publishedVersion: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
}));

// Stands in for the real summary so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE: DashboardSummary = {
  days: DASHBOARD_DAYS,
  conversations: 120,
  handoffs: 18,
  handoffRate: 0.15,
  previousHandoffRate: 0.18,
  open: { queue: 2, assigned: 1, humanActive: 3 },
  quality: { evaluations: 40, averageScore: 84, passRate: 0.86, failures: 6, topFailure: "Answer is grounded in knowledge" },
  employees: { counts: { ACTIVE: 4, PAUSED: 1, DRAFT: 1, ARCHIVED: 0 }, list: SAMPLE_EMPLOYEES },
  attention: ATTENTION_DEFAULTS,
  billing: { planName: "Starter", periodEnd: "2026-02-01T00:00:00.000Z", workspaceUsd: 12.4, organizationUsd: 18.4, limits: [] },
};

/** A link to the page with the full story, for a card's header. */
function More({ href, children }: { href: string; children: string }) {
  return (
    <Button variant="ghost" size="sm" asChild>
      <Link href={href}>
        {children}
        <ArrowRight aria-hidden />
      </Link>
    </Button>
  );
}

/** A stat tile that opens the page behind its number. */
function TileLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="rounded-xl outline-none transition-opacity hover:opacity-80 focus-visible:ring-[3px] focus-visible:ring-ring/50">
      {children}
    </Link>
  );
}

export default withWorkspace(function DashboardPage({ workspace }) {
  const isAdmin = useIsAdmin();
  // One request for the whole page: counts done in SQL, not the full analytics, quality and billing reports.
  const [days, setDays] = useState<number>(DASHBOARD_DAYS);
  const { data, error, reload, loading } = useApiQuery<DashboardSummary>(`/workspaces/${workspace.id}/dashboard?days=${days}`, { keepPrevious: true });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Dashboard" description={`Your AI workforce in the ${workspace.name} workspace. Numbers cover the last ${span(days)}.`}>
        {loading && data !== undefined && <Spinner className="text-muted-foreground" aria-label="Loading the new period" />}
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger aria-label="Period" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DASHBOARD_PERIODS.map((d) => (
              <SelectItem key={d} value={String(d)}>
                Last {d} days
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {isAdmin && (
          <Button asChild>
            <Link href="/employees/new">
              <Plus aria-hidden />
              New employee
            </Link>
          </Button>
        )}
      </PageHeader>

      {error && !data ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : (
        <Skullet data={data} sample={SAMPLE} id="dashboard" label="Loading dashboard">
          {(data) => (
            <div className="flex flex-col gap-6">
              <Headline data={data} />
              <div className="grid gap-4 lg:grid-cols-3">
                <div className="lg:col-span-2">
                  <Attention data={data} isAdmin={isAdmin} workspaceId={workspace.id} onSaved={reload} />
                </div>
                <Workforce employees={data.employees} />
              </div>
              <div className="grid gap-4 lg:grid-cols-3">
                <div className="lg:col-span-2">
                  <Recent employees={data.employees.list} isAdmin={isAdmin} />
                </div>
                <BillingCard data={data.billing} />
              </div>
            </div>
          )}
        </Skullet>
      )}
    </div>
  );
});

/** Four numbers for the period, each opening the page with its chart. */
function Headline({ data: h }: { data: DashboardSummary }) {
  const points = ratePoints(h);
  const { queue, assigned, humanActive } = h.open;
  const quality = h.quality;
  const score = quality.averageScore;
  return (
    <section aria-label="This period" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <TileLink href="/analytics">
        <StatTile label="Conversations" icon={MessagesSquare} value={n(h.conversations)} hint={`${n(h.handoffs)} handed to people`} />
      </TileLink>
      <TileLink href="/analytics">
        <StatTile
          label="Handoff rate" icon={Percent}
          value={h.handoffRate === null ? "—" : `${Math.round(h.handoffRate * 100)}%`}
          hint={points === null ? "No earlier period to compare" : points === 0 ? `Same as the ${span(h.days)} before` : `${Math.abs(points)} ${Math.abs(points) === 1 ? "pt" : "pts"} ${points < 0 ? "lower" : "higher"} than the ${span(h.days)} before`}
        />
      </TileLink>
      <TileLink href="/quality">
        <StatTile
          label="Quality score" icon={GaugeIcon}
          value={score === null ? "—" : String(score)}
          hint={quality.evaluations === 0 ? `Nothing graded in the last ${span(h.days)}` : `${Math.round((quality.passRate ?? 0) * 100)}% passing · ${n(quality.evaluations)} graded`}
        />
      </TileLink>
      <TileLink href="/conversations">
        <StatTile label="With people now" icon={Headset} value={n(queue + assigned + humanActive)} hint={`${n(queue)} waiting · ${n(assigned)} assigned · ${n(humanActive)} answering`} />
      </TileLink>
    </section>
  );
}

type Tone = "danger" | "warning" | "info";
type Task = { key: string; tone: Tone; icon: LucideIcon; title: string; description: string; href: string; action: string };
const TONE: Record<Tone, string> = { danger: "text-destructive", warning: "text-warning", info: "text-info" };
const RANK: Record<Tone, number> = { danger: 0, warning: 1, info: 2 };

/** What someone should look at now, most urgent first, worked out from the numbers the other pages chart. */
function Attention({ data: h, isAdmin, workspaceId, onSaved }: { data: DashboardSummary; isAdmin: boolean; workspaceId: string; onSaved: () => void }) {
  const limits = h.attention;
  const { quality, billing } = h;
  const employees = h.employees.list;
  const tasks: Task[] = [];
  if (h.open.queue > 0)
    tasks.push({ key: "queue", tone: "danger", icon: Inbox, title: `${n(h.open.queue)} ${h.open.queue === 1 ? "conversation is" : "conversations are"} waiting for a person`, description: "No one has picked them up yet.", href: "/conversations", action: "Open inbox" });
  if (h.open.assigned > 0)
    tasks.push({ key: "assigned", tone: "warning", icon: UserCheck, title: `${n(h.open.assigned)} assigned but not picked up`, description: "Someone has them, but has not answered yet.", href: "/conversations", action: "Open inbox" });
  const points = ratePoints(h);
  if (points !== null && points >= limits.handoffRateRise)
    tasks.push({ key: "rate", tone: "warning", icon: TrendingUp, title: `Handoff rate is up ${points} pts on the ${span(h.days)} before`, description: "See which reasons grew.", href: "/analytics", action: "Analytics" });
  if (quality.failures > 0) {
    tasks.push({
      key: "quality",
      tone: quality.averageScore !== null && quality.averageScore < limits.qualityScoreBelow ? "danger" : "warning",
      icon: ShieldAlert,
      title: `${n(quality.failures)} failed ${quality.failures === 1 ? "check" : "checks"} in the last ${span(h.days)}`,
      description: quality.topFailure ? `Failed most: ${quality.topFailure}.` : "See the conversations that failed.",
      href: "/quality",
      action: "Quality",
    });
  }
  for (const l of billing.limits) {
    const share = shareOf(l);
    if (share >= limits.limitUsedPercent / 100)
      tasks.push({ key: `limit-${l.key}`, tone: share >= 1 ? "danger" : "warning", icon: GaugeIcon, title: `${LIMIT_LABELS[l.key]}: ${Math.round(share * 100)}% of the plan used`, description: share >= 1 ? "At the limit for this period." : "Close to the limit for this period.", href: "/billing", action: "Billing" });
  }
  const paused = employees.filter((e) => e.status === "PAUSED");
  if (paused.length > 0)
    tasks.push({ key: "paused", tone: "info", icon: CirclePause, title: `${paused.length} ${paused.length === 1 ? "employee is" : "employees are"} paused`, description: paused.slice(0, 3).map((e) => e.name).join(", "), href: "/employees", action: "Employees" });
  if (isAdmin)
    for (const e of employees.filter((e) => e.status !== "ARCHIVED" && e.latestVersion > (e.publishedVersion ?? 0)).slice(0, 3))
      tasks.push({ key: `draft-${e.id}`, tone: "info", icon: FilePen, title: `${e.name} has unpublished changes`, description: `Version ${e.latestVersion} is saved but not live.`, href: `/employees/${e.id}`, action: "Review" });
  tasks.sort((a, b) => RANK[a.tone] - RANK[b.tone]);

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Needs attention</CardTitle>
        {isAdmin && (
          <CardAction>
            <AttentionThresholds workspaceId={workspaceId} value={limits} onSaved={onSaved} />
          </CardAction>
        )}
        <CardDescription>Most urgent first.</CardDescription>
      </CardHeader>
      <CardContent>
        {tasks.length === 0 ? (
          <EmptyState icon={CircleCheck} title="All clear" description="Nothing is waiting for a person and every number is within range." />
        ) : (
          <ItemGroup className="gap-2">
            {tasks.map((t) => (
              <Item key={t.key} variant="outline" size="sm">
                <ItemMedia variant="icon">
                  <t.icon className={TONE[t.tone]} aria-hidden />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{t.title}</ItemTitle>
                  <ItemDescription>{t.description}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button variant="outline" size="sm" asChild>
                    <Link href={t.href}>{t.action}</Link>
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        )}
      </CardContent>
    </Card>
  );
}

const STATUS_ORDER: EmployeeStatus[] = ["ACTIVE", "PAUSED", "DRAFT", "ARCHIVED"];

/** Employees per status, as a short list; the counts link to the employee list. */
function Workforce({ employees: { counts, list } }: { employees: DashboardSummary["employees"] }) {
  const live = list.filter((e) => e.publishedVersion !== null && e.status === "ACTIVE").length;
  const total = list.length;
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Workforce</CardTitle>
        <CardDescription>
          {n(total)} {total === 1 ? "employee" : "employees"} · {n(live)} live
        </CardDescription>
        <CardAction>
          <More href="/employees">Employees</More>
        </CardAction>
      </CardHeader>
      <CardContent>
        {total === 0 && counts.ARCHIVED === 0 ? (
          <EmptyState icon={Bot} title="No employees yet" description="Create one to give it a role, a personality and goals." />
        ) : (
          <ul className="flex flex-col divide-y">
            {STATUS_ORDER.map((status) => (
              <li key={status} className="flex items-center justify-between gap-2 py-2.5">
                <StatusBadge status={status} />
                <span className="text-sm font-semibold tabular-nums">{n(counts[status])}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** The employees the team worked on last. */
function Recent({ employees, isAdmin }: { employees: EmployeeSummary[]; isAdmin: boolean }) {
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Recently changed</CardTitle>
        <CardDescription>The employees your team worked on last.</CardDescription>
        <CardAction>
          <More href="/employees">All employees</More>
        </CardAction>
      </CardHeader>
      <CardContent>
        {employees.length === 0 ? (
          <EmptyState
            icon={Bot}
            title="No employees yet"
            description={isAdmin ? "Create your first AI employee to give it a role, a personality and goals." : "An organization admin has not created any AI employees in this workspace yet."}
          >
            {isAdmin && (
              <Button asChild>
                <Link href="/employees/new">
                  <Plus aria-hidden />
                  New employee
                </Link>
              </Button>
            )}
          </EmptyState>
        ) : (
          <ul className="flex flex-col divide-y">
            {employees.slice(0, 5).map((e) => (
              <li key={e.id}>
                <Link href={`/employees/${e.id}`} className="flex items-center gap-3 rounded-md px-2 py-2.5 hover:bg-muted/50">
                  <EmployeeAvatar avatar={e.avatar} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{e.name}</span>
                    <span className="truncate text-sm text-muted-foreground">{e.role}</span>
                  </span>
                  <span className="hidden text-sm text-muted-foreground sm:inline">{formatDate(e.updatedAt)}</span>
                  <StatusBadge status={e.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** This billing period: what this workspace has billed, the organization's total, and the plan limit closest to running out. */
function BillingCard({ data }: { data: DashboardSummary["billing"] }) {
  const closest = [...data.limits].sort((a, b) => shareOf(b) - shareOf(a))[0];
  const share = closest ? shareOf(closest) : 0;
  // Read once per mount: render must stay pure.
  const [now] = useState(Date.now);
  const daysLeft = Math.max(0, Math.ceil((Date.parse(data.periodEnd) - now) / 86_400_000));
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Billing period</CardTitle>
        <CardDescription>{data.planName} plan</CardDescription>
        <CardAction>
          <More href="/billing">Billing</More>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm text-muted-foreground">Billed for this workspace</span>
          <span className="text-2xl font-bold tabular-nums">{usd(data.workspaceUsd)}</span>
          <span className="text-xs text-muted-foreground">{usd(data.organizationUsd)} across the organization</span>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <CalendarClock className="size-4" aria-hidden />
          Renews {new Date(data.periodEnd).toLocaleDateString(undefined, { day: "numeric", month: "short" })} · {daysLeft} {daysLeft === 1 ? "day" : "days"} left
        </div>
        {closest && (
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between gap-2 text-sm">
              <span>{LIMIT_LABELS[closest.key]}</span>
              <span className="tabular-nums text-muted-foreground">{Math.round(share * 100)}% used</span>
            </div>
            <Progress
              value={share * 100}
              className={cn("h-2", share >= 1 ? "*:data-[slot=progress-indicator]:bg-destructive" : share >= 0.8 ? "*:data-[slot=progress-indicator]:bg-warning" : "")}
              aria-label={`${LIMIT_LABELS[closest.key]} used`}
            />
            <span className="text-xs text-muted-foreground">Plan limits are shared by every workspace in the organization.</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
