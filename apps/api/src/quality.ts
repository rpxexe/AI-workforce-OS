// AI quality control (Phase 11): evaluators and their versions, evaluations of conversations, the quality
// overview, and regression datasets. Grading itself runs in background jobs (the evaluation worker); these
// routes only read results and queue work. Nothing here changes how employees answer.
import { Prisma, prisma } from "@workforce/database";
import { createEvaluation, ensureDefaultEvaluators } from "@workforce/evaluation-worker";
import {
  caseSchema,
  datasetRunSchema,
  datasetSchema,
  EVAL_DIMENSIONS,
  evaluationsQuerySchema,
  evaluatorSchema,
  evaluatorToggleSchema,
  qualityQuerySchema,
  type CaseMessage,
  type DatasetDetail,
  type DatasetSummary,
  type EvalCaseInfo,
  type EvalDimension,
  type EvalRunDetail,
  type EvalRunInfo,
  type EvaluationFinding,
  type EvaluationRecord,
  type EvaluationTrigger,
  type EvaluatorDefinition,
  type EvaluatorInfo,
  type EvaluatorKind,
  type EvaluatorVersionInfo,
  type QualityOverview,
} from "@workforce/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { guards, httpError, type Authenticate } from "./auth.ts";
import { within } from "./employees.ts";
import type { JobEvents } from "./jobs.ts";

const workspaceParams = z.object({ workspaceId: z.string().min(1) });
const idParams = workspaceParams.extend({ id: z.string().min(1) });
const caseParams = idParams.extend({ caseId: z.string().min(1) });
const conversationParams = workspaceParams.extend({ conversationId: z.string().min(1) });

type Scope = { organizationId: string; workspaceId: string };
type Queue = <K extends "evaluation/requested" | "evaluation/dataset.run">(name: K, data: JobEvents[K]) => Promise<void>;

/** Production evaluations: regression runs are reported on their own page, not in the overview. */
const PRODUCTION: Prisma.EvaluationWhereInput = { trigger: { in: ["auto", "manual"] } };

const evaluationInclude = {
  conversation: { select: { title: true } },
  employeeVersion: { select: { number: true } },
  workflowVersion: { select: { number: true, workflow: { select: { id: true, name: true } } } },
  results: { include: { evaluatorVersion: { select: { name: true, number: true } } }, orderBy: { createdAt: "asc" } },
} satisfies Prisma.EvaluationInclude;
type EvaluationRow = Prisma.EvaluationGetPayload<{ include: typeof evaluationInclude }>;

/** Employee display names: the published version's name, else the latest. */
async function employeeNames(scope: Scope, ids: string[]) {
  const rows = await prisma.aiEmployee.findMany({
    where: { ...scope, id: { in: [...new Set(ids)] } },
    select: { id: true, publishedVersion: { select: { name: true } }, versions: { orderBy: { number: "desc" }, take: 1, select: { name: true } } },
  });
  const names = new Map(rows.map((r) => [r.id, r.publishedVersion?.name ?? r.versions[0]?.name ?? "Employee"]));
  return (id: string) => names.get(id) ?? "Deleted employee";
}

const toRecord = (e: EvaluationRow, nameOf: (id: string) => string): EvaluationRecord => ({
  id: e.id,
  conversationId: e.conversationId,
  conversationTitle: e.conversation.title,
  employee: { id: e.employeeId, name: nameOf(e.employeeId) },
  employeeVersion: e.employeeVersion?.number ?? null,
  provider: e.provider,
  model: e.model,
  workflow: e.workflowVersion ? { id: e.workflowVersion.workflow.id, name: e.workflowVersion.workflow.name, version: e.workflowVersion.number } : null,
  trigger: e.trigger as EvaluationTrigger,
  status: e.status,
  score: e.score,
  passed: e.passed,
  failures: e.failures,
  messageCount: e.messageCount,
  error: e.error,
  createdAt: e.createdAt.toISOString(),
  completedAt: e.completedAt?.toISOString() ?? null,
  results: e.results.map((r) => ({
    id: r.id,
    evaluatorId: r.evaluatorId,
    evaluatorName: r.evaluatorVersion.name,
    evaluatorVersion: r.evaluatorVersion.number,
    dimension: r.dimension as EvalDimension,
    kind: r.kind as EvaluatorKind,
    status: r.status as "scored" | "skipped" | "error",
    score: r.score,
    passed: r.passed,
    reason: r.reason,
    // Written only by the evaluation worker, in this shape.
    findings: (r.details as { findings?: EvaluationFinding[] }).findings ?? [],
  })),
});

