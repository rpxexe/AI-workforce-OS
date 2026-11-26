// AI quality control: evaluators (versioned grader definitions), evaluations of conversations and their
// results, the quality overview, and regression datasets. Evaluation only observes: nothing here changes
// how employees answer.
import { z } from "zod";

/** Conversations replayed by regression runs carry this channel; inbox, analytics and auto evaluation skip them. */
export const EVALUATION_CHANNEL = "evaluation";

export const EVAL_DIMENSIONS = ["correctness", "grounding", "policy", "tone", "resolution", "tool_use", "escalation", "satisfaction"] as const;
export type EvalDimension = (typeof EVAL_DIMENSIONS)[number];

export const EVAL_DIMENSION_LABELS: Record<EvalDimension, string> = {
  correctness: "Correctness",
  grounding: "Knowledge grounding",
  policy: "Policy compliance",
  tone: "Tone",
  resolution: "Resolution",
  tool_use: "Tool correctness",
  escalation: "Escalation quality",
  satisfaction: "Customer satisfaction",
};

/** deterministic: computed from stored data; llm: a model grades with a rubric; rule: phrase rules on messages. */
export const EVALUATOR_KINDS = ["deterministic", "llm", "rule"] as const;
export type EvaluatorKind = (typeof EVALUATOR_KINDS)[number];

export const EVALUATOR_KIND_LABELS: Record<EvaluatorKind, string> = {
  deterministic: "Deterministic check",
  llm: "LLM grader",
  rule: "Policy rules",
};

export const DETERMINISTIC_CHECKS = ["tool_success", "escalation_handling", "reply_latency"] as const;
export type DeterministicCheck = (typeof DETERMINISTIC_CHECKS)[number];

export const DETERMINISTIC_CHECK_LABELS: Record<DeterministicCheck, string> = {
  tool_success: "Tool calls succeed (share of calls that succeeded)",
  escalation_handling: "Requests for a person are handed off and picked up in time",
  reply_latency: "Replies arrive within the time limit",
};

const phrase = z.string().trim().min(1).max(100);

export const policyRuleSchema = z.object({
  label: z.string().trim().min(1, "Name the rule").max(100),
  /** forbid: no message may contain a phrase; require: at least one message must. */
  match: z.enum(["forbid", "require"]),
  /** Matched as whole words, ignoring case. */
  phrases: z.array(phrase).min(1, "Add at least one phrase").max(50),
});
export type PolicyRule = z.infer<typeof policyRuleSchema>;

export const evaluatorConfigSchemas = {
  deterministic: z.object({
    check: z.enum(DETERMINISTIC_CHECKS),
    /** reply_latency: the longest acceptable reply time. */
    maxReplyMs: z.number().int().min(100).max(600_000).default(10_000),
    /** escalation_handling: how long a handed-off customer may wait for a person. */
    maxWaitMinutes: z.number().int().min(1).max(10_080).default(30),
  }),
  llm: z.object({
    rubric: z.string().trim().min(10, "Describe what a good conversation looks like").max(4000),
  }),
  rule: z.object({
    /** Whose messages the rules read: the employee's replies, or the customer's messages. */
    target: z.enum(["assistant", "customer"]),
    rules: z.array(policyRuleSchema).min(1, "Add at least one rule").max(20),
  }),
};
export type EvaluatorConfig<K extends EvaluatorKind = EvaluatorKind> = z.infer<(typeof evaluatorConfigSchemas)[K]>;

const common = {
  name: z.string().trim().min(1, "Name is required").max(100),
  description: z.string().trim().max(500).default(""),
  dimension: z.enum(EVAL_DIMENSIONS),
  /** A result passes at this score (0-100) or above. */
  passScore: z.number().int().min(0).max(100).default(70),
};

/** Body of creating an evaluator or saving a new version of it. */
export const evaluatorSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("deterministic"), config: evaluatorConfigSchemas.deterministic }),
  z.object({ ...common, kind: z.literal("llm"), config: evaluatorConfigSchemas.llm }),
  z.object({ ...common, kind: z.literal("rule"), config: evaluatorConfigSchemas.rule }),
]);
export type EvaluatorInput = z.input<typeof evaluatorSchema>;
export type EvaluatorDefinition = z.infer<typeof evaluatorSchema>;

export const evaluatorToggleSchema = z.object({ enabled: z.boolean() });

export type EvaluatorVersionInfo = EvaluatorDefinition & { id: string; number: number; createdBy: string; createdAt: string };

export type EvaluatorInfo = {
  id: string;
  /** Set on the built-in evaluators every workspace starts with. */
  key: string | null;
  enabled: boolean;
  current: EvaluatorVersionInfo;
  /** Results of the last 30 days (production conversations). */
  recent: { results: number; passed: number; averageScore: number | null };
};

