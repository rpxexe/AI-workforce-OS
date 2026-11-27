import { randomBytes, timingSafeEqual } from "node:crypto";
import { Prisma, prisma } from "@workforce/database";
import {
  ADMIN_ROLE,
  blankWorkflow,
  createWorkflowSchema,
  duplicateWorkflowSchema,
  nodeConfigSchemas,
  publishSchema,
  runWorkflowSchema,
  saveWorkflowSchema,
  setWorkflowStatusSchema,
  validateWorkflow,
  workflowDefinitionSchema,
  type ApiError,
  type NodeType,
  type WorkflowDefinition,
  type WorkflowDependencies,
  type WorkflowDetail,
  type WorkflowExecutionDetail,
  type WorkflowExecutionStatus,
  type WorkflowExecutionSummary,
  type WorkflowIssue,
  type WorkflowListItem,
  type WorkflowSummary,
} from "@workforce/shared";
import { WorkflowStartError, type WorkflowEngine } from "@workforce/workflows";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { guards, httpError, type Authenticate } from "./auth.ts";
import { within } from "./employees.ts";

type Tenant = { organizationId: string; workspaceId: string };

const workspaceParams = z.object({ workspaceId: z.string().min(1) });
const workflowParams = workspaceParams.extend({ id: z.string().min(1) });
const executionParams = workspaceParams.extend({ executionId: z.string().min(1) });
const hookParams = z.object({ id: z.string().min(1), token: z.string().min(1) });
const versionQuery = z.object({ version: z.coerce.number().int().positive().optional() });
const listQuery = z.object({ deleted: z.literal("true").optional() });
const deleteQuery = z.object({ stopRuns: z.literal("true").optional() });
const IN_PROGRESS = ["QUEUED", "RUNNING", "WAITING"] as const;

const summaryInclude = {
  versions: { orderBy: { number: "desc" }, select: { number: true, createdBy: true, createdAt: true } },
  publishedVersion: { select: { number: true } },
} satisfies Prisma.WorkflowInclude;

const toSummary = (w: Prisma.WorkflowGetPayload<{ include: typeof summaryInclude }>): WorkflowSummary => ({
  id: w.id,
  name: w.name,
  description: w.description,
  status: w.status,
  latestVersion: w.versions[0]?.number ?? 0,
  publishedVersion: w.publishedVersion?.number ?? null,
  updatedAt: w.updatedAt.toISOString(),
  deletedAt: w.deletedAt?.toISOString() ?? null,
});

/** What starts a version: its trigger node's kind, or null when it has none (or the definition is unreadable). */
const triggerOf = (definition: unknown): WorkflowListItem["trigger"] => {
  const parsed = workflowDefinitionSchema.safeParse(definition);
  const node = parsed.success ? parsed.data.nodes.find((n) => n.type === "trigger") : undefined;
  return node ? (nodeConfigSchemas.trigger.safeParse(node.config).data?.kind ?? "manual") : null;
};

const executionInclude = { version: { select: { number: true, definition: true } } } satisfies Prisma.WorkflowExecutionInclude;

const toExecution = (e: Prisma.WorkflowExecutionGetPayload<{ include: typeof executionInclude }>): WorkflowExecutionSummary => ({
  id: e.id,
  workflowId: e.workflowId,
  version: e.version.number,
  status: e.status,
  currentNodeId: e.currentNodeId,
  error: e.error,
  startedBy: e.startedBy,
  createdAt: e.createdAt.toISOString(),
  finishedAt: e.finishedAt?.toISOString() ?? null,
  runAt: e.runAt?.toISOString() ?? null,
});

const sameSecret = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Workflows (the journey builder): definitions and their versions, publishing, pausing, runs.
 * Nothing here runs a step; runs are queued for the engine (`@workforce/workflows`).
 */
