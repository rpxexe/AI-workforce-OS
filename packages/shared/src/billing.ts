// Phase 16: plans and their limits, the usage ledger, billing and tenant analytics.
import { z } from "zod";
import type { DurationStats } from "./inbox.ts";
import type { ToolExecutionStatus } from "./tool.ts";
import type { WorkflowExecutionStatus } from "./workflow.ts";

export const PLAN_IDS = ["free", "starter", "growth", "scale"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export const LIMIT_KEYS = ["employees", "conversations", "messages", "voiceMinutes", "storageMb", "aiUsageUsd", "toolCalls"] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];
export type PlanLimits = Record<LimitKey, number>;

export const LIMIT_LABELS: Record<LimitKey, string> = {
  employees: "AI employees",
  conversations: "Conversations per period",
  messages: "AI messages per period",
  voiceMinutes: "Voice minutes per period",
  storageMb: "Knowledge storage (MB)",
  aiUsageUsd: "AI and provider usage per period (USD)",
  toolCalls: "Tool calls per period",
};

/**
 * The plans. `monthlyUsd` is shown in the dashboard and must match the Stripe Price named by STRIPE_PRICE_<PLAN>.
 * Usage is charged on top, up to the `aiUsageUsd` cap.
 */
// shortcut: plan names, prices and limits are placeholders in code; move them to the database when sales needs custom plans
export const PLANS: Record<PlanId, { name: string; monthlyUsd: number; limits: PlanLimits }> = {
  free: { name: "Free", monthlyUsd: 0, limits: { employees: 1, conversations: 100, messages: 500, voiceMinutes: 30, storageMb: 50, aiUsageUsd: 5, toolCalls: 200 } },
  starter: {
    name: "Starter",
    monthlyUsd: 49,
    limits: { employees: 3, conversations: 1_000, messages: 5_000, voiceMinutes: 300, storageMb: 500, aiUsageUsd: 50, toolCalls: 2_000 },
  },
  growth: {
    name: "Growth",
    monthlyUsd: 199,
    limits: { employees: 10, conversations: 10_000, messages: 50_000, voiceMinutes: 2_000, storageMb: 5_000, aiUsageUsd: 300, toolCalls: 20_000 },
  },
  scale: {
    name: "Scale",
    monthlyUsd: 799,
    limits: { employees: 50, conversations: 100_000, messages: 500_000, voiceMinutes: 10_000, storageMb: 50_000, aiUsageUsd: 2_000, toolCalls: 200_000 },
  },
};

/**
 * Checks whether an organization may use more of some limits; `adding` is what is about to be used (default 1;
 * storageMb in MB). Returns a message safe to show when a limit is reached, else null.
 */
export type UsageLimiter = (organizationId: string, keys: LimitKey[], adding?: Partial<Record<LimitKey, number>>) => Promise<string | null>;

/** Ledger entry kinds. `provider` rows carry money (provider cost and the amount billed); the others count usage. */
export const USAGE_KINDS = ["conversation", "message", "voice_minutes", "tool_call", "workflow_run", "provider"] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];
export const USAGE_KIND_LABELS: Record<UsageKind, string> = {
  conversation: "Conversations",
  message: "AI messages",
  voice_minutes: "Voice minutes",
  tool_call: "Tool calls",
  workflow_run: "Workflow runs",
  provider: "Provider usage",
};

export const checkoutSchema = z.object({ plan: z.enum(PLAN_IDS) });

const day = z.coerce.date();
/** A reporting range: `to` is exclusive; at most 366 days. */
export const rangeQuerySchema = z
  .object({ from: day, to: day, workspaceId: z.string().min(1).optional() })
  .refine((r) => r.to > r.from, { path: ["to"], message: "The end must be after the start" })
  .refine((r) => r.to.getTime() - r.from.getTime() <= 366 * 86_400_000, { path: ["to"], message: "At most 366 days" });

// ---- API responses (dates are ISO strings) ----

export type LimitUsage = { key: LimitKey; label: string; used: number; limit: number };

export type InvoiceRecord = {
  id: string;
  number: string | null;
  status: string;
  amountDue: number;
  amountPaid: number;
  currency: string;
  hostedInvoiceUrl: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  createdAt: string;
};

export type BillingOverview = {
  /** Stripe is configured on the server (plans can be bought); limits are enforced only when billing is on. */
  stripe: boolean;
  enforced: boolean;
  plan: PlanId;
  status: string;
  period: { start: string; end: string };
  cancelAtPeriodEnd: boolean;
  hasSubscription: boolean;
  limits: LimitUsage[];
  usage: UsageSummary;
  invoices: InvoiceRecord[];
  plans: { id: PlanId; name: string; monthlyUsd: number; limits: PlanLimits }[];
};

export type UsageSummary = {
  from: string;
  to: string;
  byKind: { kind: UsageKind; quantity: number; events: number }[];
  /** What is billed for usage. Provider cost and the markup are never sent to tenants (company policy). */
  amountUsd: number;
  /** Amount billed per UTC day of the range, oldest first, up to today. */
  daily: { date: string; amountUsd: number }[];
  /** Newest ledger entries, each pointing at the row it came from. */
  recent: { id: string; kind: UsageKind; quantity: number; amountUsd: number | null; sourceType: string; sourceId: string; workspaceId: string | null; occurredAt: string; detail: unknown }[];
};

export type AnalyticsReport = {
  from: string;
  to: string;
  workspaceId: string | null;
  conversations: { total: number; byChannel: { channel: string; count: number }[] };
  calls: { total: number; completed: number; minutes: number };
  messages: { customer: number; ai: number; agent: number };
  tokens: { input: number; output: number };
  toolExecutions: { total: number; byStatus: { status: ToolExecutionStatus; count: number }[] };
  workflowExecutions: { total: number; byStatus: { status: WorkflowExecutionStatus; count: number }[] };
  resolutions: number;
  escalations: number;
  humanHandoffs: number;
  latency: { aiReply: DurationStats; provider: DurationStats };
  /** Usage billed in the range (the ledger's amounts); provider cost is never shown to tenants. */
  cost: { billedUsd: number };
  quality: { evaluations: number; averageScore: number | null; passRate: number | null };
  daily: { date: string; conversations: number; messages: number; billedUsd: number }[];
};
