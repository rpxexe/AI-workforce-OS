// Controlled continuous improvement (Phase 12): suggestions from failure patterns, the proposed version and
// its regression tests, human approval, percentage rollouts with KPI tracking, promote and rollback. Every
// change to what customers get is a person's request to one of these routes; the analysis job only writes
// suggestions.
import { configOf } from "@workforce/agent-runtime";
import { Prisma, prisma } from "@workforce/database";
import { compareKpi, ensureDefaultEvaluators } from "@workforce/evaluation-worker";
import {
  decisionSchema,
  employeeConfigSchema,
  improvementsQuerySchema,
  rolloutActionSchema,
  startRolloutSchema,
  type CaseChange,
  type EmployeeReleases,
  type EvalDimension,
  type ImprovementDetail,
  type ImprovementSummary,
  type Kpi,
  type ProposedChange,
  type ReleaseAction,
  type RolloutInfo,
  type RolloutStatus,
  type SuggestionEvidence,
  type SuggestionStage,
  type TestComparison,
} from "@workforce/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { guards, httpError, type Authenticate } from "./auth.ts";
import { employeeParams, within } from "./employees.ts";
import type { JobEvents } from "./jobs.ts";
import { conversationCase, employeeNames, toRun } from "./quality.ts";
import { release, rollbackTarget } from "./releases.ts";

type Scope = { organizationId: string; workspaceId: string };
type Queue = <K extends "evaluation/dataset.run" | "improvement/analyze">(name: K, data: JobEvents[K]) => Promise<void>;

const workspaceParams = z.object({ workspaceId: z.string().min(1) });
const idParams = workspaceParams.extend({ id: z.string().min(1) });
const rolloutParams = employeeParams.extend({ rolloutId: z.string().min(1) });

const PRODUCTION = { trigger: { in: ["auto", "manual"] }, status: "COMPLETED" } satisfies Prisma.EvaluationWhereInput;
/** The control version's KPI also counts this long before the rollout started, so a small share still has a baseline. */
const BASELINE_DAYS = 14;
/** Passing production conversations added to a regression suite next to the failures, so a fix that breaks them shows. */
const GUARD_CASES = 5;
const isDone = (status: string | undefined) => status === "COMPLETED" || status === "FAILED";

const runInclude = { employeeVersion: { select: { number: true } } } as const;
const suggestionInclude = {
  employee: { select: { publishedVersionId: true } },
  baseVersion: true,
  proposedVersion: { select: { number: true } },
  baselineRun: { include: runInclude },
  candidateRun: { include: runInclude },
  rollouts: { orderBy: { startedAt: "desc" }, take: 1, include: { controlVersion: { select: { number: true } }, candidateVersion: { select: { number: true } } } },
} satisfies Prisma.ImprovementSuggestionInclude;
type SuggestionRow = Prisma.ImprovementSuggestionGetPayload<{ include: typeof suggestionInclude }>;
const rolloutInclude = { controlVersion: { select: { number: true } }, candidateVersion: { select: { number: true } } } as const;
type RolloutRow = Prisma.EmployeeRolloutGetPayload<{ include: typeof rolloutInclude }>;

function stageOf(s: SuggestionRow): SuggestionStage {
  if (s.approval === "rejected") return "rejected";
  const rollout = s.rollouts[0];
  if (rollout) return rollout.status === "active" ? "rolling_out" : rollout.status === "promoted" ? "released" : "rolled_back";
  if (s.proposedVersionId && s.employee.publishedVersionId === s.proposedVersionId) return "released";
  if (s.approval === "approved") return "approved";
  if (!s.proposedVersionId) return "proposed";
  if (!isDone(s.baselineRun?.status) || !isDone(s.candidateRun?.status)) return "testing";
  return "tested";
}

const toSummary = (s: SuggestionRow, nameOf: (id: string) => string): ImprovementSummary => ({
  id: s.id,
  employee: { id: s.employeeId, name: nameOf(s.employeeId) },
  baseVersion: s.baseVersion.number,
  proposedVersion: s.proposedVersion?.number ?? null,
  dimension: s.dimension as EvalDimension,
  title: s.title,
  kpi: s.kpi as Kpi,
  stage: stageOf(s),
  approval: s.approval as ImprovementSummary["approval"],
  failures: (s.evidence as SuggestionEvidence).failures,
  createdAt: s.createdAt.toISOString(),
});

