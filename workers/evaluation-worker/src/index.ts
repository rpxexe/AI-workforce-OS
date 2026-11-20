// The evaluation worker: Conversation -> Evaluation (links to employee version, model, workflow version)
// -> graders -> results -> failures. It runs as background jobs (apps/api/src/jobs.ts), never inside a
// customer's turn, and it only writes evaluation tables: nothing here changes how employees answer.
import { configOf, runTurn } from "@workforce/agent-runtime";
import type { AIProvider, EmbeddingProvider } from "@workforce/ai-provider";
import { Prisma, prisma } from "@workforce/database";
import {
  EVALUATION_CHANNEL,
  evaluatorConfigSchemas,
  type CaseMessage,
  type EvalDimension,
  type EvaluationTrigger,
  type EvaluatorKind,
  type MessageSource,
  type MessageTool,
} from "@workforce/shared";
import { deterministic, llm, rules, type GradedMessage, type GradeInput, type Outcome } from "./graders.ts";

export { DEFAULT_EVALUATORS, ensureDefaultEvaluators } from "./defaults.ts";
export { deterministic, GRADER_PROMPT, parseGrade, rules, transcript, type GradeInput } from "./graders.ts";
export {
  analyzeWorkspace,
  compareKpi,
  findFailurePatterns,
  IMPROVE_PROMPT,
  KPI_MIN_SAMPLES,
  parseProposal,
  workspacesWithFailures,
  type ImproveDeps,
} from "./improve.ts";

export type EvaluationDeps = {
  provider: () => AIProvider;
  embedder: () => EmbeddingProvider;
  timeoutMs: number;
};

type Scope = { organizationId: string; workspaceId: string };

/** Messages graded per conversation (the newest). */
const MAX_MESSAGES = 200;
/** Knowledge passages shown to LLM graders, and their length. */
const MAX_EXCERPTS = 12;
const EXCERPT_CHARS = 600;

/** The workflow version that started a conversation: an AI Employee step's output, or a Voice Call step's call. */
async function workflowVersionOf(conversationId: string, organizationId: string) {
  const rows = await prisma.$queryRaw<{ versionId: string }[]>`
    SELECT e."versionId" FROM "WorkflowStepExecution" s JOIN "WorkflowExecution" e ON e.id = s."executionId"
    WHERE e."organizationId" = ${organizationId} AND s."nodeType" = 'ai_employee' AND s.output->>'conversationId' = ${conversationId}
    UNION ALL
    SELECT e."versionId" FROM "Call" c JOIN "WorkflowExecution" e ON e.id = split_part(c."idempotencyKey", ':', 1)
    WHERE c."organizationId" = ${organizationId} AND c."conversationId" = ${conversationId} AND c."idempotencyKey" IS NOT NULL
    LIMIT 1`;
  return rows[0]?.versionId ?? null;
}

/**
 * Records a PENDING evaluation of the conversation as it is now, linked to the employee version and model
 * of its last reply and to the workflow version that started it. Returns null when there is nothing to
 * grade, or (auto) when this state was already queued.
 */