export const EVALUATION_STATUSES = ["PENDING", "RUNNING", "COMPLETED", "FAILED"] as const;
export type EvaluationStatus = (typeof EVALUATION_STATUSES)[number];
/** auto: the sweep after a conversation went quiet; manual: someone asked; dataset: a regression run. */
export type EvaluationTrigger = "auto" | "manual" | "dataset";

export type EvaluationFinding = { message: string; quote?: string };

export type EvaluationResultRecord = {
  id: string;
  evaluatorId: string;
  evaluatorName: string;
  evaluatorVersion: number;
  dimension: EvalDimension;
  kind: EvaluatorKind;
  /** skipped: nothing to judge (no tool calls, no requests for a person, the grader saw no basis). */
  status: "scored" | "skipped" | "error";
  score: number | null;
  passed: boolean | null;
  reason: string;
  findings: EvaluationFinding[];
};

export type EvaluationRecord = {
  id: string;
  conversationId: string;
  conversationTitle: string;
  employee: { id: string; name: string };
  employeeVersion: number | null;
  provider: string | null;
  model: string | null;
  workflow: { id: string; name: string; version: number } | null;
  trigger: EvaluationTrigger;
  status: EvaluationStatus;
  /** Average of the scored results, 0-100. */
  score: number | null;
  passed: boolean | null;
  failures: number;
  messageCount: number;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  results: EvaluationResultRecord[];
};

export const evaluationsQuerySchema = z.object({
  failed: z.enum(["true", "false"]).optional(),
  employeeId: z.string().min(1).optional(),
  evaluatorId: z.string().min(1).optional(),
  dimension: z.enum(EVAL_DIMENSIONS).optional(),
  days: z.coerce.number().int().min(1).max(365).default(30),
});

export const qualityQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  employeeId: z.string().min(1).optional(),
});

type ScoreSummary = { evaluations: number; averageScore: number | null; passRate: number | null };

export type QualityOverview = ScoreSummary & {
  days: number;
  /** Graded conversations that passed, and those with a pass/fail verdict at all (passRate = passing / judged). */
  passing: number;
  judged: number;
  failures: number;
  byDimension: { dimension: EvalDimension; results: number; averageScore: number | null; passRate: number | null }[];
  trend: { day: string; evaluations: number; averageScore: number | null; passRate: number | null }[];
  byEmployee: (ScoreSummary & { employeeId: string; name: string; dimensions: Partial<Record<EvalDimension, number>> })[];
  byVersion: (ScoreSummary & { employeeId: string; name: string; version: number })[];
  topFailures: { evaluatorId: string; name: string; dimension: EvalDimension; failures: number }[];
};

// ---- Regression datasets ----

export const datasetSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  description: z.string().trim().max(500).default(""),
});

export const caseMessageSchema = z.object({
  role: z.enum(["customer", "employee"]),
  content: z.string().trim().min(1).max(4000),
});
export type CaseMessage = z.infer<typeof caseMessageSchema>;

/** A case copies a real conversation (`conversationId`) or is written by hand (`messages`). */
export const caseSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(100),
    /** What a good answer does; LLM graders read it. */
    expectations: z.string().trim().max(2000).default(""),
    conversationId: z.string().min(1).optional(),
    messages: z.array(caseMessageSchema).max(40).optional(),
  })
  .refine((c) => (c.conversationId === undefined) !== (c.messages === undefined), "Give either a conversation or messages")
  .refine((c) => c.messages === undefined || c.messages.some((m) => m.role === "customer"), {
    message: "Add at least one customer message",
    path: ["messages"],
  });

export const datasetRunSchema = z.object({
  employeeId: z.string().min(1),
  /** Defaults to the published version, else the latest. */
  version: z.number().int().positive().optional(),
});

export type EvalCaseInfo = {
  id: string;
  name: string;
  source: "conversation" | "synthetic";
  conversationId: string | null;
  messages: CaseMessage[];
  expectations: string;
  createdAt: string;
};

export type EvalRunInfo = {
  id: string;
  employee: { id: string; name: string };
  employeeVersion: number;
  status: EvaluationStatus;
  score: number | null;
  total: number;
  passed: number;
  failed: number;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type DatasetSummary = { id: string; name: string; description: string; cases: number; lastRun: EvalRunInfo | null; updatedAt: string };
export type DatasetDetail = DatasetSummary & { caseList: EvalCaseInfo[]; runs: EvalRunInfo[] };
export type EvalRunDetail = EvalRunInfo & { datasetId: string; evaluations: (EvaluationRecord & { caseId: string | null })[] };
