"use client";

import { LIMIT_KEYS, LIMIT_LABELS, PLAN_IDS, PLANS, USAGE_KIND_LABELS, USAGE_KINDS, type BillingOverview, type LimitUsage, type PlanId, type UsageKind } from "@workforce/shared";
import { useSearchParams } from "next/navigation";
import { CalendarClock, Check, CreditCard, Cpu, DollarSign, ExternalLink, FileText, Gauge, Info, MessageSquare, MessagesSquare, Phone, Receipt, Workflow, Wrench, type LucideIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { Suspense, useState } from "react";
import { Skeleton as Skullet } from "skullet/react";
import { EmptyState, ErrorState, PageHeader, StatTile } from "@/components/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApi, useApiQuery, type ToastOption } from "@/lib/api";
import { usePageTab } from "@/lib/tabs";
import { cn } from "@/lib/utils";
import { useIsAdmin } from "@/lib/workspace";
import { TablePager, usePaged } from "@/components/table-pager";

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—");
const amount = (cents: number, currency: string) => `${(cents / 100).toLocaleString("en-US", { style: "currency", currency: currency.toUpperCase() })}`;
const number = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 2 }));

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE: BillingOverview = {
  stripe: true,
  enforced: true,
  plan: "starter",
  status: "active",
  period: { start: "2026-01-01T00:00:00.000Z", end: "2026-02-01T00:00:00.000Z" },
  cancelAtPeriodEnd: false,
  hasSubscription: true,
  limits: LIMIT_KEYS.map((key) => ({ key, label: LIMIT_LABELS[key], used: 40, limit: PLANS.starter.limits[key] })),
  usage: {
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-02-01T00:00:00.000Z",
    byKind: USAGE_KINDS.map((kind) => ({ kind, quantity: 1250, events: 320 })),
    amountUsd: 18.4,
    daily: Array.from({ length: 20 }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), amountUsd: 0.5 + ((i * 7) % 10) / 10 })),
    recent: Array.from({ length: 5 }, (_, i) => ({
      id: `sample-${i}`,
      kind: "message",
      quantity: 12,
      amountUsd: 0.36,
      sourceType: "conversation",
      sourceId: "cm0sampleconversation000000",
      workspaceId: null,
      occurredAt: "2026-01-01T00:00:00.000Z",
      detail: null,
    })),
  },
  invoices: [],
  plans: PLAN_IDS.map((id) => ({ id, ...PLANS[id] })),
};


function Billing() {
  const { data, error, reload } = useApiQuery<BillingOverview>("/billing");
  const api = useApi();
  const isAdmin = useIsAdmin();
  const search = useSearchParams();
  const [busy, setBusy] = useState<string | null>(null);

  const go = async (key: string, path: string, toast: ToastOption, body?: unknown) => {
    setBusy(key);
    try {
      const { url } = await api<{ url: string | null }>(path, { method: "POST", body, toast });
      if (url) window.location.assign(url);
      else reload();
    } catch {
      // The toast in useApi shows why it failed.
    } finally {
      setBusy(null);
    }
  };
  const choose = (plan: PlanId) =>
    go(plan, "/billing/checkout", { loading: "Contacting Stripe…", success: `Switch to ${PLANS[plan].name} started` }, { plan });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Billing" description="Your plan, what this period has used, invoices, and the limits that apply.">
        {data?.hasSubscription && isAdmin && (
          <Button variant="outline" disabled={busy !== null} onClick={() => go("portal", "/billing/portal", { loading: "Opening the billing portal…", success: "Billing portal opened" })}>
            Manage payment and invoices
          </Button>
        )}
      </PageHeader>

      {search.get("checkout") === "success" && (
        <Alert role="status">
          <AlertDescription>Thanks. Your plan updates here as soon as Stripe confirms the payment.</AlertDescription>
        </Alert>
      )}

      {error && !data ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : (
        <Skullet data={data} sample={SAMPLE} id="billing" label="Loading billing">
          {(data) => <BillingTabs data={data} isAdmin={isAdmin} busy={busy} choose={choose} />}
        </Skullet>
      )}
    </div>
  );
}

