"use client";

import {
  MEMORY_CATEGORIES,
  updateMemorySchema,
  type CustomerDetail,
  type CustomerExport,
  type CustomerMemoryItem,
  type EmployeeSummary,
  type MemoryCategory,
} from "@workforce/shared";
import {
  ArrowLeft,
  Brain,
  Building2,
  Clock,
  Download,
  Eraser,
  ListTodo,
  Mail,
  MessagesSquare,
  Pencil,
  Phone,
  Radio,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { ConfirmDialog, type Confirmation } from "@/components/confirm-dialog";
import { formatDate } from "@/components/employees/meta";
import { CustomerAvatar, RelativeTime } from "@/components/customers/meta";
import { CHANNEL_LABELS, ConversationStatusBadge } from "@/components/inbox/meta";
import { EmptyState, ErrorState, StatTile } from "@/components/states";
import { Skeleton as Skullet } from "skullet/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Item } from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useApi, useApiQuery } from "@/lib/api";
import { useIsAdmin, withWorkspace } from "@/lib/workspace";

const CATEGORY_LABELS: Record<MemoryCategory, string> = {
  identity: "Identity",
  preference: "Preference",
  fact: "Fact",
  lead: "Lead",
  follow_up: "Follow-up",
};

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE: CustomerDetail = {
  id: "sample",
  externalId: "customer@example.com",
  name: "Sample customer",
  email: "customer@example.com",
  phone: "+919876543210",
  company: "Sample Traders Pvt Ltd",
  lastSeenAt: "2026-01-01T00:00:00.000Z",
  memories: (
    [
      ["identity", "full_name", "Sample customer"],
      ["preference", "contact_time", "Weekday evenings after 6 pm"],
      ["fact", "city", "Bengaluru"],
      ["lead", "budget", "50000"],
    ] satisfies [MemoryCategory, string, string][]
  ).map(([category, key, value], i) => ({
    id: `sample-${i}`,
    category,
    key,
    value,
    confidence: 0.9,
    conversationId: "sample",
    updatedAt: "2026-01-01T00:00:00.000Z",
  })),
  conversations: Array.from({ length: 3 }, (_, i) => ({
    id: `sample-${i}`,
    employeeId: "sample-employee",
    channel: "web",
    status: "RESOLVED",
    title: "Question about an order",
    summary: "The customer asked when their order would arrive and was given the courier's delivery date.",
    updatedAt: "2026-01-01T00:00:00.000Z",
  })),
};

const messageOf =(err: unknown) => (err instanceof Error ? err.message : "Something went wrong. Try again.");

/** One remembered fact; admins edit the value in place. */
function MemoryRow({ memory, base, isAdmin, onSaved, onDelete }: {
  memory: CustomerMemoryItem;
  base: string;
  isAdmin: boolean;
  onSaved: () => void;
  onDelete: () => void;
}) {
  const api = useApi();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const inputId = `memory-${memory.id}`;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = updateMemorySchema.safeParse({ value: draft });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message);
    setSaving(true);
    setError(undefined);
    try {
      await api(`${base}/memories/${memory.id}`, { method: "PATCH", body: parsed.data, toast: `${memory.key} updated` });
      setDraft(null);
      onSaved();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <TableRow>
      <TableCell>
        <Badge variant="outline" className="font-normal">
          {CATEGORY_LABELS[memory.category] ?? memory.category}
        </Badge>
      </TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">{memory.key}</TableCell>
      <TableCell className="max-w-72 whitespace-normal">
        {draft === null ? (
          <span className="break-words">{memory.value}</span>
        ) : (
          <form onSubmit={save} className="flex flex-col gap-1.5">
            <Label htmlFor={inputId} className="sr-only">
              Value of {memory.key}
            </Label>
            <Input
              id={inputId}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={200}
              autoFocus
              aria-invalid={error !== undefined}
              aria-describedby={error ? `${inputId}-error` : undefined}
              onKeyDown={(e) => e.key === "Escape" && setDraft(null)}
            />
            {error && (
              <p id={`${inputId}-error`} role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
            <span className="flex gap-1.5">
              <Button type="submit" size="sm" disabled={saving}>
                {saving ? "Saving" : "Save"}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => (setDraft(null), setError(undefined))}>
                Cancel
              </Button>
            </span>
          </form>
        )}
      </TableCell>
      <TableCell className="hidden text-muted-foreground tabular-nums sm:table-cell">
        {memory.confidence === null ? "—" : `${Math.round(memory.confidence * 100)}%`}
      </TableCell>
      <TableCell className="hidden md:table-cell">
        {memory.conversationId ? (
          <Link href={`/conversations/${memory.conversationId}`} className="text-sm hover:underline">
            Conversation
          </Link>
        ) : (
          <span className="text-sm text-muted-foreground">Workflow or person</span>
        )}
      </TableCell>
      <TableCell className="hidden whitespace-nowrap text-muted-foreground lg:table-cell">{formatDate(memory.updatedAt)}</TableCell>
      {isAdmin && (
        <TableCell>
          <span className="flex justify-end gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Edit ${memory.key}`}
                  disabled={draft !== null}
                  onClick={() => setDraft(memory.value)}
                >
                  <Pencil aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Edit</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={`Delete ${memory.key}`} onClick={onDelete}>
                  <Trash2 aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Delete</TooltipContent>
            </Tooltip>
          </span>
        </TableCell>
      )}
    </TableRow>
  );
}

export default withWorkspace(function CustomerPage({ workspace }) {
  const { id } = useParams<{ id: string }>();
  const isAdmin = useIsAdmin();
  const api = useApi();
  const base = `/workspaces/${workspace.id}/customers/${id}`;
  const { data, error, reload } = useApiQuery<CustomerDetail>(base);
  const { data: employees } = useApiQuery<EmployeeSummary[]>(`/workspaces/${workspace.id}/employees`);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [exporting, setExporting] = useState(false);
  const [category, setCategory] = useState<MemoryCategory | "all">("all");

  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  const view = (data: CustomerDetail) => {
    const title = data.name ?? data.externalId;
    const employeeName = (employeeId: string) => employees?.find((e) => e.id === employeeId)?.name ?? "AI employee";

    const run = async (action: () => Promise<unknown>) => {
      try {
        await action();
        reload();
      } catch {
        // The toast in useApi shows why it failed.
      }
    };

    const download = async () => {
      setExporting(true);
      try {
        const file = await api<CustomerExport>(`${base}/export`);
        const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
        const link = Object.assign(document.createElement("a"), { href: url, download: `customer-${data.id}.json` });
        link.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        // A GET, so useApi does not toast it.
        toast.error(messageOf(err));
      } finally {
        setExporting(false);
      }
    };

    const profile: [string, ReactNode][] = [
      ["Name", data.name],
      ["Email", data.email],
      ["Phone", data.phone],
      ["Company", data.company],
      ["Channel id", data.externalId],
      ["Last seen", <RelativeTime key="seen" iso={data.lastSeenAt} />],
    ];
    const facts: [LucideIcon, string, string | null][] = [
      [Mail, "Email", data.email],
      [Phone, "Phone", data.phone],
      [Building2, "Company", data.company],
    ];
    const channels = [...new Set(data.conversations.map((c) => c.channel))];
    const unresolved = data.conversations.filter((c) => c.status !== "RESOLVED").length;
    const categories = MEMORY_CATEGORIES.filter((k) => data.memories.some((m) => m.category === k));
    // A filter left on a type the customer no longer has (after a delete) falls back to all.
    const active = category !== "all" && categories.includes(category) ? category : "all";
    const shown = active === "all" ? data.memories : data.memories.filter((m) => m.category === active);

    return (
      <div className="flex flex-col gap-6">
        <Link href="/customers" className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden />
          Customers
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <CustomerAvatar customer={data} size="lg" />
            <div className="flex min-w-0 flex-col gap-1.5">
              <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
              <div className="flex flex-wrap items-center gap-1.5">
                {facts.map(
                  ([Icon, label, value]) =>
                    value && (
                      <Badge key={label} variant="outline" className="max-w-64 gap-1.5 font-normal">
                        <Icon aria-hidden />
                        <span className="sr-only">{label}:</span>
                        <span className="truncate">{value}</span>
                      </Badge>
                    ),
                )}
                <Badge variant="secondary" className="gap-1.5 font-normal">
                  <Clock aria-hidden />
                  <span>
                    Seen <RelativeTime iso={data.lastSeenAt} />
                  </span>
                </Badge>
              </div>
            </div>
          </div>
          {isAdmin && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={download} disabled={exporting}>
                <Download aria-hidden />
                {exporting ? "Exporting" : "Export JSON"}
              </Button>
              <Button
                variant="outline"
                disabled={data.memories.length === 0 && data.conversations.every((c) => !c.summary)}
                onClick={() =>
                  setConfirm({
                    title: `Clear memory for ${title}?`,
                    description:
                      "Every remembered fact, the profile built from them and all conversation summaries are deleted. AI employees will no longer recall them. Conversations and their messages stay. This cannot be undone.",
                    confirmLabel: "Clear memory",
                    onConfirm: () => run(() => api(`${base}/memories`, { method: "DELETE", toast: "Memory cleared" })),
                  })
                }
              >
                <Eraser aria-hidden />
                Clear memory
              </Button>
            </div>
          )}
        </div>

        <section aria-label="Customer summary" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile label="Memories" icon={Brain} value={data.memories.length} hint="Facts AI employees recall" />
          <StatTile label="Conversations" icon={MessagesSquare} value={data.conversations.length} hint={`${unresolved} not resolved`} />
          <StatTile
            label="Channels"
            icon={Radio}
            value={channels.length}
            hint={channels.map((c) => CHANNEL_LABELS[c] ?? c).join(", ") || "None yet"}
          />
          <StatTile
            label="Follow-ups"
            icon={ListTodo}
            value={data.memories.filter((m) => m.category === "follow_up").length}
            hint="Things to get back to them on"
          />
        </section>

        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
            <CardDescription>What AI employees recall about this customer on any channel. Kept in step with the identity facts below.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
              {profile.map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="truncate font-medium">{value ?? "—"}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>

        <Card className="gap-4" aria-labelledby="memories-heading">
          <CardHeader className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-col gap-1.5">
              <CardTitle id="memories-heading">Memories</CardTitle>
              <CardDescription>Facts the customer stated, recalled in later conversations.</CardDescription>
            </div>
            {categories.length > 1 && (
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={active}
                onValueChange={(v) => v && setCategory(v as MemoryCategory | "all")}
                aria-label="Filter memories by type"
                className="flex-wrap"
              >
                <ToggleGroupItem value="all" className="px-3">
                  All
                </ToggleGroupItem>
                {categories.map((k) => (
                  <ToggleGroupItem key={k} value={k} className="px-3">
                    {CATEGORY_LABELS[k]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            )}
          </CardHeader>
          <CardContent className={shown.length === 0 ? undefined : "px-0"}>
            {shown.length === 0 ? (
              <EmptyState
                icon={Brain}
                title="Nothing remembered"
                description="Facts the customer states in conversations, like their budget or preferred contact time, appear here."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">Type</TableHead>
                    <TableHead>Key</TableHead>
                    <TableHead>Value</TableHead>
                    <TableHead className="hidden sm:table-cell">Confidence</TableHead>
                    <TableHead className="hidden md:table-cell">Source</TableHead>
                    <TableHead className="hidden lg:table-cell">Updated</TableHead>
                    {isAdmin && (
                      <TableHead className="w-24">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((m) => (
                    <MemoryRow
                      key={m.id}
                      memory={m}
                      base={base}
                      isAdmin={isAdmin}
                      onSaved={reload}
                      onDelete={() =>
                        setConfirm({
                          title: `Delete ${m.key}?`,
                          description: `AI employees will no longer recall “${m.value}”. They may learn it again if the customer says it.`,
                          confirmLabel: "Delete",
                          onConfirm: () => run(() => api(`${base}/memories/${m.id}`, { method: "DELETE", toast: `${m.key} deleted` })),
                        })
                      }
                    />
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card className="gap-4" aria-labelledby="conversations-heading">
          <CardHeader>
            <CardTitle id="conversations-heading">Conversations</CardTitle>
            <CardDescription>Every channel. Summaries are what AI employees recall next time.</CardDescription>
          </CardHeader>
          <CardContent>
            {data.conversations.length === 0 ? (
              <EmptyState icon={MessagesSquare} title="No conversations" description="This customer's conversations on every channel appear here." />
            ) : (
              <ul className="flex flex-col gap-2">
                {data.conversations.map((c) => (
                  <li key={c.id}>
                    <Item variant="outline" asChild className="group flex-col items-stretch gap-1.5 p-4 hover:bg-accent/50">
                      <Link href={`/conversations/${c.id}`}>
                        <span className="flex flex-wrap items-center gap-2 text-sm">
                          <Badge variant="secondary" className="font-normal">
                            {CHANNEL_LABELS[c.channel] ?? c.channel}
                          </Badge>
                          <span className="min-w-0 flex-1 truncate font-medium group-hover:underline">{c.title}</span>
                          <ConversationStatusBadge status={c.status} />
                        </span>
                        <span className="line-clamp-2 text-sm text-muted-foreground">{c.summary || "No summary yet."}</span>
                        <span className="text-xs text-muted-foreground">
                          {employeeName(c.employeeId)} · {formatDate(c.updatedAt)}
                        </span>
                      </Link>
                    </Item>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      </div>
    );
  };

  return (
    <Skullet data={data} sample={SAMPLE} id="customer-detail" label="Loading customer">
      {view}
    </Skullet>
  );
});
