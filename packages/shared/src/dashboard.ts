import { z } from "zod";
import type { LimitUsage } from "./billing.ts";
import type { EmployeeStatus, EmployeeSummary } from "./employee.ts";

/** Periods the dashboard offers, in days; the first is the default. */
export const DASHBOARD_PERIODS = [7, 30, 90] as const;
export const DASHBOARD_DAYS = DASHBOARD_PERIODS[0];
export const dashboardQuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .refine((d) => (DASHBOARD_PERIODS as readonly number[]).includes(d), "Pick 7, 30 or 90 days")
    .default(DASHBOARD_DAYS),
});

/** When the dashboard's "Needs attention" list flags something; set per workspace by admins. */
export const attentionSchema = z.object({
  /** Flag a handoff rate this many percentage points above the period before. */
  handoffRateRise: z.coerce.number().int().min(1).max(100),
  /** Flag a quality score below this (0-100) as urgent. */
  qualityScoreBelow: z.coerce.number().int().min(0).max(100),
  /** Flag a plan limit once this share of it (percent) is used. */
  limitUsedPercent: z.coerce.number().int().min(50).max(100),
});
export type Attention = z.infer<typeof attentionSchema>;
export const ATTENTION_DEFAULTS: Attention = { handoffRateRise: 5, qualityScoreBelow: 70, limitUsedPercent: 80 };

/**
 * Body of `GET /workspaces/:workspaceId/dashboard`: the dashboard's numbers in one request, counted in SQL rather than
 * taken from the full analytics, quality and billing reports (those pages chart the detail).
 */
export type DashboardSummary = {
  days: number;
  /** This workspace's "Needs attention" thresholds (the defaults when none are set). */
  attention: Attention;
  /** Conversations started in the period. */
  conversations: number;
  /** Handoffs requested in the period. */
  handoffs: number;
  /** Share of active conversations (a message in the period) handed to people at least once, 0..1. */
  handoffRate: number | null;
  /** The same rate over the period of equal length just before. */
  previousHandoffRate: number | null;
  /** Now, whatever the period. */
  open: { queue: number; assigned: number; humanActive: number };
  quality: { evaluations: number; averageScore: number | null; passRate: number | null; failures: number; topFailure: string | null };
  employees: {
    counts: Record<EmployeeStatus, number>;
    /** Employees that are not archived, most recently changed first (at most 200). */
    list: EmployeeSummary[];
  };
  billing: {
    planName: string;
    periodEnd: string;
    /** Usage billed this period for work in this workspace. */
    workspaceUsd: number;
    /** Usage billed this period across the organization, which the plan's limits apply to. */
    organizationUsd: number;
    /** The organization's plan limits; they are shared by every workspace. */
    limits: LimitUsage[];
  };
};