// Recharts is large; the one chart on this page loads in its own bundle, after the numbers.
const SpendSpark = dynamic(() => import("@/components/billing/spend-chart").then((m) => m.SpendSpark), {
  ssr: false,
  loading: () => <div className="h-16" aria-hidden />,
});

const KIND_ICONS: Record<UsageKind, LucideIcon> = {
  conversation: MessagesSquare,
  message: MessageSquare,
  voice_minutes: Phone,
  tool_call: Wrench,
  workflow_run: Workflow,
  provider: Cpu,
};

/** Share of a limit used, 0..1 (a limit of 0 counts as full). */
const shareOf = (l: LimitUsage) => (l.limit > 0 ? Math.min(1, l.used / l.limit) : 1);
const limitValue = (l: LimitUsage, n: number) => (l.key === "aiUsageUsd" ? usd(n) : number(n));
/** Progress bar colour: amber from 80%, red at the limit. */
const toneClass = (share: number) =>
  share >= 1 ? "*:data-[slot=progress-indicator]:bg-destructive" : share >= 0.8 ? "*:data-[slot=progress-indicator]:bg-warning" : "";

/** Always-visible summary: the plan, what this period has billed, how much of the period is left, and the limit closest to running out. */
function Summary({ data }: { data: BillingOverview }) {
  const plan = data.plans.find((p) => p.id === data.plan);
  const start = Date.parse(data.period.start);
  const end = Date.parse(data.period.end);
  // Read once per mount: render must stay pure.
  const [now] = useState(Date.now);
  const elapsed = Math.min(1, Math.max(0, (now - start) / (end - start)));
  const daysLeft = Math.max(0, Math.ceil((end - now) / 86_400_000));
  const closest = [...data.limits].sort((a, b) => shareOf(b) - shareOf(a))[0];
  const healthy = ["active", "trialing"].includes(data.status);
  return (
    <section aria-label="Summary" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <StatTile
        label="Plan" icon={CreditCard}
        value={
          <span className="flex flex-wrap items-center gap-2">
            {plan?.name ?? data.plan}
            <Badge variant={healthy ? "secondary" : "destructive"} className="font-normal capitalize">
              {data.status.replace("_", " ")}
            </Badge>
          </span>
        }
        hint={`${plan && plan.monthlyUsd > 0 ? `${usd(plan.monthlyUsd)} a month · ` : ""}${data.cancelAtPeriodEnd ? `ends ${date(data.period.end)}, then Free` : `renews ${date(data.period.end)}`}`}
      />
      <StatTile
        label="Usage billed this period" icon={DollarSign} value={usd(data.usage.amountUsd)}
        hint={data.usage.daily.length > 0 ? `${usd(data.usage.amountUsd / data.usage.daily.length)} a day on average` : "Nothing billed yet"}
      >
        <SpendSpark rows={data.usage.daily} />
      </StatTile>
      <StatTile label="Billing period" icon={CalendarClock} value={`${daysLeft} ${daysLeft === 1 ? "day" : "days"} left`} hint={`${date(data.period.start)} to ${date(data.period.end)}`}>
        <Progress value={elapsed * 100} className="h-2" aria-label="Share of the billing period gone" />
      </StatTile>
      {closest && (
        <StatTile
          label="Closest limit" icon={Gauge}
          value={`${Math.round(shareOf(closest) * 100)}%`}
          hint={`${LIMIT_LABELS[closest.key]}: ${limitValue(closest, closest.used)} of ${limitValue(closest, closest.limit)}${data.enforced ? "" : " · not enforced"}`}
        >
          <Progress value={shareOf(closest) * 100} className={cn("h-2", toneClass(shareOf(closest)))} aria-label={`${LIMIT_LABELS[closest.key]} used`} />
        </StatTile>
      )}
    </section>
  );
}

