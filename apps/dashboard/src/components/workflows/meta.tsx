import type { NodeType, WorkflowExecutionStatus } from "@workforce/shared";
import {
  Bot,
  CircleStop,
  Clock,
  Database,
  GitFork,
  Globe,
  Hand,
  Mail,
  Phone,
  Webhook,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export const NODE_ICONS: Record<NodeType, LucideIcon> = {
  trigger: Zap,
  ai_employee: Bot,
  condition: GitFork,
  tool: Wrench,
  http_request: Globe,
  webhook: Webhook,
  wait: Clock,
  voice_call: Phone,
  message: Mail,
  crm_update: Database,
  human_handoff: Hand,
  end: CircleStop,
};

const RUN_STATUS: Record<WorkflowExecutionStatus | "SUCCEEDED", { label: string; dot: string }> = {
  QUEUED: { label: "Queued", dot: "bg-muted-foreground/50" },
  RUNNING: { label: "Running", dot: "bg-sky-500" },
  WAITING: { label: "Waiting", dot: "bg-amber-500" },
  COMPLETED: { label: "Completed", dot: "bg-emerald-500" },
  SUCCEEDED: { label: "Succeeded", dot: "bg-emerald-500" },
  FAILED: { label: "Failed", dot: "bg-destructive" },
};

export function RunStatusBadge({ status }: { status: keyof typeof RUN_STATUS }) {
  const { label, dot } = RUN_STATUS[status];
  return (
    <Badge variant="outline" className="gap-1.5 font-normal">
      <span className={cn("size-1.5 rounded-full", dot)} aria-hidden />
      {label}
    </Badge>
  );
}

export const runDot = (status: keyof typeof RUN_STATUS) => RUN_STATUS[status].dot;

export const formatTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