export async function createEvaluation(input: {
  scope: Scope;
  conversationId: string;
  trigger: EvaluationTrigger;
  requestedBy: string;
  datasetRunId?: string;
  caseId?: string;
}) {
  const { scope, conversationId, trigger } = input;
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, ...scope }, select: { id: true, employeeId: true } });
  if (!conversation) return null;
  const [last, reply, messageCount, workflowVersionId] = await Promise.all([
    prisma.conversationMessage.findFirst({ where: { conversationId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    prisma.conversationMessage.findFirst({
      where: { conversationId, role: "ASSISTANT", employeeVersion: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { employeeVersion: true, provider: true, model: true },
    }),
    prisma.conversationMessage.count({ where: { conversationId } }),
    workflowVersionOf(conversationId, scope.organizationId),
  ]);
  if (!last) return null;
  const version =
    reply?.employeeVersion != null
      ? await prisma.aiEmployeeVersion.findUnique({
          where: { employeeId_number: { employeeId: conversation.employeeId, number: reply.employeeVersion } },
          select: { id: true },
        })
      : null;
  // The handoff line is saved without a model; the last reply that had one names it.
  const modelled =
    reply && !reply.model
      ? await prisma.conversationMessage.findFirst({
          where: { conversationId, role: "ASSISTANT", model: { not: null } },
          orderBy: { createdAt: "desc" },
          select: { provider: true, model: true },
        })
      : reply;
  try {
    return await prisma.evaluation.create({
      data: {
        ...scope,
        conversationId,
        employeeId: conversation.employeeId,
        employeeVersionId: version?.id ?? null,
        provider: modelled?.provider ?? null,
        model: modelled?.model ?? null,
        workflowVersionId,
        trigger,
        autoKey: trigger === "auto" ? `${conversationId}:${last.createdAt.toISOString()}` : null,
        datasetRunId: input.datasetRunId,
        caseId: input.caseId,
        messageCount,
        lastMessageAt: last.createdAt,
        requestedBy: input.requestedBy,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return null;
    throw err;
  }
}

/**
 * Conversations that went quiet `idleMs` ago (within the last 3 days) and have changed since their last
 * evaluation, in workspaces that have an enabled evaluator (or none set up yet: they get the defaults).
 * Each gets a PENDING evaluation; the ids are returned for queueing.
 */
export async function queueDueEvaluations({ idleMs, limit = 50, organizationId }: { idleMs: number; limit?: number; organizationId?: string }): Promise<string[]> {
  const quietSince = new Date(Date.now() - idleMs);
  // `organizationId` keeps tests to their own data: they share the database with development.
  const rows = await prisma.$queryRaw<{ id: string; organizationId: string; workspaceId: string }[]>`
    SELECT c.id, c."organizationId", c."workspaceId" FROM "Conversation" c
    WHERE c.channel <> ${EVALUATION_CHANNEL} AND (${organizationId ?? null}::text IS NULL OR c."organizationId" = ${organizationId ?? null})
      AND c."updatedAt" <= ${quietSince} AND c."updatedAt" > now() - interval '3 days'
      AND EXISTS (SELECT 1 FROM "ConversationMessage" m WHERE m."conversationId" = c.id AND m.role = 'ASSISTANT')
      AND NOT EXISTS (
        SELECT 1 FROM "Evaluation" e WHERE e."conversationId" = c.id
          AND e."lastMessageAt" >= (SELECT max(m."createdAt") FROM "ConversationMessage" m WHERE m."conversationId" = c.id))
      AND (EXISTS (SELECT 1 FROM "Evaluator" v WHERE v."workspaceId" = c."workspaceId" AND v.enabled)
           OR NOT EXISTS (SELECT 1 FROM "Evaluator" v WHERE v."workspaceId" = c."workspaceId"))
    ORDER BY c."updatedAt" ASC
    LIMIT ${limit}`;
  const ids: string[] = [];
  for (const row of rows) {
    const evaluation = await createEvaluation({
      scope: { organizationId: row.organizationId, workspaceId: row.workspaceId },
      conversationId: row.id,
      trigger: "auto",
      requestedBy: "system",
    });
    if (evaluation) ids.push(evaluation.id);
  }
  return ids;
}

async function excerptsOf(scope: Scope, messages: GradedMessage[]) {
  const pages = [...new Map(messages.flatMap((m) => m.sources).map((s) => [`${s.documentId}:${s.page}`, s])).values()].slice(0, MAX_EXCERPTS);
  if (pages.length === 0) return [];
  // shortcut: re-reads the cited pages' current chunks, not the exact passages retrieved; store passages on replies if graders need them verbatim
  const chunks = await prisma.knowledgeChunk.findMany({
    where: { ...scope, OR: pages.map((p) => ({ documentId: p.documentId, page: p.page })) },
    orderBy: { index: "asc" },
    select: { documentId: true, page: true, content: true },
  });
  return pages.flatMap((p) => {
    const chunk = chunks.find((c) => c.documentId === p.documentId && c.page === p.page);
    return chunk ? [{ documentName: p.documentName, page: p.page, content: chunk.content.slice(0, EXCERPT_CHARS) }] : [];
  });
}

async function grade(kind: EvaluatorKind, dimension: EvalDimension, config: unknown, input: GradeInput): Promise<Outcome> {
  try {
    if (kind === "deterministic") return deterministic(evaluatorConfigSchemas.deterministic.parse(config), input);
    if (kind === "rule") return rules(evaluatorConfigSchemas.rule.parse(config), input);
    return await llm(evaluatorConfigSchemas.llm.parse(config), dimension, input);
  } catch (err) {
    // One grader failing (a provider error, a timeout) does not lose the others' results.
    const message = err instanceof Error ? err.message : String(err);
    return { status: "error", score: null, reason: `The grader failed: ${message.slice(0, 300)}`, findings: [] };
  }
}

/**
 * Grades a PENDING evaluation with the workspace's enabled evaluators. Claims it first, so a duplicate or
 * retried job does nothing. Returns false when it was not PENDING.
 */
export async function runEvaluation(evaluationId: string, deps: EvaluationDeps): Promise<boolean> {
  const { count } = await prisma.evaluation.updateMany({ where: { id: evaluationId, status: "PENDING" }, data: { status: "RUNNING" } });
  if (count === 0) return false;
  try {
    const evaluation = await prisma.evaluation.findUniqueOrThrow({ where: { id: evaluationId }, include: { employeeVersion: true } });
    const scope = { organizationId: evaluation.organizationId, workspaceId: evaluation.workspaceId };
    const { conversationId, lastMessageAt } = evaluation;
    const [rows, handoffs, toolExecutions, evaluators, testCase] = await Promise.all([
      prisma.conversationMessage.findMany({
        where: { conversationId, createdAt: { lte: lastMessageAt } },
        orderBy: { createdAt: "desc" },
        take: MAX_MESSAGES,
      }),
      prisma.handoff.findMany({ where: { conversationId, requestedAt: { lte: lastMessageAt } }, orderBy: { requestedAt: "asc" } }),
      prisma.toolExecution.findMany({ where: { ...scope, conversationId, createdAt: { lte: lastMessageAt } }, select: { tool: true, status: true, error: true } }),
      prisma.evaluator.findMany({ where: { ...scope, enabled: true, currentVersionId: { not: null } }, include: { currentVersion: true } }),
      evaluation.caseId ? prisma.evalCase.findUnique({ where: { id: evaluation.caseId }, select: { expectations: true } }) : null,
    ]);
    const messages: GradedMessage[] = rows.reverse().map((m) => ({
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
      latencyMs: m.latencyMs,
      // Written only by runTurn, in these shapes.
      sources: (m.sources as MessageSource[] | null) ?? [],
      tools: (m.tools as MessageTool[] | null) ?? [],
    }));
    let provider: AIProvider | undefined;
    const input: GradeInput = {
      messages,
      handoffs,
      toolExecutions,
      employee: evaluation.employeeVersion ? configOf(evaluation.employeeVersion) : null,
      excerpts: await excerptsOf(scope, messages),
      expectations: testCase?.expectations ?? "",
      now: new Date(),
      provider: () => (provider ??= deps.provider()),
      timeoutMs: deps.timeoutMs,
    };

    const graded = await Promise.all(
      evaluators.map(async (e) => {
        const v = e.currentVersion;
        if (!v) throw new Error("Evaluator without a version");
        const outcome = await grade(v.kind as EvaluatorKind, v.dimension as EvalDimension, v.config, input);
        const passed = outcome.status === "scored" && outcome.score !== null ? outcome.score >= v.passScore : null;
        return { e, v, outcome, passed };
      }),
    );
    const scores = graded.map((g) => g.outcome.score).filter((s): s is number => s !== null);
    const failures = graded.filter((g) => g.passed === false).length;
    const judged = graded.some((g) => g.passed !== null);
    await prisma.$transaction([
      prisma.evaluationResult.createMany({
        data: graded.map(({ e, v, outcome, passed }) => ({
          evaluationId,
          evaluatorId: e.id,
          evaluatorVersionId: v.id,
          dimension: v.dimension,
          kind: v.kind,
          status: outcome.status,
          score: outcome.score,
          passed,
          reason: outcome.reason,
          details: { findings: outcome.findings, ...(outcome.usage && { usage: outcome.usage }) },
        })),
      }),
      prisma.evaluation.update({
        where: { id: evaluationId },
        data: {
          status: "COMPLETED",
          score: scores.length > 0 ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null,
          passed: judged ? failures === 0 : null,
          failures,
          completedAt: new Date(),
        },
      }),
    ]);
    return true;
  } catch (err) {
    await prisma.evaluation.update({
      where: { id: evaluationId },
      data: { status: "FAILED", error: (err instanceof Error ? err.message : String(err)).slice(0, 500), completedAt: new Date() },
    });
    throw err;
  }
}

// ---- Regression runs ----

/**
 * Replays one case against the run's employee version: its customer messages go through `runTurn` one by
 * one in a new conversation on the evaluation channel, then the result is graded. Tools are not offered
 * (a replay must not book meetings or send email), there is no customer memory, and handoffs notify no one.
 * Safe to call again: a case already evaluated in this run is skipped.
 */
export async function runCase(runId: string, caseId: string, deps: EvaluationDeps) {
  const run = await prisma.evalRun.findUniqueOrThrow({
    where: { id: runId },
    include: { employeeVersion: { include: { employee: { include: { knowledgeSources: true } } } } },
  });
  if (await prisma.evaluation.findFirst({ where: { datasetRunId: runId, caseId }, select: { id: true } })) return;
  const testCase = await prisma.evalCase.findUniqueOrThrow({ where: { id: caseId } });
  const scope = { organizationId: run.organizationId, workspaceId: run.workspaceId };
  const version = run.employeeVersion;
  const employee = version.employee;
  await prisma.evalRun.updateMany({ where: { id: runId, status: "PENDING" }, data: { status: "RUNNING" } });

  // Created up front so a replay that fails on its first turn still has a conversation to report on.
  const conversation = await prisma.conversation.create({
    data: { ...scope, employeeId: employee.id, channel: EVALUATION_CHANNEL, title: `Test: ${testCase.name}`.slice(0, 80), createdBy: "evaluation" },
  });
  let failure: string | null = null;
  try {
    const provider = deps.provider();
    const sourceIds = employee.knowledgeSources.map((k) => k.sourceId);
    const knowledge = sourceIds.length > 0 ? { embedder: deps.embedder(), sourceIds } : undefined;
    for (const message of (testCase.messages as CaseMessage[]).filter((m) => m.role === "customer")) {
      for await (const event of runTurn({
        provider,
        ...scope,
        employeeId: employee.id,
        userId: "evaluation",
        employee: configOf(version),
        employeeVersion: version.number,
        conversationId: conversation.id,
        knowledge,
        channel: EVALUATION_CHANNEL,
        userMessage: message.content,
        timeoutMs: deps.timeoutMs,
      }))
        if (event.type === "error") throw new Error(event.message);
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }

  const evaluation = failure
    ? null
    : await createEvaluation({ scope, conversationId: conversation.id, trigger: "dataset", requestedBy: run.startedBy, datasetRunId: runId, caseId });
  if (evaluation) {
    await runEvaluation(evaluation.id, deps).catch(() => {}); // recorded as FAILED on the row
    return;
  }
  // The replay failed (or produced nothing): the case counts as failed, with why.
  await prisma.evaluation.create({
    data: {
      ...scope,
      conversationId: conversation.id,
      employeeId: employee.id,
      employeeVersionId: version.id,
      trigger: "dataset",
      datasetRunId: runId,
      caseId,
      status: "FAILED",
      error: `The replay failed: ${failure ?? "no messages"}`.slice(0, 500),
      messageCount: 0,
      lastMessageAt: new Date(),
      requestedBy: run.startedBy,
      completedAt: new Date(),
    },
  });
}

/** Totals a run from its cases' evaluations. */
export async function finishRun(runId: string) {
  const evaluations = await prisma.evaluation.findMany({ where: { datasetRunId: runId }, select: { status: true, passed: true, score: true } });
  const scores = evaluations.map((e) => e.score).filter((s): s is number => s !== null);
  await prisma.evalRun.update({
    where: { id: runId },
    data: {
      status: "COMPLETED",
      passed: evaluations.filter((e) => e.passed === true).length,
      failed: evaluations.filter((e) => e.status === "FAILED" || e.passed === false).length,
      score: scores.length > 0 ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null,
      completedAt: new Date(),
    },
  });
}