/** One plan to compare and pick: price, what it allows, and the action that moves to it. */
function PlanCard({ p, data, isAdmin, busy, choose }: { p: BillingOverview["plans"][number]; data: BillingOverview; isAdmin: boolean; busy: string | null; choose: (plan: PlanId) => void }) {
  const current = p.id === data.plan;
  const currentPrice = data.plans.find((x) => x.id === data.plan)?.monthlyUsd ?? 0;
  const action = p.id === "free" ? "Downgrade at period end" : p.monthlyUsd > currentPrice ? `Upgrade to ${p.name}` : `Switch to ${p.name}`;
  return (
    <Card className={cn("gap-4", current && "border-primary ring-1 ring-primary")}>
      <CardHeader className="gap-1">
        <CardTitle className="flex items-center justify-between gap-2">
          {p.name}
          {current && <Badge>Current</Badge>}
        </CardTitle>
        <p className="flex items-baseline gap-1">
          <span className="text-3xl font-bold tabular-nums">{p.monthlyUsd === 0 ? "Free" : usd(p.monthlyUsd)}</span>
          {p.monthlyUsd > 0 && <span className="text-sm text-muted-foreground">/ month</span>}
        </p>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4 text-sm">
        <Separator />
        <ul className="flex flex-1 flex-col gap-2">
          {Object.entries(p.limits).map(([key, value]) => (
            <li key={key} className="flex items-start gap-2">
              <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
              <span>{key === "aiUsageUsd" ? `Usage up to ${usd(value)}` : `${number(value)} ${LIMIT_LABELS[key as keyof typeof LIMIT_LABELS].toLowerCase()}`}</span>
            </li>
          ))}
        </ul>
        {current ? (
          <Button variant="outline" disabled>
            Current plan
          </Button>
        ) : (
          <Button
            variant={p.id === "free" ? "outline" : "default"}
            disabled={!isAdmin || !data.stripe || busy !== null || (p.id === "free" && !data.hasSubscription)}
            onClick={() => choose(p.id)}
          >
            {busy === p.id ? "Opening…" : action}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/** One limit as a card: used of allowed, what is left, and a bar that turns amber near the limit and red at it. */
function LimitCard({ l }: { l: LimitUsage }) {
  const share = shareOf(l);
  const left = Math.max(0, l.limit - l.used);
  return (
    <Card className="gap-3 py-5">
      <CardContent className="flex flex-col gap-3 px-5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">{LIMIT_LABELS[l.key]}</span>
          {share >= 1 ? (
            <Badge variant="destructive">At limit</Badge>
          ) : share >= 0.8 ? (
            <Badge variant="outline" className="text-warning">
              Nearly full
            </Badge>
          ) : null}
        </div>
        <p className="flex items-baseline gap-1">
          <span className="text-2xl font-bold tabular-nums">{limitValue(l, l.used)}</span>
          <span className="text-sm text-muted-foreground">of {limitValue(l, l.limit)}</span>
        </p>
        <Progress value={share * 100} className={cn("h-2", toneClass(share))} aria-label={`${LIMIT_LABELS[l.key]} used`} />
        <span className="text-xs text-muted-foreground">
          {Math.round(share * 100)}% used · {limitValue(l, left)} left
        </span>
      </CardContent>
    </Card>
  );
}

function BillingTabs({
  data,
  isAdmin,
  busy,
  choose,
}: {
  data: BillingOverview;
  isAdmin: boolean;
  busy: string | null;
  choose: (plan: PlanId) => void;
}) {
  const usage = usePaged(data.usage.recent, 20);
  const [tab, setTab] = usePageTab("/billing");
  return (
    <div className="flex flex-col gap-6">
      <Summary data={data} />

      <Tabs value={tab} onValueChange={setTab} className="gap-4">
        <TabsList>
          <TabsTrigger value="plan">Plan</TabsTrigger>
          <TabsTrigger value="usage">Usage</TabsTrigger>
          <TabsTrigger value="invoices">Invoices</TabsTrigger>
          <TabsTrigger value="limits">Limits</TabsTrigger>
        </TabsList>

        <TabsContent value="plan" className="flex flex-col gap-4">
          {!data.stripe && (
            <Alert>
              <Info aria-hidden />
              <AlertTitle>Payments are not set up on this server</AlertTitle>
              <AlertDescription>Plans cannot be bought here, and limits are not enforced.</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {data.plans.map((p) => (
              <PlanCard key={p.id} p={p} data={data} isAdmin={isAdmin} busy={busy} choose={choose} />
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Usage of the platform&apos;s AI, speech, call and email services is billed on the next invoice. Usage through your own provider keys is paid to the provider
            directly.
          </p>
        </TabsContent>

        <TabsContent value="usage" className="flex flex-col gap-4">
          <section aria-label="Usage by kind" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.usage.byKind.map((k) => (
              <StatTile key={k.kind} label={USAGE_KIND_LABELS[k.kind]} icon={KIND_ICONS[k.kind]} value={number(k.quantity)} hint={`${k.events} ledger ${k.events === 1 ? "entry" : "entries"}`} />
            ))}
          </section>
          <Card>
            <CardHeader>
              <CardTitle>Newest ledger entries</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {data.usage.recent.length === 0 ? (
                <EmptyState icon={Receipt} title="Nothing recorded yet" description="Usage appears here as conversations, calls and tools run this period." />
              ) : (
                <>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>When</TableHead>
                        <TableHead>Kind</TableHead>
                        <TableHead className="text-right">Quantity</TableHead>
                        <TableHead className="text-right">Billed</TableHead>
                        <TableHead>Source</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {usage.rows.map((e) => (
                        <TableRow key={e.id}>
                          <TableCell className="whitespace-nowrap text-muted-foreground">{new Date(e.occurredAt).toLocaleString()}</TableCell>
                          <TableCell>{USAGE_KIND_LABELS[e.kind]}</TableCell>
                          <TableCell className="text-right tabular-nums">{number(e.quantity)}</TableCell>
                          <TableCell className="text-right tabular-nums">{e.amountUsd === null ? "—" : usd(e.amountUsd)}</TableCell>
                          <TableCell>
                            <span className="flex items-center gap-2">
                              <Badge variant="outline" className="font-normal">
                                {e.sourceType}
                              </Badge>
                              <span className="max-w-48 truncate font-mono text-xs text-muted-foreground" title={e.sourceId}>
                                {e.sourceId}
                              </span>
                            </span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <TablePager {...usage.pager} />
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="invoices">
          {data.invoices.length === 0 ? (
            <EmptyState icon={FileText} title="No invoices yet" description="Invoices appear here once Stripe issues the first one." />
          ) : (
            <Card>
              <CardContent className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Invoice</TableHead>
                      <TableHead>Period</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead className="text-right">Paid</TableHead>
                      <TableHead className="w-10">
                        <span className="sr-only">Open</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.invoices.map((i) => (
                      <TableRow key={i.id}>
                        <TableCell className="font-medium">{i.number ?? i.id}</TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {date(i.periodStart)} to {date(i.periodEnd)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={i.status === "paid" ? "secondary" : i.status === "open" || i.status === "draft" ? "outline" : "destructive"} className="capitalize">
                            {i.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{amount(i.amountDue, i.currency)}</TableCell>
                        <TableCell className="text-right tabular-nums">{amount(i.amountPaid, i.currency)}</TableCell>
                        <TableCell>
                          {i.hostedInvoiceUrl && (
                            <Button variant="ghost" size="icon" asChild>
                              <a href={i.hostedInvoiceUrl} target="_blank" rel="noreferrer" aria-label={`Open invoice ${i.number ?? i.id}`}>
                                <ExternalLink />
                              </a>
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="limits" className="flex flex-col gap-4">
          {!data.enforced && (
            <Alert>
              <Info aria-hidden />
              <AlertTitle>Limits are not enforced</AlertTitle>
              <AlertDescription>Billing is off on this server, so these limits are shown but nothing is stopped at them.</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.limits.map((l) => (
              <LimitCard key={l.key} l={l} />
            ))}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function BillingPage() {
  // useSearchParams needs a Suspense boundary to prerender.
  return (
    <Suspense>
      <Billing />
    </Suspense>
  );
}