async function records(scope: Scope, rows: EvaluationRow[]) {
  const nameOf = await employeeNames(scope, rows.map((r) => r.employeeId));
  return rows.map((r) => toRecord(r, nameOf));
}

const toVersion = (v: Prisma.EvaluatorVersionGetPayload<object>): EvaluatorVersionInfo =>
  ({
    id: v.id,
    number: v.number,
    name: v.name,
    description: v.description,
    dimension: v.dimension,
    kind: v.kind,
    config: v.config,
    passScore: v.passScore,
    createdBy: v.createdBy,
    createdAt: v.createdAt.toISOString(),
  }) as EvaluatorVersionInfo;

const toRun = (r: Prisma.EvalRunGetPayload<{ include: { employeeVersion: { select: { number: true } } } }>, nameOf: (id: string) => string): EvalRunInfo => ({
  id: r.id,
  employee: { id: r.employeeId, name: nameOf(r.employeeId) },
  employeeVersion: r.employeeVersion.number,
  status: r.status,
  score: r.score,
  total: r.total,
  passed: r.passed,
  failed: r.failed,
  error: r.error,
  createdAt: r.createdAt.toISOString(),
  completedAt: r.completedAt?.toISOString() ?? null,
});

const toCase = (c: Prisma.EvalCaseGetPayload<object>): EvalCaseInfo => ({
  id: c.id,
  name: c.name,
  source: c.source as EvalCaseInfo["source"],
  conversationId: c.conversationId,
  messages: c.messages as CaseMessage[],
  expectations: c.expectations,
  createdAt: c.createdAt.toISOString(),
});

const mean = (values: number[]) => (values.length === 0 ? null : Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10);
const rate = (flags: (boolean | null)[]) => {
  const judged = flags.filter((f) => f !== null);
  return judged.length === 0 ? null : judged.filter(Boolean).length / judged.length;
};
const summary = (list: { score: number | null; passed: boolean | null }[]) => ({
  evaluations: list.length,
  averageScore: mean(list.map((e) => e.score).filter((s) => s !== null)),
  passRate: rate(list.map((e) => e.passed)),
});

const duplicate = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