/** Per-conversation KPI values (0-100) of a version's production evaluations in a window. */
async function kpiValues(versionId: string, kpi: Kpi, from: Date, to: Date): Promise<number[]> {
  const evaluation = { ...PRODUCTION, employeeVersionId: versionId, createdAt: { gte: from, lte: to } } satisfies Prisma.EvaluationWhereInput;
  // shortcut: newest 10,000 per side; aggregate in SQL if rollouts outgrow it
  if (kpi === "score" || kpi === "pass_rate") {
    const rows = await prisma.evaluation.findMany({ where: evaluation, select: { score: true, passed: true }, orderBy: { createdAt: "desc" }, take: 10_000 });
    return kpi === "score" ? rows.flatMap((r) => (r.score === null ? [] : [r.score])) : rows.flatMap((r) => (r.passed === null ? [] : [r.passed ? 100 : 0]));
  }
  const rows = await prisma.evaluationResult.findMany({
    where: { dimension: kpi, passed: { not: null }, evaluation },
    select: { passed: true },
    orderBy: { createdAt: "desc" },
    take: 10_000,
  });
  return rows.map((r) => (r.passed ? 100 : 0));
}

/** The rollout with its KPI: the candidate since it started, the control over the same time plus a baseline before. */
async function toRollout(r: RolloutRow): Promise<RolloutInfo> {
  const now = new Date();
  const kpi = r.kpi as Kpi;
  const [control, candidate] = await Promise.all([
    kpiValues(r.controlVersionId, kpi, new Date(r.startedAt.getTime() - BASELINE_DAYS * 86_400_000), r.endedAt ?? now),
    // After a promotion the candidate keeps being measured: it is what everyone gets.
    kpiValues(r.candidateVersionId, kpi, r.startedAt, r.status === "rolled_back" ? (r.endedAt ?? now) : now),
  ]);
  return {
    id: r.id,
    employeeId: r.employeeId,
    controlVersion: r.controlVersion.number,
    candidateVersion: r.candidateVersion.number,
    percent: r.percent,
    status: r.status as RolloutStatus,
    kpi,
    suggestionId: r.suggestionId,
    startedBy: r.startedBy,
    startedAt: r.startedAt.toISOString(),
    endedBy: r.endedBy,
    endedAt: r.endedAt?.toISOString() ?? null,
    result: compareKpi(kpi, { version: r.controlVersion.number, values: control }, { version: r.candidateVersion.number, values: candidate }),
  };
}

/** Both regression runs case by case: which cases the change fixed and which it broke. */
async function testsOf(s: SuggestionRow, nameOf: (id: string) => string): Promise<TestComparison | null> {
  const { baselineRun, candidateRun } = s;
  if (!baselineRun && !candidateRun) return null;
  const runIds = [baselineRun?.id, candidateRun?.id].filter((id): id is string => Boolean(id));
  const evaluations = await prisma.evaluation.findMany({ where: { datasetRunId: { in: runIds } }, select: { datasetRunId: true, caseId: true, passed: true } });
  const caseIds = [...new Set(evaluations.flatMap((e) => (e.caseId ? [e.caseId] : [])))];
  const cases = await prisma.evalCase.findMany({ where: { id: { in: caseIds } }, select: { id: true, name: true } });
  const passed = (runId: string | undefined, caseId: string) => {
    const e = evaluations.find((x) => x.datasetRunId === runId && x.caseId === caseId);
    return e ? e.passed === true : null;
  };
  const list = caseIds.map((caseId) => {
    const baseline = passed(baselineRun?.id, caseId);
    const candidate = passed(candidateRun?.id, caseId);
    const change: CaseChange = baseline === false && candidate === true ? "fixed" : baseline === true && candidate === false ? "regressed" : "same";
    return { caseId, name: cases.find((c) => c.id === caseId)?.name ?? "Deleted case", baseline, candidate, change };
  });
  return {
    datasetId: candidateRun?.datasetId ?? baselineRun?.datasetId ?? null,
    baseline: baselineRun ? toRun(baselineRun, nameOf) : null,
    candidate: candidateRun ? toRun(candidateRun, nameOf) : null,
    cases: list,
    fixes: list.filter((c) => c.change === "fixed").length,
    regressions: list.filter((c) => c.change === "regressed").length,
    complete: baselineRun?.status === "COMPLETED" && candidateRun?.status === "COMPLETED",
  };
}

