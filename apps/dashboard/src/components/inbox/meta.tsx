import { CONVERSATION_STATUS_LABELS, type ConversationStatus } from "@workforce/shared";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const DOTS: Record<ConversationStatus, string> = {
  AI_ACTIVE: "bg-sky-500",
  WAITING_FOR_HUMAN: "bg-amber-500",
  HUMAN_ACTIVE: "bg-emerald-500",
  RESOLVED: "bg-muted-foreground/40",
  REOPENED: "bg-violet-500",
};

/** The dot is decoration; the label carries the state. */
export function ConversationStatusBadge({ status }: { status: ConversationStatus }) {
  return (
    <Badge variant="outline" className="gap-1.5 font-normal">
      <span className={cn("size-1.5 rounded-full", DOTS[status])} aria-hidden />
      {CONVERSATION_STATUS_LABELS[status]}
    </Badge>
  );
}

export const CHANNEL_LABELS: Record<string, string> = {
  test: "Test chat",
  web_chat: "Web chat",
  whatsapp: "WhatsApp",
  email: "Email",
  voice: "Phone call",
  workflow: "Workflow",
  evaluation: "Regression test",
};

/** "45 s", "12 min", "3 h 5 min", "2 d 4 h". */
export function formatDuration(ms: number | null) {
  if (ms === null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/** "3 min ago", from an ISO date. */
export const timeAgo = (iso: string, now = Date.now()) => {
  const ms = now - new Date(iso).getTime();
  return ms < 45_000 ? "just now" : `${formatDuration(ms)} ago`;
};
