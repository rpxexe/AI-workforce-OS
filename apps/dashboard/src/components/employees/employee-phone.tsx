"use client";

import type { CallDetail, CallSummary, PhoneNumberInfo, ProviderSettings } from "@workforce/shared";
import { PhoneIncoming, PhoneOutgoing } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ConfirmDialog, type Confirmation } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useApi, useApiQuery } from "@/lib/api";

const message = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong. Try again.");
const seconds = (s: number | null) => (s === null ? "" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
/** The phone-account select's value for "no connectionId": the organization's default, else the platform's accounts. */
const ORG_DEFAULT = "default";
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** The employee's phone numbers, outbound calls, and recent calls with their transcripts. */
export function EmployeePhone({
  workspaceId,
  employeeId,
  canEdit,
  live,
}: {
  workspaceId: string;
  employeeId: string;
  canEdit: boolean;
  /** Published and active: only then does it answer or make calls. */
  live: boolean;
}) {
  const api = useApi();
  const base = `/workspaces/${workspaceId}`;
  const numbers = useApiQuery<PhoneNumberInfo[]>(`${base}/phone-numbers`);
  const calls = useApiQuery<CallSummary[]>(`${base}/calls?employeeId=${employeeId}`);
  // Only admins add numbers, so only they need the organization's phone accounts.
  const providers = useApiQuery<ProviderSettings>(canEdit ? "/providers/settings" : null);
  const phoneAccounts = (providers.data?.connections ?? []).filter((c) => c.providerType === "telephony" && c.status === "active");
  const [account, setAccount] = useState(ORG_DEFAULT);
  const [newNumber, setNewNumber] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState<"add" | "call" | string>();
  /** Why a call's transcript did not load; failed changes show a toast instead. */
  const [error, setError] = useState<string>();
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [open, setOpen] = useState<CallDetail>();

  if (numbers.error) return <p className="text-sm text-destructive">{numbers.error.message}</p>;
  if (!numbers.data) return <Skeleton className="h-24 w-full" />;
  const mine = numbers.data.filter((n) => n.employeeId === employeeId);

  const run = async (what: string, action: () => Promise<void>) => {
    setBusy(what);
    setError(undefined);
    try {
      await action();
    } catch {
      // The toast in useApi shows why it failed.
    } finally {
      setBusy(undefined);
    }
  };

  const add = (event: FormEvent) => {
    event.preventDefault();
    const number = newNumber.trim();
    void run("add", async () => {
      await api(`${base}/phone-numbers`, {
        method: "POST",
        body: { number, employeeId, ...(account !== ORG_DEFAULT && { connectionId: account }) },
        toast: { loading: `Connecting ${number}…`, success: `${number} connected` },
      });
      setNewNumber("");
      numbers.reload();
    });
  };
  const place = (event: FormEvent) => {
    event.preventDefault();
    void run("call", async () => {
      await api<CallSummary>(`${base}/employees/${employeeId}/calls`, {
        method: "POST",
        body: { to: to.trim() },
        toast: { loading: "Placing call…", success: `Calling ${to.trim()}` },
      });
      calls.reload();
    });
  };
  const remove = (n: PhoneNumberInfo) =>
    setConfirm({
      title: `Stop answering ${n.number}?`,
      description: "Callers will hear that the number is not in service. The number stays in your phone provider account.",
      confirmLabel: "Remove number",
      onConfirm: () =>
        void run(n.id, async () => {
          await api(`${base}/phone-numbers/${n.id}`, { method: "DELETE", toast: `${n.number} removed` });
          numbers.reload();
        }),
    });
  const reconnect = (n: PhoneNumberInfo) =>
    void run(n.id, async () => {
      await api(`${base}/phone-numbers/${n.id}/reconnect`, {
        method: "POST",
        toast: { loading: `Reconnecting ${n.number}…`, success: `${n.number} now points at this server again` },
      });
    });
  const show = (c: CallSummary) =>
    void run(c.id, async () => {
      try {
        setOpen(open?.id === c.id ? undefined : await api<CallDetail>(`${base}/calls/${c.id}`));
      } catch (err) {
        setError(message(err));
      }
    });

  return (
    <div className="flex flex-col gap-5">
      {!live && <p className="text-sm text-muted-foreground">Publish this employee to let it answer and make calls.</p>}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Phone numbers</h3>
        {mine.length === 0 ? (
          <p className="text-sm text-muted-foreground">No number yet. Add one from your phone provider account.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {mine.map((n) => (
              <li key={n.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-sm tabular-nums">{n.number}</span>
                {canEdit && (
                  <span className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => reconnect(n)} disabled={busy !== undefined}>
                      Reconnect
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => remove(n)} disabled={busy !== undefined}>
                      Remove
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {canEdit && (
          <form onSubmit={add} className="flex flex-wrap items-end gap-2">
            <div className="flex min-w-48 flex-1 flex-col gap-1.5 sm:max-w-xs">
              <Label htmlFor="phone-number" className="text-xs">
                Add a number
              </Label>
              <Input
                id="phone-number"
                value={newNumber}
                onChange={(e) => setNewNumber(e.target.value)}
                placeholder="+14155550100"
                inputMode="tel"
                className="font-mono"
              />
            </div>
            {phoneAccounts.length > 0 && (
              <div className="flex min-w-48 flex-1 flex-col gap-1.5 sm:max-w-xs">
                <Label htmlFor="phone-account" className="text-xs">
                  Phone account
                </Label>
                <Select value={account} onValueChange={setAccount}>
                  <SelectTrigger id="phone-account" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ORG_DEFAULT}>Organization default</SelectItem>
                    {phoneAccounts.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <Button type="submit" size="sm" variant="outline" disabled={busy !== undefined || newNumber.trim() === ""}>
              {busy === "add" ? "Adding" : "Add number"}
            </Button>
          </form>
        )}
      </div>

      {canEdit && mine.length > 0 && (
        <form onSubmit={place} className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-48 flex-1 flex-col gap-1.5 sm:max-w-xs">
            <Label htmlFor="call-to" className="text-xs">
              Have this employee call
            </Label>
            <Input id="call-to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="+14155550123" inputMode="tel" className="font-mono" />
          </div>
          <Button type="submit" size="sm" disabled={!live || busy !== undefined || to.trim() === ""}>
            {busy === "call" ? "Calling" : "Call"}
          </Button>
        </form>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Recent calls</h3>
          <Button size="sm" variant="ghost" onClick={calls.reload}>
            Refresh
          </Button>
        </div>
        {calls.error ? (
          <p className="text-sm text-destructive">{calls.error.message}</p>
        ) : !calls.data ? (
          <Skeleton className="h-10 w-full" />
        ) : calls.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No calls yet.</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {calls.data.map((c) => {
              const Icon = c.direction === "INBOUND" ? PhoneIncoming : PhoneOutgoing;
              const expanded = open?.id === c.id;
              return (
                <Collapsible key={c.id} asChild open={expanded} onOpenChange={() => show(c)}>
                  <li className="py-2">
                    <CollapsibleTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-auto w-full flex-wrap justify-start gap-x-3 gap-y-1 px-0 text-left font-normal aria-expanded:bg-transparent"
                      >
                        <Icon className="size-4 text-muted-foreground" aria-label={c.direction === "INBOUND" ? "Incoming" : "Outgoing"} />
                        <span className="font-mono tabular-nums">{c.direction === "INBOUND" ? c.from : c.to}</span>
                        <Badge variant="outline">{c.status.replace("_", " ").toLowerCase()}</Badge>
                        <span className="text-muted-foreground tabular-nums">{seconds(c.durationSec)}</span>
                        <span className="ml-auto text-xs text-muted-foreground">{when(c.createdAt)}</span>
                      </Button>
                    </CollapsibleTrigger>
                    {c.error && <p className="mt-1 text-xs text-destructive">{c.error}</p>}
                    <CollapsibleContent>
                      {expanded && (
                        <ol className="mt-2 flex flex-col gap-1.5 border-l pl-3 text-sm">
                          {open.transcript.length === 0 && <li className="text-muted-foreground">Nothing was said.</li>}
                          {open.transcript.map((t, i) => (
                            <li key={i}>
                              <span className="text-xs text-muted-foreground tabular-nums">{seconds(Math.round(t.offsetMs / 1000))} </span>
                              <span className="font-medium">{t.speaker === "CUSTOMER" ? "Caller" : "Employee"}: </span>
                              {t.text}
                              {t.interrupted && <span className="text-xs text-muted-foreground"> (interrupted)</span>}
                            </li>
                          ))}
                        </ol>
                      )}
                    </CollapsibleContent>
                  </li>
                </Collapsible>
              );
            })}
          </ul>
        )}
      </div>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
