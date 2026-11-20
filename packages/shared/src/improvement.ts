// Controlled continuous improvement: failure pattern -> suggested change -> proposed employee version ->
// regression tests -> human approval -> percentage rollout (A/B) -> promote or roll back, with the chosen KPI
// tracked for both versions. Nothing here changes what customers get until a person acts.
import { z } from "zod";
import type { EmployeeConfig } from "./employee.ts";
import { EVAL_DIMENSION_LABELS, EVAL_DIMENSIONS, type EvalDimension, type EvalRunInfo, type EvaluationFinding } from "./evaluation.ts";

/** What a change should move: the average quality score, the share of conversations passing, or one dimension's pass rate. */
export const KPIS = ["score", "pass_rate", ...EVAL_DIMENSIONS] as const;
export type Kpi = (typeof KPIS)[number];

export const KPI_LABELS: Record<Kpi, string> = {
  score: "Average quality score",
  pass_rate: "Conversations passing",
  ...(Object.fromEntries(EVAL_DIMENSIONS.map((d) => [d, `${EVAL_DIMENSION_LABELS[d]} pass rate`])) as Record<EvalDimension, string>),
};

/** The only fields an improvement may change: what the employee is told, never its channels, tools or escalation. */
export const IMPROVABLE_FIELDS = ["systemInstructions", "personality", "goals"] as const;
export type ProposedChange = {
  summary: string;
  /** The complete new value of each changed field. */
  fields: Partial<Pick<EmployeeConfig, (typeof IMPROVABLE_FIELDS)[number]>>;
};

export type SuggestionEvidence = {
  /** Failed results of the evaluator on the version, and all its judged results, in the analysed period. */
  failures: number;
  results: number;
  days: number;
  examples: { evaluationId: string; conversationId: string; conversationTitle: string; score: number | null; reason: string; findings: EvaluationFinding[] }[];
};

/**
 * Where a suggestion is: proposed (no version yet), testing (regression runs going), tested (waiting for a
 * person), approved or rejected, rolling_out (a share of customers), released (published) or rolled_back.
 */
export const SUGGESTION_STAGES = ["proposed", "testing", "tested", "approved", "rejected", "rolling_out", "released", "rolled_back"] as const;
export type SuggestionStage = (typeof SUGGESTION_STAGES)[number];
export type Approval = "pending" | "approved" | "rejected";

export type ImprovementSummary = {
  id: string;
  employee: { id: string; name: string };
  baseVersion: number;
  proposedVersion: number | null;
  dimension: EvalDimension;
  title: string;
  kpi: Kpi;
  stage: SuggestionStage;
  approval: Approval;
  failures: number;
  createdAt: string;
};

export type CaseChange = "fixed" | "regressed" | "same";
export type TestComparison = {
  /** The regression suite both runs replayed. */
  datasetId: string | null;
  baseline: EvalRunInfo | null;
  candidate: EvalRunInfo | null;
  /** Per case: passed on each version (null: not graded yet, or failed to run). */
  cases: { caseId: string; name: string; baseline: boolean | null; candidate: boolean | null; change: CaseChange }[];
  fixes: number;
  regressions: number;
  /** Both runs finished. */
  complete: boolean;
};

export type KpiSide = { version: number; samples: number; value: number | null };
/** improved / worse: the difference is larger than chance would explain (95%); not_enough_data: under 10 samples on a side. */
export type KpiVerdict = "improved" | "worse" | "no_difference" | "not_enough_data";
export type KpiComparison = { kpi: Kpi; control: KpiSide; candidate: KpiSide; difference: number | null; verdict: KpiVerdict };

export type RolloutStatus = "active" | "promoted" | "rolled_back";
export type RolloutInfo = {
  id: string;
  employeeId: string;
  controlVersion: number;
  candidateVersion: number;
  percent: number;
  status: RolloutStatus;
  kpi: Kpi;
  suggestionId: string | null;
  startedBy: string;
  startedAt: string;
  endedBy: string | null;
  endedAt: string | null;
  result: KpiComparison;
};

export type ImprovementDetail = ImprovementSummary & {
  evaluatorId: string;
  evaluatorName: string;
  reason: string;
  evidence: SuggestionEvidence;
  change: ProposedChange;
  /** The base version's configuration, and the same with the change applied. */
  base: EmployeeConfig;
  proposed: EmployeeConfig;
  tests: TestComparison | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string;
  rollout: RolloutInfo | null;
  createdBy: string;
};

export type ReleaseAction = "publish" | "rollback" | "promote";
export type ReleaseInfo = { id: string; action: ReleaseAction; version: number; previousVersion: number | null; by: string; createdAt: string };

export type EmployeeReleases = {
  active: RolloutInfo | null;
  /** Newest first, the active one included. */
  rollouts: RolloutInfo[];
  releases: ReleaseInfo[];
  regressionSuite: { id: string; cases: number } | null;
  /** The version "Roll back" would publish (the one live before the current), or null. */
  rollbackTo: number | null;
};

// ---- Request bodies ----

export const improvementsQuerySchema = z.object({ employeeId: z.string().min(1).optional() });

export const decisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(1000).default(""),
});

export const startRolloutSchema = z.object({
  version: z.number().int().positive(),
  /** Share of customers served the new version. */
  percent: z.number().int().min(1).max(100),
  kpi: z.enum(KPIS),
});

export const rolloutActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set_percent"), percent: z.number().int().min(1).max(100) }),
  /** Publishes the candidate for everyone and ends the rollout. */
  z.object({ action: z.literal("promote") }),
  /** Ends the rollout: everyone is back on the published version. */
  z.object({ action: z.literal("rollback") }),
]);