/** The employee's regression suite: a dataset linked to it, created on first use. */
export async function regressionSuite(scope: Scope & { userId: string }, employeeId: string) {
  const existing = await prisma.evalDataset.findUnique({ where: { employeeId } });
  if (existing) return existing;
  const latest = await prisma.aiEmployeeVersion.findFirst({ where: { employeeId }, orderBy: { number: "desc" }, select: { name: true } });
  const data = {
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    employeeId,
    description: "Known conversations every new version of this employee is tested on before release.",
    createdBy: scope.userId,
  };
  try {
    return await prisma.evalDataset.create({ data: { ...data, name: `Regression suite: ${latest?.name ?? "employee"}`.slice(0, 80) } });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    // Created at the same moment, or another dataset has the name.
    const raced = await prisma.evalDataset.findUnique({ where: { employeeId } });
    if (raced) return raced;
    return prisma.evalDataset.create({ data: { ...data, name: `Regression suite: ${employeeId}` } });
  }
}

/** Adds the conversations behind a suggestion (as failures not to repeat) and a few recent passing ones (as guards). */
async function addSuiteCases(scope: Scope, datasetId: string, employeeId: string, evidence: SuggestionEvidence) {
  const present = new Set(
    (await prisma.evalCase.findMany({ where: { datasetId, conversationId: { not: null } }, select: { conversationId: true } })).map((c) => c.conversationId),
  );
  const passing = await prisma.evaluation.findMany({
    where: { ...scope, ...PRODUCTION, employeeId, passed: true, conversationId: { notIn: [...present].filter((c): c is string => c !== null) } },
    orderBy: { createdAt: "desc" },
    distinct: ["conversationId"],
    take: GUARD_CASES,
    select: { conversationId: true, conversation: { select: { title: true } } },
  });
  const wanted = [
    ...evidence.examples.map((x) => ({
      conversationId: x.conversationId,
      name: `Failure: ${x.conversationTitle}`,
      expectations: `Do not repeat this problem: ${x.reason}`.slice(0, 2000),
    })),
    ...passing.map((p) => ({ conversationId: p.conversationId, name: `Passing: ${p.conversation.title}`, expectations: "" })),
  ];
  for (const c of wanted) {
    if (present.has(c.conversationId)) continue;
    present.add(c.conversationId);
    const messages = await conversationCase(scope, c.conversationId).catch(() => null); // gone, or nothing to replay
    if (!messages) continue;
    await prisma.evalCase.create({
      data: { datasetId, name: c.name.slice(0, 100), source: "conversation", conversationId: c.conversationId, messages, expectations: c.expectations },
    });
  }
}

