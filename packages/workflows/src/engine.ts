// Runs workflow versions. The `WorkflowExecution` row is the background job: starting a run
// inserts a QUEUED row, and runners claim due rows (QUEUED, or WAITING whose time has come) with
// FOR UPDATE SKIP LOCKED, so several API processes can share the work without running a step twice.
// Runners are either the in-process poller (startRunner) or a job queue calling runOne per due run.
//
//   claim -> advance: node after node, one WorkflowStepExecution per attempt, until
//            End (COMPLETED), a failure (FAILED, retryable), or a wait (WAITING until runAt,
//            or until a person continues it)
import { setTimeout as sleep } from "node:timers/promises";
import { Prisma, prisma } from "@workforce/database";
import {
  nextNode,
  nodeConfigSchemas,
  workflowDefinitionSchema,
  type NodeType,
  type WorkflowNode,
} from "@workforce/shared";
import { handlers, StepError, type EngineDeps, type StepResult, type StepRun } from "./nodes.ts";
import { fill } from "./template.ts";

/** How long a claimed run is held before another runner may assume its runner died. Renewed on every step. */
const LOCK_MS = 10 * 60_000;
const CLAIM_BATCH = 10;

/** Why a run could not start; `status` is the HTTP status that fits. */
export class WorkflowStartError extends Error {
  status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

type Scope = { organizationId: string; workspaceId: string };
type Json = Prisma.InputJsonValue;

const lock = () => new Date(Date.now() + LOCK_MS);

/** The node's settings with defaults applied and templates filled in. Tool arguments keep their types. */
function settings(node: WorkflowNode, data: StepRun["data"]) {
  const parsed = nodeConfigSchemas[node.type].safeParse(node.config);
  if (!parsed.success) throw new StepError(`${node.name} is not set up: ${parsed.error.issues[0]?.message}`);
  const config = fill(parsed.data, data) as Record<string, unknown>;
  if (node.type === "tool") config.input = fill((parsed.data as { input: unknown }).input, data, true);
  return config;
}

/** Due runs of active workflows: queued, waiting whose time has come, or running under an expired lock (their runner died). */
const DUE = Prisma.sql`w.status = 'ACTIVE' AND w."deletedAt" IS NULL AND (
  (x.status IN ('QUEUED', 'WAITING') AND x."runAt" <= now())
  OR (x.status = 'RUNNING' AND x."lockedUntil" < now()))`;

/**
 * `onDue` hears about runs that became due now (started, retried, continued), so a job queue can
 * pick them up at once instead of waiting for the next poll.
 */
export function createWorkflowEngine(deps: EngineDeps, options: { onDue?: (executionId: string) => void } = {}) {
  /** Claims up to `limit` due runs (only `id`, when given). */
  const claim = (limit: number, id?: string) =>
    prisma.$queryRaw<{ id: string }[]>`
      UPDATE "WorkflowExecution" SET status = 'RUNNING', "lockedUntil" = ${lock()}, "updatedAt" = now()
      WHERE id IN (
        SELECT x.id FROM "WorkflowExecution" x JOIN "Workflow" w ON w.id = x."workflowId"
        WHERE ${DUE} ${id ? Prisma.sql`AND x.id = ${id}` : Prisma.empty}
        ORDER BY x."runAt"
        LIMIT ${limit}
        FOR UPDATE OF x SKIP LOCKED)
      RETURNING id`;

  /** Runs a claimed execution until it ends, fails or waits. */
  async function advance(id: string) {
    const execution = await prisma.workflowExecution.findUniqueOrThrow({ where: { id }, include: { version: true } });
    const definition = workflowDefinitionSchema.parse(execution.version.definition);
    const nodes = new Map(definition.nodes.map((n) => [n.id, n]));
    const scope: Scope = { organizationId: execution.organizationId, workspaceId: execution.workspaceId };
    let steps = execution.context as Record<string, unknown>;
    let nodeId = execution.currentNodeId;

    /**
     * Records a step's outcome and moves the run on, only while this runner still holds the run.
     * A run stopped meanwhile (its workflow was deleted) stays stopped, and its step stays RUNNING,
     * so a retry continues that attempt as interrupted and its idempotency key finds the effect.
     */
    const settle = (stepId: string, stepData: Prisma.WorkflowStepExecutionUpdateInput, runData: Prisma.WorkflowExecutionUpdateManyMutationInput) =>
      prisma.$transaction(async (tx) => {
        const { count } = await tx.workflowExecution.updateMany({ where: { id, status: "RUNNING" }, data: runData });
        if (count > 0) await tx.workflowStepExecution.update({ where: { id: stepId }, data: stepData });
        return count > 0;
      });

    // Validation forbids loops, so a run visits each node at most once.
    for (let visited = 0; nodeId && visited <= nodes.size; visited++) {
      if (visited > 0) {
        // Pausing the workflow holds its runs between steps.
        const workflow = await prisma.workflow.findUnique({ where: { id: execution.workflowId }, select: { status: true, deletedAt: true } });
        if (workflow?.status !== "ACTIVE" || workflow.deletedAt)
          return prisma.workflowExecution.updateMany({ where: { id, status: "RUNNING" }, data: { status: "QUEUED", runAt: new Date(), lockedUntil: null } });
      }
      const node = nodes.get(nodeId);
      if (!node) break;

      // Continue the step that is waiting (or was cut off by a crash); a failed one gets a new attempt.
      const last = await prisma.workflowStepExecution.findFirst({ where: { executionId: id, nodeId }, orderBy: { attempt: "desc" } });
      const step =
        last && (last.status === "WAITING" || last.status === "RUNNING")
          ? last
          : await prisma.workflowStepExecution.create({
              data: { executionId: id, nodeId, nodeType: node.type, attempt: (last?.attempt ?? 0) + 1, status: "RUNNING" },
            });

      const data = { trigger: execution.input, steps };
      let input: Record<string, unknown> | undefined;
      let result: StepResult;
      try {
        input = settings(node, data);
        const handler = handlers[node.type as NodeType] as (config: unknown, run: StepRun) => Promise<StepResult>;
        result = await handler(input, {
          scope,
          executionId: id,
          workflowId: execution.workflowId,
          nodeId,
          data,
          state: (step.state as Record<string, unknown> | null) ?? null,
          idempotencyKey: `${id}:${nodeId}:${step.attempt}`,
          interrupted: step === last && last.status === "RUNNING",
          deps,
        });
      } catch (err) {
        if (!(err instanceof StepError)) deps.onError(err, `workflow step ${node.type}`);
        const error = err instanceof StepError ? err.message : `${node.name} failed unexpectedly`;
        await settle(
          step.id,
          { status: "FAILED", error, input: input as Json, finishedAt: new Date() },
          { status: "FAILED", error: `${node.name}: ${error}`, runAt: null, lockedUntil: null, finishedAt: new Date() },
        );
        return;
      }

      if ("wait" in result) {
        await settle(
          step.id,
          { status: "WAITING", input: input as Json, state: result.wait.state as Json },
          { status: "WAITING", runAt: result.wait.until, lockedUntil: null },
        );
        return;
      }

      steps = { ...steps, [node.id]: result.output ?? null };
      const next = node.type === "end" ? null : nextNode(definition, node.id, result.branch);
      const moved = await settle(
        step.id,
        { status: "SUCCEEDED", input: input as Json, output: (result.output ?? null) as Json, finishedAt: new Date() },
        {
          context: steps as Json,
          currentNodeId: next,
          lockedUntil: lock(),
          ...(next === null && { status: "COMPLETED", runAt: null, lockedUntil: null, finishedAt: new Date() }),
        },
      );
      if (!moved) return;
      nodeId = next;
    }
  }

  /** Claims due runs and advances them, together. Returns how many it took. */
  async function tick() {
    const claimed = await claim(CLAIM_BATCH);
    await Promise.all(
      claimed.map(({ id }) =>
        // A database failure leaves the run RUNNING; it is taken back once its lock expires.
        advance(id).catch((err: unknown) => deps.onError(err, `workflow execution ${id}`)),
      ),
    );
    return claimed.length;
  }

  let wake: (() => void) | undefined;
  const due = (executionId: string) => {
    wake?.();
    options.onDue?.(executionId);
  };

  return {
    tick,

    /**
     * Claims one run if it is due and advances it until it ends, fails or waits. Returns when it is
     * next due if it waits on a timer (ISO string), else null. A job queue calls this per run.
     */
    async runOne(executionId: string): Promise<string | null> {
      const [claimed] = await claim(1, executionId);
      if (!claimed) return null;
      await advance(executionId).catch((err: unknown) => deps.onError(err, `workflow execution ${executionId}`));
      const after = await prisma.workflowExecution.findUnique({ where: { id: executionId }, select: { status: true, runAt: true } });
      return after?.status === "WAITING" && after.runAt ? after.runAt.toISOString() : null;
    },

    /** Ids of runs that are due, without claiming them: for a sweep that hands them to a job queue. */
    async dueRuns(limit: number) {
      const rows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT x.id FROM "WorkflowExecution" x JOIN "Workflow" w ON w.id = x."workflowId"
        WHERE ${DUE} ORDER BY x."runAt" LIMIT ${limit}`;
      return rows.map((r) => r.id);
    },

    /** Starts a run of the workflow's published version. The caller has authorized `scope`. */
    async start(scope: Scope, workflowId: string, input: Record<string, unknown>, startedBy: string) {
      const workflow = await prisma.workflow.findFirst({ where: { id: workflowId, ...scope, deletedAt: null }, include: { publishedVersion: true } });
      if (!workflow) throw new WorkflowStartError("Workflow not found", 404);
      if (workflow.status !== "ACTIVE" || !workflow.publishedVersion)
        throw new WorkflowStartError(workflow.status === "PAUSED" ? "This workflow is paused" : "Publish this workflow before running it");
      const definition = workflowDefinitionSchema.parse(workflow.publishedVersion.definition);
      const trigger = definition.nodes.find((n) => n.type === "trigger");
      if (!trigger) throw new WorkflowStartError("The published version has no trigger");
      const execution = await prisma.workflowExecution.create({
        data: {
          ...scope,
          workflowId,
          versionId: workflow.publishedVersion.id,
          input: input as Json,
          currentNodeId: trigger.id,
          startedBy,
        },
      });
      due(execution.id);
      return execution;
    },

    /** Runs a failed execution again from the step that failed. False if it is not failed. */
    async retry(scope: Scope, executionId: string) {
      const { count } = await prisma.workflowExecution.updateMany({
        where: { id: executionId, ...scope, status: "FAILED", workflow: { deletedAt: null } },
        data: { status: "QUEUED", runAt: new Date(), error: null, finishedAt: null },
      });
      if (count > 0) due(executionId);
      return count > 0;
    },

    /** Fails every run of the workflow still in progress (queued, running or waiting). Returns how many. */
    async stopRuns(scope: Scope, workflowId: string, reason: string) {
      const { count } = await prisma.workflowExecution.updateMany({
        where: { workflowId, ...scope, status: { in: ["QUEUED", "RUNNING", "WAITING"] } },
        data: { status: "FAILED", error: reason, runAt: null, lockedUntil: null, finishedAt: new Date() },
      });
      return count;
    },

    /** Continues a run held by a Human Handoff step. False if it is not waiting for a person. */
    async resume(scope: Scope, executionId: string, userId: string) {
      const execution = await prisma.workflowExecution.findFirst({ where: { id: executionId, ...scope, status: "WAITING", runAt: null } });
      if (!execution?.currentNodeId) return false;
      const step = await prisma.workflowStepExecution.findFirst({
        where: { executionId, nodeId: execution.currentNodeId, status: "WAITING", nodeType: "human_handoff" },
        orderBy: { attempt: "desc" },
      });
      if (!step) return false;
      const state = { ...(step.state as Record<string, unknown> | null), resumedBy: userId, resumedAt: new Date().toISOString() };
      const [, { count }] = await prisma.$transaction([
        prisma.workflowStepExecution.update({ where: { id: step.id }, data: { state } }),
        prisma.workflowExecution.updateMany({ where: { id: executionId, status: "WAITING", runAt: null }, data: { status: "QUEUED", runAt: new Date() } }),
      ]);
      if (count > 0) due(executionId);
      return count > 0;
    },

    /** Polls for due runs every `intervalMs` (sooner when a run is started). Returns stop(). */
    startRunner(intervalMs = 1000) {
      let stopped = false;
      const loop = async () => {
        while (!stopped) {
          const busy = await tick().catch((err: unknown) => {
            deps.onError(err, "workflow runner");
            return 0;
          });
          if (busy > 0) continue;
          const nap = new AbortController();
          wake = () => nap.abort();
          await sleep(intervalMs, undefined, { signal: nap.signal }).catch(() => {});
        }
      };
      const running = loop();
      return async () => {
        stopped = true;
        wake?.();
        await running;
      };
    },
  };
}

export type WorkflowEngine = ReturnType<typeof createWorkflowEngine>;