export function workflowRoutes(app: FastifyInstance, authenticate: Authenticate, engine: WorkflowEngine, publicUrl: string | null) {
  const { member, admin, inWorkspace } = guards(authenticate);
  const base = "/workspaces/:workspaceId/workflows";

  /** The graph rules, plus what only the database knows: that named employees exist and hold the tools nodes use. */
  const issuesOf = async (scope: Tenant, definition: WorkflowDefinition): Promise<WorkflowIssue[]> => {
    const issues = validateWorkflow(definition);
    const employeeOf = (config: Record<string, unknown>) =>
      typeof config.employeeId === "string" && config.employeeId !== "" ? config.employeeId : null;
    const ids = [...new Set(definition.nodes.map((n) => employeeOf(n.config)).filter((id) => id !== null))];
    const employees = await prisma.aiEmployee.findMany({
      where: { id: { in: ids }, ...within(scope), status: { not: "ARCHIVED" } },
      select: { id: true, tools: { select: { tool: true } } },
    });
    for (const node of definition.nodes) {
      const id = employeeOf(node.config);
      if (!id) continue;
      const employee = employees.find((e) => e.id === id);
      if (!employee) issues.push({ nodeId: node.id, message: `${node.name}: the employee does not exist or is archived` });
      else if (node.type === "tool" && !employee.tools.some((t) => t.tool === node.config.tool))
        issues.push({ nodeId: node.id, message: `${node.name}: grant ${String(node.config.tool)} to this employee first` });
    }
    return issues;
  };

  const find = async (scope: Tenant, id: string, deleted = false) => {
    const workflow = await prisma.workflow.findFirst({
      where: { id, ...within(scope), deletedAt: deleted ? { not: null } : null },
      include: summaryInclude,
    });
    if (!workflow) throw httpError(404, "Workflow not found");
    return workflow;
  };

  const detail = async (req: FastifyRequest, scope: Tenant & { role: string | null }, id: string, number?: number): Promise<WorkflowDetail> => {
    const workflow = await find(scope, id);
    const version = number ?? workflow.versions[0]?.number ?? 1;
    const row = await prisma.workflowVersion.findUnique({ where: { workflowId_number: { workflowId: id, number: version } } });
    if (!row) throw httpError(404, "Version not found");
    const definition = workflowDefinitionSchema.parse(row.definition);
    const origin = (publicUrl ?? `${req.protocol}://${req.host}`).replace(/\/+$/, "");
    return {
      ...toSummary(workflow),
      versions: workflow.versions.map((v) => ({ number: v.number, createdBy: v.createdBy, createdAt: v.createdAt.toISOString() })),
      version,
      definition,
      issues: await issuesOf(scope, definition),
      // The token is a secret: only admins see it.
      hookUrl: scope.role === ADMIN_ROLE ? `${origin}/hooks/workflows/${id}/${workflow.hookToken}` : null,
    };
  };

  const executionDetail = async (scope: Tenant, executionId: string): Promise<WorkflowExecutionDetail> => {
    const execution = await prisma.workflowExecution.findFirst({
      where: { id: executionId, ...within(scope) },
      include: { ...executionInclude, steps: { orderBy: [{ startedAt: "asc" }, { attempt: "asc" }] } },
    });
    if (!execution) throw httpError(404, "Run not found");
    return {
      ...toExecution(execution),
      input: execution.input,
      definition: workflowDefinitionSchema.parse(execution.version.definition),
      steps: execution.steps.map((s) => ({
        id: s.id,
        nodeId: s.nodeId,
        nodeType: s.nodeType as NodeType,
        attempt: s.attempt,
        status: s.status,
        input: s.input,
        output: s.output,
        error: s.error,
        startedAt: s.startedAt.toISOString(),
        finishedAt: s.finishedAt?.toISOString() ?? null,
      })),
    };
  };

  const dependenciesOf = async (scope: Tenant, id: string): Promise<WorkflowDependencies> => {
    const [activeRuns, workflow] = await Promise.all([
      prisma.workflowExecution.count({ where: { workflowId: id, ...within(scope), status: { in: [...IN_PROGRESS] } } }),
      prisma.workflow.findFirst({ where: { id, ...within(scope) }, include: { publishedVersion: true } }),
    ]);
    const published = workflow?.publishedVersion && workflowDefinitionSchema.parse(workflow.publishedVersion.definition);
    const trigger = published?.nodes.find((n) => n.type === "trigger");
    return { activeRuns, webhookTrigger: workflow?.status === "ACTIVE" && trigger?.config.kind === "webhook" };
  };

  const started = (err: unknown) => {
    if (err instanceof WorkflowStartError) return httpError(err.status, err.message);
    return err;
  };

  app.get(base, async (req): Promise<WorkflowListItem[]> => {
    const { workspaceId } = workspaceParams.parse(req.params);
    const scope = await inWorkspace(member(req), workspaceId);
    const { deleted } = listQuery.parse(req.query);
    const workflows = await prisma.workflow.findMany({
      where: { ...within(scope), deletedAt: deleted ? { not: null } : null },
      orderBy: { updatedAt: "desc" },
      // shortcut: the whole list (the page searches, filters, counts and pages it in the browser); move those to the
      // server with a cursor, as on Customers, when a workspace has thousands of workflows
      include: {
        versions: { ...summaryInclude.versions, select: { ...summaryInclude.versions.select, definition: true }, take: 1 },
        publishedVersion: { select: { number: true, definition: true } },
      },
    });
    const ids = workflows.map((w) => w.id);
    // Each workflow's latest run and its run count in one pass over the (workflowId, createdAt) index.
    const runs = ids.length
      ? await prisma.$queryRaw<{ workflowId: string; status: WorkflowExecutionStatus; createdAt: Date; runs: number }[]>`
          SELECT DISTINCT ON ("workflowId") "workflowId", status::text AS status, "createdAt",
                 (count(*) OVER (PARTITION BY "workflowId"))::int AS runs
          FROM "WorkflowExecution"
          WHERE "organizationId" = ${scope.organizationId} AND "workspaceId" = ${scope.workspaceId} AND "workflowId" = ANY(${ids})
          ORDER BY "workflowId", "createdAt" DESC, id DESC`
      : [];
    const runsOf = new Map(runs.map((r) => [r.workflowId, r]));
    return workflows.map((w) => {
      const last = runsOf.get(w.id);
      return {
        ...toSummary(w),
        trigger: triggerOf(w.publishedVersion?.definition ?? w.versions[0]?.definition),
        runCount: last?.runs ?? 0,
        lastRunAt: last?.createdAt.toISOString() ?? null,
        lastRunStatus: last?.status ?? null,
      };
    });
  });

  app.post(base, async (req, reply): Promise<WorkflowDetail> => {
    const { workspaceId } = workspaceParams.parse(req.params);
    const scope = await inWorkspace(admin(req), workspaceId);
    const body = createWorkflowSchema.parse(req.body);
    const workflow = await prisma.workflow.create({
      data: {
        ...within(scope),
        name: body.name,
        description: body.description,
        hookToken: randomBytes(24).toString("base64url"),
        createdBy: scope.userId,
        versions: { create: { number: 1, definition: (body.definition ?? blankWorkflow()) as Prisma.InputJsonObject, createdBy: scope.userId } },
      },
    });
    reply.code(201);
    return detail(req, scope, workflow.id);
  });

  // Checks a definition without saving it, so the editor can show what would block publishing.
  app.post(`${base}/validate`, async (req): Promise<{ issues: WorkflowIssue[] }> => {
    const { workspaceId } = workspaceParams.parse(req.params);
    const scope = await inWorkspace(member(req), workspaceId);
    const { definition } = z.object({ definition: workflowDefinitionSchema }).parse(req.body);
    return { issues: await issuesOf(scope, definition) };
  });

  app.get(`${base}/:id`, async (req): Promise<WorkflowDetail> => {
    const { workspaceId, id } = workflowParams.parse(req.params);
    const scope = await inWorkspace(member(req), workspaceId);
    return detail(req, scope, id, versionQuery.parse(req.query).version);
  });

  // Saving never changes a version: it appends one. Runs keep using the published version.
  app.put(`${base}/:id`, async (req): Promise<WorkflowDetail> => {
    const { workspaceId, id } = workflowParams.parse(req.params);
    const scope = await inWorkspace(admin(req), workspaceId);
    const body = saveWorkflowSchema.parse(req.body);
    const workflow = await find(scope, id);
    try {
      await prisma.workflow.update({
        where: { id },
        data: {
          name: body.name,
          description: body.description,
          versions: {
            create: { number: (workflow.versions[0]?.number ?? 0) + 1, definition: body.definition as Prisma.InputJsonObject, createdBy: scope.userId },
          },
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")
        throw httpError(409, "Someone else saved this workflow at the same time. Reload and try again.");
      throw err;
    }
    return detail(req, scope, id);
  });

  app.post(`${base}/:id/publish`, async (req, reply): Promise<WorkflowDetail | ApiError> => {
    const { workspaceId, id } = workflowParams.parse(req.params);
    const scope = await inWorkspace(admin(req), workspaceId);
    const { version } = publishSchema.parse(req.body);
    const workflow = await find(scope, id);
    const target = await prisma.workflowVersion.findUnique({ where: { workflowId_number: { workflowId: id, number: version } } });
    if (!target) throw httpError(404, "Version not found");
    const issues = await issuesOf(scope, workflowDefinitionSchema.parse(target.definition));
    if (issues.length > 0) {
      reply.code(400);
      return { error: "Fix these problems before publishing", issues: issues.map((i) => ({ path: i.nodeId ?? "", message: i.message })) };
    }
    await prisma.workflow.update({
      where: { id },
      data: { publishedVersionId: target.id, ...(workflow.status === "DRAFT" && { status: "ACTIVE" }) },
    });
    return detail(req, scope, id);
  });

  // Pause holds every run of the workflow between steps and refuses new ones; resume releases them.
  app.patch(`${base}/:id/status`, async (req): Promise<WorkflowDetail> => {
    const { workspaceId, id } = workflowParams.parse(req.params);
    const scope = await inWorkspace(admin(req), workspaceId);
    const { status } = setWorkflowStatusSchema.parse(req.body);
    const workflow = await find(scope, id);
    if (!workflow.publishedVersion) throw httpError(409, "Publish this workflow first");
    await prisma.workflow.update({ where: { id }, data: { status } });
    return detail(req, scope, id);
  });

  // What deleting would affect, for the confirmation.
  app.get(`${base}/:id/dependencies`, async (req): Promise<WorkflowDependencies> => {
    const { workspaceId, id } = workflowParams.parse(req.params);
    const scope = await inWorkspace(admin(req), workspaceId);
    await find(scope, id);
    return dependenciesOf(scope, id);
  });

  // Deleting hides the workflow, turns off its hook URL and stops its runs; restore brings it back
  // (paused). Runs in progress block it unless ?stopRuns=true, so nobody stops them by accident.
  app.delete(`${base}/:id`, async (req, reply) => {
    const { workspaceId, id } = workflowParams.parse(req.params);
    const scope = await inWorkspace(admin(req), workspaceId);
    const { stopRuns } = deleteQuery.parse(req.query);
    await find(scope, id);
    const { activeRuns } = await dependenciesOf(scope, id);
    if (activeRuns > 0 && !stopRuns)
      throw httpError(409, `${activeRuns === 1 ? "1 run is" : `${activeRuns} runs are`} still in progress. Deleting the workflow stops them.`);
    // Hidden first, so no runner claims a run between the two writes.
    await prisma.workflow.update({ where: { id }, data: { deletedAt: new Date() } });
    await engine.stopRuns(within(scope), id, "Stopped: the workflow was deleted");
    return reply.code(204).send();
  });

  app.post(`${base}/:id/restore`, async (req): Promise<WorkflowDetail> => {
    const { workspaceId, id } = workflowParams.parse(req.params);
    const scope = await inWorkspace(admin(req), workspaceId);
    const workflow = await find(scope, id, true);
    // Back paused, not live: an admin resumes it on purpose. Stopped runs can be retried after that.
    await prisma.workflow.update({ where: { id }, data: { deletedAt: null, status: workflow.publishedVersion ? "PAUSED" : "DRAFT" } });
    return detail(req, scope, id);
  });

  // A new draft workflow from one version (the latest by default), with its own hook URL.
  app.post(`${base}/:id/duplicate`, async (req, reply): Promise<WorkflowDetail> => {
    const { workspaceId, id } = workflowParams.parse(req.params);
    const scope = await inWorkspace(admin(req), workspaceId);
    const { version } = duplicateWorkflowSchema.parse(req.body ?? {});
    const source = await find(scope, id);
    const row = await prisma.workflowVersion.findUnique({
      where: { workflowId_number: { workflowId: id, number: version ?? source.versions[0]?.number ?? 1 } },
    });
    if (!row) throw httpError(404, "Version not found");
    const copy = await prisma.workflow.create({
      data: {
        ...within(scope),
        name: `Copy of ${source.name}`.slice(0, 80),
        description: source.description,
        hookToken: randomBytes(24).toString("base64url"),
        createdBy: scope.userId,
        versions: { create: { number: 1, definition: row.definition as Prisma.InputJsonObject, createdBy: scope.userId } },
      },
    });
    reply.code(201);
    return detail(req, scope, copy.id);
  });

  app.post(`${base}/:id/executions`, async (req, reply): Promise<WorkflowExecutionSummary> => {
    const { workspaceId, id } = workflowParams.parse(req.params);
    const scope = await inWorkspace(admin(req), workspaceId);
    const { input } = runWorkflowSchema.parse(req.body ?? {});
    const execution = await engine.start(within(scope), id, input, scope.userId).catch((err: unknown) => {
      throw started(err);
    });
    reply.code(202);
    return toExecution(await prisma.workflowExecution.findUniqueOrThrow({ where: { id: execution.id }, include: executionInclude }));
  });

  app.get(`${base}/:id/executions`, async (req): Promise<WorkflowExecutionSummary[]> => {
    const { workspaceId, id } = workflowParams.parse(req.params);
    const scope = await inWorkspace(member(req), workspaceId);
    const executions = await prisma.workflowExecution.findMany({
      where: { workflowId: id, ...within(scope) },
      orderBy: { createdAt: "desc" },
      // shortcut: newest 50 only, add a cursor when a run history page is built
      take: 50,
      include: executionInclude,
    });
    return executions.map(toExecution);
  });

  app.get("/workspaces/:workspaceId/workflow-executions/:executionId", async (req) => {
    const { workspaceId, executionId } = executionParams.parse(req.params);
    const scope = await inWorkspace(member(req), workspaceId);
    return executionDetail(scope, executionId);
  });

  app.post("/workspaces/:workspaceId/workflow-executions/:executionId/retry", async (req) => {
    const { workspaceId, executionId } = executionParams.parse(req.params);
    const scope = await inWorkspace(admin(req), workspaceId);
    await executionDetail(scope, executionId);
    if (!(await engine.retry(within(scope), executionId))) throw httpError(409, "Only failed runs can be retried");
    return executionDetail(scope, executionId);
  });

  app.post("/workspaces/:workspaceId/workflow-executions/:executionId/resume", async (req) => {
    const { workspaceId, executionId } = executionParams.parse(req.params);
    const scope = await inWorkspace(admin(req), workspaceId);
    await executionDetail(scope, executionId);
    if (!(await engine.resume(within(scope), executionId, scope.userId))) throw httpError(409, "This run is not waiting for a person");
    return executionDetail(scope, executionId);
  });

  // Public: starts a run of a webhook-triggered workflow. The token in the URL is the credential.
  app.post("/hooks/workflows/:id/:token", async (req, reply) => {
    const { id, token } = hookParams.parse(req.params);
    const workflow = await prisma.workflow.findUnique({ where: { id }, include: { publishedVersion: true } });
    if (!workflow || workflow.deletedAt || !sameSecret(token, workflow.hookToken)) throw httpError(404, "Not found");
    const definition = workflow.publishedVersion && workflowDefinitionSchema.parse(workflow.publishedVersion.definition);
    const trigger = definition?.nodes.find((n) => n.type === "trigger");
    if (trigger && nodeConfigSchemas.trigger.parse(trigger.config).kind !== "webhook")
      throw httpError(409, "This workflow is not started by a webhook");
    const input = z.record(z.string(), z.unknown()).catch({}).parse(req.body);
    const scope = { organizationId: workflow.organizationId, workspaceId: workflow.workspaceId };
    const execution = await engine.start(scope, id, input, "webhook").catch((err: unknown) => {
      throw started(err);
    });
    return reply.code(202).send({ executionId: execution.id });
  });
}
