"use client";

import { LIMIT_KEYS, LIMIT_LABELS, PLAN_IDS, PLANS, USAGE_KIND_LABELS, USAGE_KINDS, type BillingOverview, type LimitUsage, type PlanId } from "@workforce/shared";
import { useSearchParams } from "next/navigation";
import { DollarSign } from "lucide-react";
import { Suspense, useState } from "react";
import { Skeleton as Skullet } from "skullet/react";
import { ErrorState, PageHeader, StatTile } from "@/components/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApi, useApiQuery, type ToastOption } from "@/lib/api";
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

/** One limit: used of allowed, with a bar that turns red at the limit. */
function LimitRow({ l }: { l: LimitUsage }) {
  const share = l.limit > 0 ? Math.min(1, l.used / l.limit) : 1;
  return (
    <li className="flex flex-col gap-1" title={`${l.label}: ${number(l.used)} of ${number(l.limit)}`}>
      <div className="flex justify-between gap-2 text-sm">
        <span>{LIMIT_LABELS[l.key]}</span>
        <span className="tabular-nums text-muted-foreground">
          {l.key === "aiUsageUsd" ? `${usd(l.used)} of ${usd(l.limit)}` : `${number(l.used)} of ${number(l.limit)}`}
        </span>
      </div>
      <Progress value={share * 100} className={share >= 1 ? "h-2 *:data-[slot=progress-indicator]:bg-destructive" : "h-2"} aria-hidden />
    </li>
  );
}

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
  return (
        <Tabs defaultValue="plan">
          <TabsList>
            <TabsTrigger value="plan">Plan</TabsTrigger>
            <TabsTrigger value="usage">Usage</TabsTrigger>
            <TabsTrigger value="invoices">Invoices</TabsTrigger>
            <TabsTrigger value="limits">Limits</TabsTrigger>
          </TabsList>

          <TabsContent value="plan" className="flex flex-col gap-4">
            <Card>
              <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                <span className="text-lg font-semibold">{data.plans.find((p) => p.id === data.plan)?.name} plan</span>
                <Badge variant={["active", "trialing"].includes(data.status) ? "secondary" : "destructive"}>{data.status.replace("_", " ")}</Badge>
                <span className="text-muted-foreground">
                  Period {date(data.period.start)} to {date(data.period.end)}
                  {data.cancelAtPeriodEnd && " · ends then, back to Free"}
                </span>
              </CardContent>
            </Card>
            {!data.stripe && <p className="text-sm text-muted-foreground">Payments are not set up on this server, so plans cannot be bought here. Limits are not enforced.</p>}
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {data.plans.map((p) => (
                <Card key={p.id} className={p.id === data.plan ? "border-primary" : undefined}>
                  <CardHeader>
                    <CardTitle className="flex items-baseline justify-between gap-2">
                      {p.name}
                      <span className="text-base font-normal tabular-nums">{p.monthlyUsd === 0 ? "Free" : `${usd(p.monthlyUsd)}/mo`}</span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3 text-sm">
                    <ul className="flex flex-col gap-1 text-muted-foreground">
                      {Object.entries(p.limits).map(([key, value]) => (
                        <li key={key}>
                          {key === "aiUsageUsd" ? `Usage up to ${usd(value)}` : `${number(value)} ${LIMIT_LABELS[key as keyof typeof LIMIT_LABELS].toLowerCase()}`}
                        </li>
                      ))}
                    </ul>
                    {p.id === data.plan ? (
                      <Button variant="outline" disabled>
                        Current plan
                      </Button>
                    ) : (
                      <Button disabled={!isAdmin || !data.stripe || busy !== null || (p.id === "free" && !data.hasSubscription)} onClick={() => choose(p.id)}>
                        {busy === p.id ? "Opening…" : p.id === "free" ? "Downgrade at period end" : `Switch to ${p.name}`}
                      </Button>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Usage of the platform&apos;s AI, speech, call and email services is billed on the next invoice. Usage through your own provider keys is paid to the
              provider directly.
            </p>
          </TabsContent>

          <TabsContent value="usage" className="flex flex-col gap-4">
            <section aria-label="This period" className="grid gap-3 sm:grid-cols-3">
              <StatTile label="Usage billed this period" icon={DollarSign} value={usd(data.usage.amountUsd)} />
            </section>
            <Card>
              <CardHeader>
                <CardTitle>By kind</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Kind</TableHead>
                      <TableHead className="text-right">Quantity</TableHead>
                      <TableHead className="text-right">Ledger entries</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.usage.byKind.map((k) => (
                      <TableRow key={k.kind}>
                        <TableCell>{USAGE_KIND_LABELS[k.kind]}</TableCell>
                        <TableCell className="text-right tabular-nums">{number(k.quantity)}</TableCell>
                        <TableCell className="text-right tabular-nums">{k.events}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Newest ledger entries</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                {data.usage.recent.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing recorded this period yet.</p>
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
                          <TableCell className="whitespace-nowrap">{new Date(e.occurredAt).toLocaleString()}</TableCell>
                          <TableCell>{USAGE_KIND_LABELS[e.kind]}</TableCell>
                          <TableCell className="text-right tabular-nums">{number(e.quantity)}</TableCell>
                          <TableCell className="text-right tabular-nums">{e.amountUsd === null ? "—" : usd(e.amountUsd)}</TableCell>
                          <TableCell className="font-mono text-xs break-all">
                            {e.sourceType} {e.sourceId}
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
            <Card>
              <CardContent className="overflow-x-auto">
                {data.invoices.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No invoices yet.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Invoice</TableHead>
                        <TableHead>Period</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead className="text-right">Paid</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.invoices.map((i) => (
                        <TableRow key={i.id}>
                          <TableCell>
                            {i.hostedInvoiceUrl ? (
                              <a className="underline underline-offset-4" href={i.hostedInvoiceUrl} target="_blank" rel="noreferrer">
                                {i.number ?? i.id}
                              </a>
                            ) : (
                              (i.number ?? i.id)
                            )}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            {date(i.periodStart)} to {date(i.periodEnd)}
                          </TableCell>
                          <TableCell>
                            <Badge variant={i.status === "paid" ? "secondary" : i.status === "open" || i.status === "draft" ? "outline" : "destructive"}>{i.status}</Badge>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{amount(i.amountDue, i.currency)}</TableCell>
                          <TableCell className="text-right tabular-nums">{amount(i.amountPaid, i.currency)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="limits">
            <Card>
              <CardHeader>
                <CardTitle>Limits this period</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {!data.enforced && <p className="text-sm text-muted-foreground">Billing is off on this server, so these limits are shown but not enforced.</p>}
                <ul className="flex flex-col gap-3">
                  {data.limits.map((l) => (
                    <LimitRow key={l.key} l={l} />
                  ))}
                </ul>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
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
