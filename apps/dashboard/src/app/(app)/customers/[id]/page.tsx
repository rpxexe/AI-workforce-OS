"use client";

import {
  updateMemorySchema,
  type CustomerDetail,
  type CustomerExport,
  type CustomerMemoryItem,
  type EmployeeSummary,
  type MemoryCategory,
} from "@workforce/shared";
import { ArrowLeft, Brain, Download, Eraser, MessagesSquare, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ConfirmDialog, type Confirmation } from "@/components/confirm-dialog";
import { formatDate } from "@/components/employees/meta";
import { CHANNEL_LABELS, ConversationStatusBadge, timeAgo } from "@/components/inbox/meta";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApi, useApiQuery } from "@/lib/api";
import { useIsAdmin, withWorkspace } from "@/lib/workspace";

const CATEGORY_LABELS: Record<MemoryCategory, string> = {
  identity: "Identity",
  preference: "Preference",
  fact: "Fact",
  lead: "Lead",
  follow_up: "Follow-up",
};

const messageOf = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong. Try again.");

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
      await api(`${base}/memories/${memory.id}`, { method: "PATCH", body: parsed.data });
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
            <label htmlFor={inputId} className="sr-only">
              Value of {memory.key}
            </label>
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
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Edit ${memory.key}`}
              title="Edit"
              disabled={draft !== null}
              onClick={() => setDraft(memory.value)}
            >
              <Pencil aria-hidden />
            </Button>
            <Button variant="ghost" size="icon" aria-label={`Delete ${memory.key}`} title="Delete" onClick={onDelete}>
              <Trash2 aria-hidden />
            </Button>
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
  const [actionError, setActionError] = useState<string>();
  const [exporting, setExporting] = useState(false);

  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data) return <LoadingState rows={6} />;

  const title = data.name ?? data.externalId;
  const employeeName = (employeeId: string) => employees?.find((e) => e.id === employeeId)?.name ?? "AI employee";

  const run = async (action: () => Promise<unknown>) => {
    setActionError(undefined);
    try {
      await action();
      reload();
    } catch (err) {
      setActionError(messageOf(err));
    }
  };

  const download = async () => {
    setExporting(true);
    setActionError(undefined);
    try {
      const file = await api<CustomerExport>(`${base}/export`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
      const link = Object.assign(document.createElement("a"), { href: url, download: `customer-${data.id}.json` });
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setActionError(messageOf(err));
    } finally {
      setExporting(false);
    }
  };

  const profile: [string, string | null][] = [
    ["Name", data.name],
    ["Email", data.email],
    ["Phone", data.phone],
    ["Company", data.company],
    ["Channel id", data.externalId],
    ["Last seen", timeAgo(data.lastSeenAt)],
  ];

  return (
    <div className="flex flex-col gap-6">
      <Link href="/customers" className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden />
        Customers
      </Link>

      <PageHeader title={title} description="What AI employees know about this customer and recall in every conversation, on any channel.">
        {isAdmin && (
          <>
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
                  onConfirm: () => run(() => api(`${base}/memories`, { method: "DELETE" })),
                })
              }
            >
              <Eraser aria-hidden />
              Clear memory
            </Button>
          </>
        )}
      </PageHeader>

      {actionError && <ErrorState message={actionError} />}

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>Kept in step with the identity facts below.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {profile.map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="truncate">{value ?? "—"}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <section className="flex flex-col gap-3" aria-labelledby="memories-heading">
        <h2 id="memories-heading" className="font-medium">
          Memories
        </h2>
        {data.memories.length === 0 ? (
          <EmptyState icon={Brain} title="Nothing remembered" description="Facts the customer states in conversations, like their budget or preferred contact time, appear here." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
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
              {data.memories.map((m) => (
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
                      onConfirm: () => run(() => api(`${base}/memories/${m.id}`, { method: "DELETE" })),
                    })
                  }
                />
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="conversations-heading">
        <h2 id="conversations-heading" className="font-medium">
          Conversations
        </h2>
        {data.conversations.length === 0 ? (
          <EmptyState icon={MessagesSquare} title="No conversations" description="This customer's conversations on every channel appear here." />
        ) : (
          <ul className="flex flex-col gap-3">
            {data.conversations.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/conversations/${c.id}`}
                  className="flex flex-col gap-1.5 rounded-xl border bg-card p-4 hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <span className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge variant="secondary" className="font-normal">
                      {CHANNEL_LABELS[c.channel] ?? c.channel}
                    </Badge>
                    <span className="min-w-0 truncate font-medium">{c.title}</span>
                    <ConversationStatusBadge status={c.status} />
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {c.summary || "No summary yet."}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {employeeName(c.employeeId)} · {formatDate(c.updatedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
});
