"use client";

import { useAuth } from "@clerk/nextjs";
import { PROVIDER_TYPE_LABELS, providerMeta, type ProviderAuditEntry, type ProviderMetric, type ProviderSettings, type ProviderType } from "@workforce/shared";
import { Activity, ScrollText } from "lucide-react";
import { useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApiQuery } from "@/lib/api";

const providerName = (type: string, id: string) => providerMeta(type, id)?.name ?? id;
const typeLabel = (type: string) => PROVIDER_TYPE_LABELS[type as ProviderType] ?? type;
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const ACTIONS: Record<string, string> = {
  create: "Connected",
  update: "Configured",
  rotate: "Rotated credentials",
  test: "Tested",
  set_default: "Made default",
  disable: "Disabled",
  enable: "Enabled",
  delete: "Deleted",
};

/** Who changed which connection, newest first (admins). Details hold field names and results, never secrets. */
export function AuditLog({ settings }: { settings: ProviderSettings }) {
  const { userId } = useAuth();
  const { data, error, reload } = useApiQuery<ProviderAuditEntry[]>("/providers/audit");
  const nameOf = (e: ProviderAuditEntry) =>
    settings.connections.find((c) => c.id === e.connectionId)?.displayName ?? (typeof e.detail.displayName === "string" ? e.detail.displayName : "—");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit log</CardTitle>
        <CardDescription>The last 100 changes to provider connections: who connected, configured, tested, rotated or deleted what.</CardDescription>
      </CardHeader>
      <CardContent>
        {error && !data ? (
          <ErrorState message={error.message} onRetry={reload} />
        ) : !data ? (
          <LoadingState rows={3} />
        ) : data.length === 0 ? (
          <EmptyState icon={ScrollText} title="Nothing yet" description="Changes to connections are recorded here." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Connection</TableHead>
                <TableHead className="hidden sm:table-cell">Provider</TableHead>
                <TableHead className="hidden sm:table-cell">By</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{when(e.createdAt)}</TableCell>
                  <TableCell>
                    {ACTIONS[e.action] ?? e.action}
                    {e.action === "test" && (e.detail.ok === true ? ": passed" : e.detail.ok === false ? ": failed" : "")}
                  </TableCell>
                  <TableCell className="max-w-40 truncate">{nameOf(e)}</TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">{providerName(e.providerType, e.providerId)}</TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">{e.actorId === userId ? "You" : "A teammate"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

const money = (v: number) => (v > 0 && v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);

/** Requests, failures, fallbacks, latency and cost per provider over a period. */
export function ProviderMetrics() {
  const [days, setDays] = useState("30");
  const { data, error, reload } = useApiQuery<{ days: number; providers: ProviderMetric[] }>(`/providers/metrics?days=${days}`);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <CardTitle>Provider metrics</CardTitle>
          <CardDescription>Every call to an outside provider: how often it failed or timed out, how often a fallback answered, speed and cost.</CardDescription>
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
      <CardContent>
        {error && !data ? (
          <ErrorState message={error.message} onRetry={reload} />
        ) : !data ? (
          <LoadingState rows={3} />
        ) : data.providers.length === 0 ? (
          <EmptyState icon={Activity} title="No provider calls in this period" description="Calls appear here as employees answer, talk and send." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead className="text-right">Requests</TableHead>
                <TableHead className="text-right">Failure rate</TableHead>
                <TableHead className="text-right">Timeouts</TableHead>
                <TableHead className="text-right">Fallbacks</TableHead>
                <TableHead className="text-right">Avg latency</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Characters</TableHead>
                <TableHead className="text-right">Minutes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="tabular-nums">
              {data.providers.map((m) => (
                <TableRow key={`${m.providerType}-${m.provider}`}>
                  <TableCell>
                    <span className="block font-medium">{providerName(m.providerType, m.provider)}</span>
                    <span className="text-xs text-muted-foreground">{typeLabel(m.providerType)}</span>
                  </TableCell>
                  <TableCell className="text-right">{m.requests.toLocaleString()}</TableCell>
                  <TableCell className="text-right">{m.requests === 0 ? "—" : `${((m.failures / m.requests) * 100).toFixed(1)}%`}</TableCell>
                  <TableCell className="text-right">{m.timeouts.toLocaleString()}</TableCell>
                  <TableCell className="text-right">{m.fallbacks.toLocaleString()}</TableCell>
                  <TableCell className="text-right">{m.avgLatencyMs.toLocaleString()} ms</TableCell>
                  <TableCell className="text-right">{money(m.costUsd)}</TableCell>
                  <TableCell className="text-right">{m.characters > 0 ? m.characters.toLocaleString() : "—"}</TableCell>
                  <TableCell className="text-right">{m.seconds > 0 ? (m.seconds / 60).toFixed(1) : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