export function qualityRoutes(app: FastifyInstance, authenticate: Authenticate, queue: Queue) {
  const { member, admin, inWorkspace } = guards(authenticate);
  const ws = "/workspaces/:workspaceId";

  const evaluatorOf = async (scope: Scope, id: string) => {
    const evaluator = await prisma.evaluator.findFirst({ where: { id, ...scope }, include: { currentVersion: true } });
    if (!evaluator?.currentVersion) throw httpError(404, "Evaluator not found");
    return { ...evaluator, currentVersion: evaluator.currentVersion };
  };

  // ---- Evaluators ----

  app.get(`${ws}/evaluators`, async (req): Promise<EvaluatorInfo[]> => {
    const { workspaceId } = workspaceParams.parse(req.params);
    const scope = within(await inWorkspace(member(req), workspaceId));
    await ensureDefaultEvaluators(scope);
    const evaluators = await prisma.evaluator.findMany({
      where: { ...scope, currentVersionId: { not: null } },
      include: { currentVersion: true },
      orderBy: { createdAt: "asc" },
    });
    const groups = await prisma.evaluationResult.groupBy({
      by: ["evaluatorId", "passed"],
      where: {
        evaluatorId: { in: evaluators.map((e) => e.id) },
        status: "scored",
        createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
        evaluation: PRODUCTION,
      },
      _count: true,
      _avg: { score: true },
    });
    return evaluators.map((e) => {
      const mine = groups.filter((g) => g.evaluatorId === e.id);
      const results = mine.reduce((n, g) => n + g._count, 0);
      const total = mine.reduce((n, g) => n + (g._avg.score ?? 0) * g._count, 0);
      return {
        id: e.id,
        key: e.key,
        enabled: e.enabled,
        current: toVersion(e.currentVersion as NonNullable<typeof e.currentVersion>),
        recent: { results, passed: mine.find((g) => g.passed === true)?._count ?? 0, averageScore: results > 0 ? Math.round((total / results) * 10) / 10 : null },
      };
    });
  });

  app.post(`${ws}/evaluators`, async (req, reply) => {
    const { workspaceId } = workspaceParams.parse(req.params);
    const auth = await inWorkspace(admin(req), workspaceId);
    const body: EvaluatorDefinition = evaluatorSchema.parse(req.body);
    const evaluator = await prisma.$transaction(async (tx) => {
      const created = await tx.evaluator.create({ data: { ...within(auth), createdBy: auth.userId } });
      const v1 = await tx.evaluatorVersion.create({ data: { evaluatorId: created.id, number: 1, ...body, createdBy: auth.userId } });
      return tx.evaluator.update({ where: { id: created.id }, data: { currentVersionId: v1.id } });
    });
    return reply.code(201).send({ id: evaluator.id });
  });

  app.get(`${ws}/evaluators/:id`, async (req) => {
    const { workspaceId, id } = idParams.parse(req.params);
    const scope = within(await inWorkspace(member(req), workspaceId));
    const evaluator = await evaluatorOf(scope, id);
    const [versions, evaluations] = await Promise.all([
      prisma.evaluatorVersion.findMany({ where: { evaluatorId: id }, orderBy: { number: "desc" } }),
      prisma.evaluation.findMany({
        where: { ...scope, results: { some: { evaluatorId: id } } },
        orderBy: { createdAt: "desc" },
        take: 50,
        include: { ...evaluationInclude, results: { ...evaluationInclude.results, where: { evaluatorId: id } } },
      }),
    ]);
    return {
      id: evaluator.id,
      key: evaluator.key,
      enabled: evaluator.enabled,
      current: toVersion(evaluator.currentVersion),
      versions: versions.map(toVersion),
      evaluations: await records(scope, evaluations),
    };
  });

  // Saving appends a version and makes it current; results keep the version that produced them.
  app.put(`${ws}/evaluators/:id`, async (req) => {
    const { workspaceId, id } = idParams.parse(req.params);
    const auth = await inWorkspace(admin(req), workspaceId);
    const evaluator = await evaluatorOf(within(auth), id);
    const body: EvaluatorDefinition = evaluatorSchema.parse(req.body);
    try {
      const version = await prisma.$transaction(async (tx) => {
        const last = await tx.evaluatorVersion.findFirstOrThrow({ where: { evaluatorId: id }, orderBy: { number: "desc" } });
        const v = await tx.evaluatorVersion.create({ data: { evaluatorId: evaluator.id, number: last.number + 1, ...body, createdBy: auth.userId } });
        await tx.evaluator.update({ where: { id }, data: { currentVersionId: v.id } });
        return v;
      });
      return toVersion(version);
    } catch (err) {
      if (duplicate(err)) throw httpError(409, "Someone else saved this evaluator. Reload and try again.");
      throw err;
    }
  });

  app.patch(`${ws}/evaluators/:id`, async (req) => {
    const { workspaceId, id } = idParams.parse(req.params);
    const scope = within(await inWorkspace(admin(req), workspaceId));
    await evaluatorOf(scope, id);
    const { enabled } = evaluatorToggleSchema.parse(req.body);
    await prisma.evaluator.update({ where: { id }, data: { enabled } });
    return { id, enabled };
  });

  // ---- Evaluations ----

  app.get(`${ws}/evaluations`, async (req): Promise<EvaluationRecord[]> => {
    const { workspaceId } = workspaceParams.parse(req.params);
    const scope = within(await inWorkspace(member(req), workspaceId));
    const q = evaluationsQuerySchema.parse(req.query);
    const failedOnly = q.failed === "true";
    const resultFilter: Prisma.EvaluationResultWhereInput = {
      ...(q.evaluatorId && { evaluatorId: q.evaluatorId }),
      ...(q.dimension && { dimension: q.dimension }),
      ...(failedOnly && { passed: false }),
    };
    const rows = await prisma.evaluation.findMany({
      where: {
        ...scope,
        ...PRODUCTION,
        createdAt: { gte: new Date(Date.now() - q.days * 86_400_000) },
        ...(q.employeeId && { employeeId: q.employeeId }),
        ...(failedOnly && { passed: false }),
        ...(Object.keys(resultFilter).length > 0 && { results: { some: resultFilter } }),
      },
      orderBy: { createdAt: "desc" },
      // shortcut: newest 100; add a cursor when people page through failures
      take: 100,
      include: evaluationInclude,
    });
    return records(scope, rows);
  });

  app.get(`${ws}/conversations/:conversationId/evaluations`, async (req): Promise<EvaluationRecord[]> => {
    const { workspaceId, conversationId } = conversationParams.parse(req.params);
    const scope = within(await inWorkspace(member(req), workspaceId));
    const rows = await prisma.evaluation.findMany({
      where: { ...scope, conversationId },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: evaluationInclude,
    });
    return records(scope, rows);
  });

  // Grades the conversation as it is now, in the background. Admins only: LLM graders spend money.
  app.post(`${ws}/conversations/:conversationId/evaluations`, async (req, reply) => {
    const { workspaceId, conversationId } = conversationParams.parse(req.params);
    const auth = await inWorkspace(admin(req), workspaceId);
    const scope = within(auth);
    if (!(await prisma.conversation.findFirst({ where: { id: conversationId, ...scope }, select: { id: true } }))) throw httpError(404, "Conversation not found");
    await ensureDefaultEvaluators(scope);
    const evaluation = await createEvaluation({ scope, conversationId, trigger: "manual", requestedBy: auth.userId });
    if (!evaluation) throw httpError(400, "This conversation has no messages to evaluate yet.");
    await queue("evaluation/requested", { evaluationId: evaluation.id });
    const row = await prisma.evaluation.findUniqueOrThrow({ where: { id: evaluation.id }, include: evaluationInclude });
    return reply.code(202).send((await records(scope, [row]))[0]);
  });

  app.get(`${ws}/quality`, async (req): Promise<QualityOverview> => {
    const { workspaceId } = workspaceParams.parse(req.params);
    const scope = within(await inWorkspace(member(req), workspaceId));
    const { days, employeeId } = qualityQuerySchema.parse(req.query);
    const since = new Date(Date.now() - days * 86_400_000);
    // shortcut: the newest 10,000 evaluations of the period, aggregated here; move to SQL when a workspace has more
    const rows = await prisma.evaluation.findMany({
      where: { ...scope, ...PRODUCTION, status: "COMPLETED", createdAt: { gte: since }, ...(employeeId && { employeeId }) },
      orderBy: { createdAt: "desc" },
      take: 10_000,
      select: {
        employeeId: true,
        score: true,
        passed: true,
        failures: true,
        createdAt: true,
        employeeVersion: { select: { number: true } },
        results: { where: { status: "scored" }, select: { evaluatorId: true, dimension: true, score: true, passed: true, evaluatorVersion: { select: { name: true } } } },
      },
    });
    const nameOf = await employeeNames(scope, rows.map((r) => r.employeeId));
    const results = rows.flatMap((r) => r.results);

    const trend: QualityOverview["trend"] = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      const list = rows.filter((r) => r.createdAt.toISOString().slice(0, 10) === day);
      const { averageScore, passRate } = summary(list);
      trend.push({ day, evaluations: list.length, averageScore, passRate });
    }

    const employees = [...new Set(rows.map((r) => r.employeeId))];
    const versions = [...new Map(rows.map((r) => [`${r.employeeId}:${r.employeeVersion?.number}`, r])).values()].filter((r) => r.employeeVersion);
    const failing = results.filter((r) => r.passed === false);
    return {
      days,
      ...summary(rows),
      failures: rows.reduce((n, r) => n + r.failures, 0),
      byDimension: EVAL_DIMENSIONS.map((dimension) => {
        const list = results.filter((r) => r.dimension === dimension);
        return { dimension, results: list.length, averageScore: mean(list.map((r) => r.score).filter((s) => s !== null)), passRate: rate(list.map((r) => r.passed)) };
      }).filter((d) => d.results > 0),
      trend,
      byEmployee: employees
        .map((id) => {
          const list = rows.filter((r) => r.employeeId === id);
          const mine = list.flatMap((r) => r.results);
          const dimensions: Partial<Record<EvalDimension, number>> = {};
          for (const d of EVAL_DIMENSIONS) {
            const avg = mean(mine.filter((r) => r.dimension === d).map((r) => r.score).filter((s) => s !== null));
            if (avg !== null) dimensions[d] = avg;
          }
          return { employeeId: id, name: nameOf(id), ...summary(list), dimensions };
        })
        .sort((a, b) => (b.averageScore ?? -1) - (a.averageScore ?? -1)),
      byVersion: versions
        .map((v) => {
          const version = v.employeeVersion?.number ?? 0;
          const list = rows.filter((r) => r.employeeId === v.employeeId && r.employeeVersion?.number === version);
          return { employeeId: v.employeeId, name: nameOf(v.employeeId), version, ...summary(list) };
        })
        .sort((a, b) => a.name.localeCompare(b.name) || b.version - a.version),
      topFailures: [...new Set(failing.map((r) => r.evaluatorId))]
        .map((evaluatorId) => {
          const list = failing.filter((r) => r.evaluatorId === evaluatorId);
          const first = list[0];
          return { evaluatorId, name: first?.evaluatorVersion.name ?? "", dimension: (first?.dimension ?? "correctness") as EvalDimension, failures: list.length };
        })
        .sort((a, b) => b.failures - a.failures)
        .slice(0, 10),
    };
  });

  // ---- Regression datasets ----

  const datasetOf = async (scope: Scope, id: string) => {
    const dataset = await prisma.evalDataset.findFirst({ where: { id, ...scope } });
    if (!dataset) throw httpError(404, "Dataset not found");
    return dataset;
  };
  const runInclude = { employeeVersion: { select: { number: true } } } as const;

  app.get(`${ws}/datasets`, async (req): Promise<DatasetSummary[]> => {
    const { workspaceId } = workspaceParams.parse(req.params);
    const scope = within(await inWorkspace(member(req), workspaceId));
    const datasets = await prisma.evalDataset.findMany({
      where: scope,
      orderBy: { updatedAt: "desc" },
      include: { _count: { select: { cases: true } }, runs: { orderBy: { createdAt: "desc" }, take: 1, include: runInclude } },
    });
    const nameOf = await employeeNames(scope, datasets.flatMap((d) => d.runs.map((r) => r.employeeId)));
    return datasets.map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      cases: d._count.cases,
      lastRun: d.runs[0] ? toRun(d.runs[0], nameOf) : null,
      updatedAt: d.updatedAt.toISOString(),
    }));
  });

  app.post(`${ws}/datasets`, async (req, reply) => {
    const { workspaceId } = workspaceParams.parse(req.params);
    const auth = await inWorkspace(admin(req), workspaceId);
    const body = datasetSchema.parse(req.body);
    try {
      const dataset = await prisma.evalDataset.create({ data: { ...within(auth), ...body, createdBy: auth.userId } });
      return reply.code(201).send({ id: dataset.id });
    } catch (err) {
      if (duplicate(err)) throw httpError(409, "A dataset with this name already exists");
      throw err;
    }
  });

  app.get(`${ws}/datasets/:id`, async (req): Promise<DatasetDetail> => {
    const { workspaceId, id } = idParams.parse(req.params);
    const scope = within(await inWorkspace(member(req), workspaceId));
    const dataset = await datasetOf(scope, id);
    const [cases, runs] = await Promise.all([
      prisma.evalCase.findMany({ where: { datasetId: id }, orderBy: { createdAt: "asc" } }),
      // shortcut: newest 50 runs
      prisma.evalRun.findMany({ where: { datasetId: id }, orderBy: { createdAt: "desc" }, take: 50, include: runInclude }),
    ]);
    const nameOf = await employeeNames(scope, runs.map((r) => r.employeeId));
    const runList = runs.map((r) => toRun(r, nameOf));
    return {
      id: dataset.id,
      name: dataset.name,
      description: dataset.description,
      cases: cases.length,
      lastRun: runList[0] ?? null,
      updatedAt: dataset.updatedAt.toISOString(),
      caseList: cases.map(toCase),
      runs: runList,
    };
  });

  app.delete(`${ws}/datasets/:id`, async (req, reply) => {
    const { workspaceId, id } = idParams.parse(req.params);
    const scope = within(await inWorkspace(admin(req), workspaceId));
    await datasetOf(scope, id);
    if (await prisma.evalRun.findFirst({ where: { datasetId: id, status: { in: ["PENDING", "RUNNING"] } }, select: { id: true } }))
      throw httpError(409, "A run of this dataset is in progress. Wait for it to finish.");
    await prisma.evalDataset.delete({ where: { id } });
    return reply.code(204).send();
  });

  app.post(`${ws}/datasets/:id/cases`, async (req, reply) => {
    const { workspaceId, id } = idParams.parse(req.params);
    const scope = within(await inWorkspace(admin(req), workspaceId));
    await datasetOf(scope, id);
    const body = caseSchema.parse(req.body);
    let messages = body.messages;
    if (body.conversationId) {
      // A copy: the case keeps its messages even if the conversation changes or goes.
      const conversation = await prisma.conversation.findFirst({
        where: { id: body.conversationId, ...scope },
        include: { messages: { orderBy: { createdAt: "desc" }, take: 40 } },
      });
      if (!conversation) throw httpError(404, "Conversation not found");
      messages = conversation.messages
        .reverse()
        .map((m): CaseMessage => ({ role: m.role === "USER" ? "customer" : "employee", content: m.content.slice(0, 4000) }));
      if (!messages.some((m) => m.role === "customer")) throw httpError(400, "The conversation has no customer messages to replay.");
    }
    const created = await prisma.evalCase.create({
      data: {
        datasetId: id,
        name: body.name,
        source: body.conversationId ? "conversation" : "synthetic",
        conversationId: body.conversationId ?? null,
        messages: messages ?? [],
        expectations: body.expectations,
      },
    });
    await prisma.evalDataset.update({ where: { id }, data: { updatedAt: new Date() } });
    return reply.code(201).send(toCase(created));
  });

  app.delete(`${ws}/datasets/:id/cases/:caseId`, async (req, reply) => {
    const { workspaceId, id, caseId } = caseParams.parse(req.params);
    const scope = within(await inWorkspace(admin(req), workspaceId));
    await datasetOf(scope, id);
    const { count } = await prisma.evalCase.deleteMany({ where: { id: caseId, datasetId: id } });
    if (count === 0) throw httpError(404, "Case not found");
    return reply.code(204).send();
  });

  // Replays every case against an employee version, in the background. Admins only: it spends money.
  app.post(`${ws}/datasets/:id/runs`, async (req, reply) => {
    const { workspaceId, id } = idParams.parse(req.params);
    const auth = await inWorkspace(admin(req), workspaceId);
    const scope = within(auth);
    await datasetOf(scope, id);
    const body = datasetRunSchema.parse(req.body);
    const employee = await prisma.aiEmployee.findFirst({
      where: { id: body.employeeId, ...scope },
      include: { versions: { orderBy: { number: "desc" }, ...(body.version ? { where: { number: body.version } } : { take: 1 }) } },
    });
    if (!employee) throw httpError(404, "Employee not found");
    const versionId = body.version ? employee.versions[0]?.id : (employee.publishedVersionId ?? employee.versions[0]?.id);
    if (!versionId) throw httpError(404, `Version ${body.version} not found`);
    const total = await prisma.evalCase.count({ where: { datasetId: id } });
    if (total === 0) throw httpError(400, "Add at least one case before running the dataset.");
    await ensureDefaultEvaluators(scope);
    const run = await prisma.evalRun.create({
      data: { ...scope, datasetId: id, employeeId: employee.id, employeeVersionId: versionId, total, startedBy: auth.userId },
      include: runInclude,
    });
    await queue("evaluation/dataset.run", { runId: run.id });
    return reply.code(202).send(toRun(run, await employeeNames(scope, [employee.id])));
  });

  app.get(`${ws}/eval-runs/:id`, async (req): Promise<EvalRunDetail> => {
    const { workspaceId, id } = idParams.parse(req.params);
    const scope = within(await inWorkspace(member(req), workspaceId));
    const run = await prisma.evalRun.findFirst({ where: { id, ...scope }, include: runInclude });
    if (!run) throw httpError(404, "Run not found");
    const evaluations = await prisma.evaluation.findMany({ where: { datasetRunId: id }, orderBy: { createdAt: "asc" }, include: evaluationInclude });
    const nameOf = await employeeNames(scope, [run.employeeId, ...evaluations.map((e) => e.employeeId)]);
    return {
      ...toRun(run, nameOf),
      datasetId: run.datasetId,
      evaluations: evaluations.map((e) => ({ ...toRecord(e, nameOf), caseId: e.caseId })),
    };
  });
}
