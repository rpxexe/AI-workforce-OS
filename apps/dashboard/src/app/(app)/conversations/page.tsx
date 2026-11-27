"use client";

import { HANDOFF_TRIGGER_LABELS, type InboxCounts, type InboxPage, type InboxView } from "@workforce/shared";
import { Inbox } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CHANNEL_LABELS, ConversationStatusBadge, timeAgo } from "@/components/inbox/meta";
import { Skeleton as Skullet } from "skullet/react";
import { EmptyState, ErrorState, PageHeader } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { TablePager, useCursorPaged } from "@/components/table-pager";
import { Card } from "@/components/ui/card";
import { Tabs, TabsCount, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApiQuery } from "@/lib/api";
import { useMembers } from "@/lib/members";
import { withWorkspace } from "@/lib/workspace";

const VIEWS: { view: InboxView; label: string; empty: string }[] = [
  { view: "queue", label: "Queue", empty: "No one is waiting for a person." },
  { view: "mine", label: "Mine", empty: "Nothing is assigned to you." },
  { view: "waiting", label: "Waiting", empty: "No conversation is waiting for a person." },
  { view: "human_active", label: "Human active", empty: "No one is answering a conversation right now." },
  { view: "ai_active", label: "AI active", empty: "No conversation is with the AI." },
  { view: "reopened", label: "Reopened", empty: "No reopened conversations." },
  { view: "resolved", label: "Resolved", empty: "No resolved conversations." },
  { view: "all", label: "All", empty: "No conversations yet." },
];

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE: InboxPage = {
  data: Array.from({ length: 5 }, (_, i) => ({
    id: `sample-${i}`,
    title: "Conversation with a customer",
    channel: "web",
    status: "WAITING_FOR_HUMAN",
    assignedTo: null,
    employee: { id: "sample-employee", name: "Support assistant" },
    customer: { id: `sample-customer-${i}`, externalId: "customer@example.com", name: "Priya Sharma" },
    lastMessage: { role: "USER", content: "Hi, my order has not arrived yet and the tracking page has not changed in three days.", createdAt: "2026-01-01T00:00:00.000Z" },
    handoff: { trigger: "customer_request", reason: "The customer asked for a person", requestedAt: "2026-01-01T00:00:00.000Z" },
    updatedAt: "2026-01-01T00:00:00.000Z",
  })),
  nextCursor: null,
};

/** How often the inbox looks for new handoffs. */
const REFRESH_MS = 5000;

export default withWorkspace(function InboxPage({ workspace }) {
  const [view, setView] = useState<InboxView>("queue");
  const base = `/workspaces/${workspace.id}/inbox`;
  // Cursor pages from the server in the view's own order; another view starts again at page 1.
  const paged = useCursorPaged(view);
  const { data, error, loading, reload } = useApiQuery<InboxPage>(`${base}?view=${view}&${paged.query}`, { keepPrevious: true });
  // Every view's count in one request, not per page or view, so the tabs keep their pills while a view loads.
  const counts = useApiQuery<InboxCounts>(`${base}/counts`);
  const reloadCounts = counts.reload;
  const { nameOf } = useMembers();
  // While a page loads, `data` is still the previous one: its cursor must not open yet another page.
  const pager = paged.pager({
    nextCursor: loading ? null : (data?.nextCursor ?? null),
    rows: loading ? 1 : (data?.data.length ?? 1),
    total: counts.data?.[view],
  });

  // Refreshes the page shown: page 1 picks up new activity, a later page keeps its place after its cursor.
  useEffect(() => {
    const timer = setInterval(() => {
      reload();
      reloadCounts();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload, reloadCounts]);

  const current = VIEWS.find((v) => v.view === view)!;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Conversations"
        description="Conversations your AI employees handed to people, and every other one. Take one over to answer the customer yourself."
      />

      <Tabs value={view} onValueChange={(v) => setView(v as InboxView)}>
        <TabsList aria-label="Inbox views">
          {VIEWS.map((v) => (
            <TabsTrigger key={v.view} value={v.view}>
              {v.label}
              {!!counts.data?.[v.view] && <TabsCount>{counts.data[v.view]}</TabsCount>}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {error && !data ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : (
        <Skullet data={data} sample={SAMPLE} id="conversations-list" label="Loading conversations">
          {(data) => data.data.length === 0 ? (
        <EmptyState icon={Inbox} title={current.empty} description="This list refreshes by itself every few seconds." />
      ) : (
        <Card className="gap-0 py-0">
          <ul className="flex flex-col divide-y">
            {data.data.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/conversations/${c.id}`}
                  className="flex flex-col gap-1.5 px-4 py-3 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="min-w-0 flex-1 truncate font-medium">{c.customer?.name ?? c.customer?.externalId ?? c.title}</span>
                    <ConversationStatusBadge status={c.status} />
                    <span className="text-xs text-muted-foreground tabular-nums">{timeAgo(c.updatedAt)}</span>
                  </div>
                  {c.lastMessage && (
                    <p className="truncate text-sm text-muted-foreground">
                      {c.lastMessage.role === "USER" ? "" : c.lastMessage.role === "AGENT" ? "Agent: " : `${c.employee.name}: `}
                      {c.lastMessage.content}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="secondary" className="font-normal">
                      {CHANNEL_LABELS[c.channel] ?? c.channel}
                    </Badge>
                    <span>{c.employee.name}</span>
                    {c.handoff && (
                      <span>
                        · {HANDOFF_TRIGGER_LABELS[c.handoff.trigger]}, handed off {timeAgo(c.handoff.requestedAt)}
                      </span>
                    )}
                    {(c.status === "WAITING_FOR_HUMAN" || c.status === "HUMAN_ACTIVE") && <span>· {nameOf(c.assignedTo)}</span>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          <TablePager {...pager} className="px-4 pb-3" />
        </Card>
          )}
        </Skullet>
      )}
    </div>
  );
});