export function improvementRoutes(app: FastifyInstance, authenticate: Authenticate, queue: Queue) {
  const { member, admin, inWorkspace } = guards(authenticate);
  const ws = "/workspaces/:workspaceId";
  const emp = `${ws}/employees/:id`;

  const suggestionOf = async (scope: Scope, id: string) => {
    const s = await prisma.improvementSuggestion.findFirst({ where: { id, ...scope }, include: suggestionInclude });
    if (!s) throw httpError(404, "Suggestion not found");
    return s;
  };

  const detail = async (scope: Scope, id: string): Promise<ImprovementDetail> => {
    const s = await suggestionOf(scope, id);
    const nameOf = await employeeNames(scope, [s.employeeId]);
    const change = s.change as ProposedChange;
    const base = configOf(s.baseVersion);
    const evaluator = await prisma.evaluator.findUnique({ where: { id: s.evaluatorId }, select: { currentVersion: { select: { name: true } } } });
    const rollout = s.rollouts[0];
    return {
      ...toSummary(s, nameOf),
      evaluatorId: s.evaluatorId,
      evaluatorName: evaluator?.currentVersion?.name ?? "Deleted evaluator",
      reason: s.reason,
      evidence: s.evidence as SuggestionEvidence,
      change,
      base,
      proposed: { ...base, ...change.fields },
      tests: await testsOf(s, nameOf),
      decidedBy: s.decidedBy,
      decidedAt: s.decidedAt?.toISOString() ?? null,
      decisionNote: s.decisionNote,
      rollout: rollout ? await toRollout(rollout) : null,
      createdBy: s.createdBy,
    };
  };

  // ---- Suggestions ----

  app.get(`${ws}/improvements`, async (req): Promise<ImprovementSummary[]> => {
    const { workspaceId } = workspaceParams.parse(req.params);
    const scope = within(await inWorkspace(member(req), workspaceId));
    const { employeeId } = improvementsQuerySchema.parse(req.query);
    // shortcut: newest 100
    const rows = await prisma.improvementSuggestion.findMany({
      where: { ...scope, ...(employeeId && { employeeId }) },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: suggestionInclude,
    });
    const nameOf = await employeeNames(scope, rows.map((r) => r.employeeId));
    return rows.map((r) => toSummary(r, nameOf));
  });

  // Looks for failure patterns now (the daily analysis does the same). Admins only: it spends model calls.
  app.post(`${ws}/improvements/analyze`, async (req, reply) => {
    const { workspaceId } = workspaceParams.parse(req.params);
    const scope = within(await inWorkspace(admin(req), workspaceId));
    await queue("improvement/analyze", scope);
    return reply.code(202).send({ queued: true });
  });

  app.get(`${ws}/improvements/:id`, async (req): Promise<ImprovementDetail> => {
    const { workspaceId, id } = idParams.parse(req.params);
    return detail(within(await inWorkspace(member(req), workspaceId)), id);
  });

  // Creates the proposed version (once) and replays the regression suite against it and the base version.
  app.post(`${ws}/improvements/:id/test`, async (req, reply) => {
    const { workspaceId, id } = idParams.parse(req.params);
    const auth = await inWorkspace(admin(req), workspaceId);
    const scope = within(auth);
    const s = await suggestionOf(scope, id);
    if (s.approval !== "pending") throw httpError(409, "This suggestion has already been decided.");
    if ((s.baselineRun && !isDone(s.baselineRun.status)) || (s.candidateRun && !isDone(s.candidateRun.status)))
      throw httpError(409, "The tests are already running.");

    let proposedVersionId = s.proposedVersionId;
    if (!proposedVersionId) {
      const config = employeeConfigSchema.parse({ ...configOf(s.baseVersion), ...(s.change as ProposedChange).fields });
      const latest = await prisma.aiEmployeeVersion.findFirst({ where: { employeeId: s.employeeId }, orderBy: { number: "desc" }, select: { number: true } });
      try {
        const [version] = await prisma.$transaction(async (tx) => {
          const v = await tx.aiEmployeeVersion.create({ data: { ...config, employeeId: s.employeeId, number: (latest?.number ?? 0) + 1, createdBy: auth.userId } });
          // Only a suggestion without a version takes this one: a second request at the same moment fails here.
          const { count } = await tx.improvementSuggestion.updateMany({ where: { id, proposedVersionId: null }, data: { proposedVersionId: v.id } });
          if (count === 0) throw httpError(409, "The version was just created by someone else. Reload.");
          return [v];
        });
        proposedVersionId = version.id;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")
          throw httpError(409, "Someone else saved this employee at the same time. Try again.");
        throw err;
      }
    }

    const suite = await regressionSuite(auth, s.employeeId);
    await addSuiteCases(scope, suite.id, s.employeeId, s.evidence as SuggestionEvidence);
    const total = await prisma.evalCase.count({ where: { datasetId: suite.id } });
    if (total === 0) throw httpError(400, "The regression suite has no cases to replay. Add conversations to it first.");
    await ensureDefaultEvaluators(scope);
    const run = (employeeVersionId: string) =>
      prisma.evalRun.create({ data: { ...scope, datasetId: suite.id, employeeId: s.employeeId, employeeVersionId, total, startedBy: auth.userId } });
    const [baseline, candidate] = await Promise.all([run(s.baseVersionId), run(proposedVersionId)]);
    await prisma.improvementSuggestion.update({ where: { id }, data: { baselineRunId: baseline.id, candidateRunId: candidate.id } });
    await queue("evaluation/dataset.run", { runId: baseline.id });
    await queue("evaluation/dataset.run", { runId: candidate.id });
    return reply.code(202).send(await detail(scope, id));
  });

  // A person approves (after the tests finished) or rejects. Approval allows a rollout; it changes nothing by itself.
  app.post(`${ws}/improvements/:id/decision`, async (req) => {
    const { workspaceId, id } = idParams.parse(req.params);
    const auth = await inWorkspace(admin(req), workspaceId);
    const scope = within(auth);
    const { decision, note } = decisionSchema.parse(req.body);
    const s = await suggestionOf(scope, id);
    if (decision === "approve" && !(s.baselineRun?.status === "COMPLETED" && s.candidateRun?.status === "COMPLETED"))
      throw httpError(409, "Run the regression tests and wait for them to finish before approving.");
    const { count } = await prisma.improvementSuggestion.updateMany({
      where: { id, approval: "pending" },
      data: { approval: decision === "approve" ? "approved" : "rejected", decidedBy: auth.userId, decidedAt: new Date(), decisionNote: note },
    });
    if (count === 0) throw httpError(409, "This suggestion has already been decided.");
    return detail(scope, id);
  });

  // ---- Rollouts, releases, rollback ----

  const employeeOf = async (scope: Scope, id: string) => {
    const employee = await prisma.aiEmployee.findFirst({
      where: { id, ...scope },
      include: { publishedVersion: { select: { id: true, number: true } }, activeRollout: { include: rolloutInclude } },
    });
    if (!employee) throw httpError(404, "Employee not found");
    return employee;
  };

  app.get(`${emp}/releases`, async (req): Promise<EmployeeReleases> => {
    const { workspaceId, id } = employeeParams.parse(req.params);
    const scope = within(await inWorkspace(member(req), workspaceId));
    const employee = await employeeOf(scope, id);
    const [rollouts, releases, suite, rollbackTo] = await Promise.all([
      // shortcut: newest 20 rollouts and 50 releases
      prisma.employeeRollout.findMany({ where: { employeeId: id }, orderBy: { startedAt: "desc" }, take: 20, include: rolloutInclude }),
      prisma.employeeRelease.findMany({ where: { employeeId: id }, orderBy: { createdAt: "desc" }, take: 50 }),
      prisma.evalDataset.findUnique({ where: { employeeId: id }, include: { _count: { select: { cases: true } } } }),
      rollbackTarget(id, employee.publishedVersion?.number ?? null),
    ]);
    const list = await Promise.all(rollouts.map(toRollout));
    return {
      active: list.find((r) => r.status === "active") ?? null,
      rollouts: list,
      releases: releases.map((r) => ({
        id: r.id,
        action: r.action as ReleaseAction,
        version: r.version,
        previousVersion: r.previousVersion,
        by: r.by,
        createdAt: r.createdAt.toISOString(),
      })),
      regressionSuite: suite ? { id: suite.id, cases: suite._count.cases } : null,
      rollbackTo,
    };
  });

  app.post(`${emp}/regression-suite`, async (req) => {
    const { workspaceId, id } = employeeParams.parse(req.params);
    const auth = await inWorkspace(admin(req), workspaceId);
    await employeeOf(within(auth), id);
    const suite = await regressionSuite(auth, id);
    return { id: suite.id };
  });

  // Serves a version to a share of customers next to the published one. Admins only: it changes production.
  app.post(`${emp}/rollouts`, async (req, reply) => {
    const { workspaceId, id } = employeeParams.parse(req.params);
    const auth = await inWorkspace(admin(req), workspaceId);
    const scope = within(auth);
    const body = startRolloutSchema.parse(req.body);
    const employee = await employeeOf(scope, id);
    if (employee.status !== "ACTIVE" || !employee.publishedVersion) throw httpError(409, "Publish this employee and make it active before a rollout.");
    if (employee.activeRollout) throw httpError(409, "A rollout is already running for this employee.");
    const target = await prisma.aiEmployeeVersion.findUnique({ where: { employeeId_number: { employeeId: id, number: body.version } }, select: { id: true } });
    if (!target) throw httpError(404, "Version not found");
    if (target.id === employee.publishedVersion.id) throw httpError(400, "This version is already live.");
    const suggestion = await prisma.improvementSuggestion.findUnique({ where: { proposedVersionId: target.id }, select: { id: true, approval: true } });
    if (suggestion && suggestion.approval !== "approved")
      throw httpError(409, "This version comes from an improvement suggestion that has not been approved. Approve it first.");
    try {
      const rollout = await prisma.employeeRollout.create({
        data: {
          ...scope,
          employeeId: id,
          activeEmployeeId: id,
          controlVersionId: employee.publishedVersion.id,
          candidateVersionId: target.id,
          suggestionId: suggestion?.id,
          percent: body.percent,
          kpi: body.kpi,
          status: "active",
          startedBy: auth.userId,
        },
        include: rolloutInclude,
      });
      return reply.code(201).send(await toRollout(rollout));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw httpError(409, "A rollout is already running for this employee.");
      throw err;
    }
  });

  app.patch(`${emp}/rollouts/:rolloutId`, async (req) => {
    const { workspaceId, id, rolloutId } = rolloutParams.parse(req.params);
    const auth = await inWorkspace(admin(req), workspaceId);
    const scope = within(auth);
    const body = rolloutActionSchema.parse(req.body);
    const employee = await employeeOf(scope, id);
    const rollout = employee.activeRollout;
    if (rollout?.id !== rolloutId) throw httpError(409, "This rollout is not running.");
    const ended = { activeEmployeeId: null, endedBy: auth.userId, endedAt: new Date() };
    // Conditional on still being active, so two people ending it at once cannot both act.
    const end = (status: RolloutStatus) => prisma.employeeRollout.updateMany({ where: { id: rolloutId, activeEmployeeId: id }, data: { ...ended, status } });

    if (body.action === "set_percent") await prisma.employeeRollout.update({ where: { id: rolloutId }, data: { percent: body.percent } });
    else if (body.action === "rollback") await end("rolled_back");
    else {
      // Promote: the candidate becomes the published version for everyone.
      await prisma.$transaction(async (tx) => {
        const { count } = await tx.employeeRollout.updateMany({ where: { id: rolloutId, activeEmployeeId: id }, data: { ...ended, status: "promoted" } });
        if (count === 0) throw httpError(409, "This rollout is not running.");
        await release(tx, {
          scope,
          employee,
          version: { id: rollout.candidateVersionId, number: rollout.candidateVersion.number },
          action: "promote",
          by: auth.userId,
          rolloutId,
        });
      });
    }
    const updated = await prisma.employeeRollout.findUniqueOrThrow({ where: { id: rolloutId }, include: rolloutInclude });
    return toRollout(updated);
  });

  // Publishes the version that was live before the current one.
  app.post(`${emp}/rollback`, async (req) => {
    const { workspaceId, id } = employeeParams.parse(req.params);
    const auth = await inWorkspace(admin(req), workspaceId);
    const scope = within(auth);
    const employee = await employeeOf(scope, id);
    if (employee.activeRollout) throw httpError(409, "A rollout is running. Roll it back instead.");
    const to = await rollbackTarget(id, employee.publishedVersion?.number ?? null);
    if (to === null) throw httpError(409, "There is no earlier live version to roll back to.");
    const version = await prisma.aiEmployeeVersion.findUniqueOrThrow({ where: { employeeId_number: { employeeId: id, number: to } }, select: { id: true, number: true } });
    await prisma.$transaction((tx) => release(tx, { scope, employee, version, action: "rollback", by: auth.userId }));
    return { version: to };
  });
}
