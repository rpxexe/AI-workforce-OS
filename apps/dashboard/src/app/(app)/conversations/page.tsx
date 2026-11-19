"use client";

import { HANDOFF_TRIGGER_LABELS, type InboxResponse, type InboxView } from "@workforce/shared";
import { Inbox } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CHANNEL_LABELS, ConversationStatusBadge, timeAgo } from "@/components/inbox/meta";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { useApiQuery } from "@/lib/api";
import { useMembers } from "@/lib/members";
import { cn } from "@/lib/utils";
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

/** How often the inbox looks for new handoffs. */
const REFRESH_MS = 5000;

export default withWorkspace(function InboxPage({ workspace }) {
  const [view, setView] = useState<InboxView>("queue");
  const { data, error, reload } = useApiQuery<InboxResponse>(`/workspaces/${workspace.id}/inbox?view=${view}`);
  const { nameOf } = useMembers();

  useEffect(() => {
    const timer = setInterval(reload, REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);

  const current = VIEWS.find((v) => v.view === view)!;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Conversations"
        description="Conversations your AI employees handed to people, and every other one. Take one over to answer the customer yourself."
      />

      <nav aria-label="Inbox views" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
        {VIEWS.map((v) => (
          <button
            key={v.view}
            type="button"
            onClick={() => setView(v.view)}
            aria-pressed={view === v.view}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
              view === v.view && "bg-muted font-medium text-foreground",
            )}
          >
            {v.label}
            {data && <span className="text-xs tabular-nums text-muted-foreground">{data.counts[v.view]}</span>}
          </button>
        ))}
      </nav>

      {error && !data ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : !data ? (
        <LoadingState rows={5} />
      ) : data.items.length === 0 ? (
        <EmptyState icon={Inbox} title={current.empty} description="This list refreshes by itself every few seconds." />
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {data.items.map((c) => (
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
      )}
    </div>
  );
});
