// Phase 17: the public API (/v1). Routes, scopes and shapes come from PUBLIC_ROUTES (packages/shared/src/public-api.ts);
// this file only implements each operation. Every request: API key -> scope -> validated input -> handler -> the
// response parsed with the route's schema (unknown fields dropped) -> sent. Errors use the public error format.
import { Readable } from "node:stream";
import { configOf, runTurn } from "@workforce/agent-runtime";
import type { AIProvider, EmbeddingProvider, Route } from "@workforce/ai-provider";
import { prisma, type Prisma } from "@workforce/database";
import { retrieve } from "@workforce/knowledge";
import { factWrites, PROFILE_KEYS, validFact, type MemoryService } from "@workforce/memory";
import {
  defaultEmployeeConfig,
  employeeConfigSchema,
  EVALUATION_CHANNEL,
  normalizeCustomerId,
  openApiDocument,
  PUBLIC_ROUTES,
  type ApiError,
  type OperationId,
  type OperationInput,
  type OperationResult,
  type EmployeeConfig,
  type PublicErrorBody,
  type PublicRoutes,
  type StreamEvent,
  type UsageLimiter,
} from "@workforce/shared";
import { toolRegistry, type ToolExecutor } from "@workforce/tools";
import { WorkflowStartError, type WorkflowEngine } from "@workforce/workflows";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import type { HandoffNotice } from "@workforce/agent-runtime";
import { httpError } from "../auth.ts";
import type { EmployeeActions, Scope } from "../employees.ts";
import { resolveConversation } from "../inbox.ts";
import { liveEmployee } from "../channels/service.ts";
import { analyticsReport } from "../reports.ts";
import { verifyKey, type KeyScope } from "./keys.ts";
import {
  conversationInclude,
  employeeInclude,
  executionInclude,
  toConversation,
  toCustomer,
  toEmployee,
  toExecution,
  toMessage,
  toToolExecution,
  toWorkflow,
  workflowInclude,
} from "./serialize.ts";

/** The channel name of conversations started through the API. */
export const API_CHANNEL = "api";
const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;

type Deps = {
  ai: {
    provider: (route: Route) => AIProvider;
    embedder: () => EmbeddingProvider;
    memory: (scope: { organizationId: string; workspaceId: string }) => MemoryService;
    tools: ToolExecutor;
    timeoutMs: number;
    onHandoff?: (notice: HandoffNotice) => void;
    planLimits?: UsageLimiter;
  };
  engine: Pick<WorkflowEngine, "start">;
  employees: Pick<EmployeeActions, "create" | "saveVersion" | "publish" | "latestVersion">;
  knowledge: { uploadDocument: (scope: Scope, sourceId: string, name: string, bytes: Buffer, log: FastifyRequest["log"]) => Promise<{ id: string }> };
};
type Context = { key: KeyScope; tenant: { organizationId: string; workspaceId: string }; req: FastifyRequest; /** Aborted when the caller hangs up. */ signal: AbortSignal };
type Handlers = {
  [K in OperationId]: (
    input: OperationInput<K>,
    ctx: Context,
  ) => PublicRoutes[K] extends { stream: true } ? Promise<AsyncIterable<OperationResult<K>>> : Promise<OperationResult<K>>;
};

const TYPES: Record<number, string> = {
  400: "invalid_request",
  401: "authentication_failed",
  402: "limit_reached",
  403: "permission_denied",
  404: "not_found",
  409: "conflict",
  413: "invalid_request",
  422: "invalid_request",
  429: "rate_limited",
};

/** One page: `limit + 1` rows were read, so a full extra row means there is a next page. */
const pageOf = <R extends { id: string }, T>(rows: R[], limit: number, map: (row: R) => T) => ({
  data: rows.slice(0, limit).map(map),
  nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
});
const paged = (q: { limit: number; cursor?: string }) => ({
  take: q.limit + 1,
  ...(q.cursor && { cursor: { id: q.cursor }, skip: 1 }),
  orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
});

const notFound = (what: string) => httpError(404, `${what} not found`);

/** Who acts for an API request, in the shape internal actions take: the key stands in for a signed-in user. */
const actorOf = (ctx: Context): Scope => ({ ...ctx.tenant, userId: `api:${ctx.key.id}`, organizationName: ctx.tenant.organizationId, role: null });

/** Public field names for the internal ones in validation issues. */
const PUBLIC_PATHS: Record<string, string> = { systemInstructions: "instructions", "workingHours.timezone": "timeZone" };
const checkConfig = (config: EmployeeConfig) => {
  const parsed = employeeConfigSchema.safeParse(config);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => ({ path: PUBLIC_PATHS[i.path.join(".")] ?? i.path.join("."), message: i.message }));
  throw Object.assign(httpError(400, "Validation failed"), { issues });
};

const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === "P2002";

function handlers({ ai, engine, employees, knowledge }: Deps): Handlers {
  const findEmployee = async (id: string, tenant: Context["tenant"]) => {
    const employee = await prisma.aiEmployee.findFirst({ where: { id, ...tenant }, include: employeeInclude });
    if (!employee) throw notFound("Employee");
    return employee;
  };

  /**
   * Like a channel: the published version (or a rollout's candidate for this customer) answers, with its knowledge, tools,
   * memory, handoff rules and plan limits. Everything that can be refused is refused here, before any event; the events
   * follow as the reply is written.
   */
  const startTurn = async (employeeId: string, body: OperationInput<"sendMessage">["body"], { key, tenant, req, signal }: Context) => {
    const employee = await prisma.aiEmployee.findFirst({ where: { id: employeeId, ...tenant }, select: { id: true } });
    if (!employee) throw notFound("Employee");
    const memory = ai.memory(tenant);
    let customerId: string | undefined;
    let customerKey: string | undefined;
    if (body.conversationId) {
      const conversation = await prisma.conversation.findFirst({
        where: { id: body.conversationId, employeeId: employee.id, ...tenant, channel: API_CHANNEL },
        select: { customer: { select: { customer: { select: { id: true, externalId: true } } } } },
      });
      if (!conversation) throw notFound("Conversation");
      customerId = conversation.customer?.customer.id;
      customerKey = conversation.customer?.customer.externalId;
    } else if (body.customer) {
      // Keyed like every channel (+digits, lower-case email), so the same person is one customer across channels.
      customerKey = normalizeCustomerId(body.customer);
      customerId = await memory.identify(tenant, customerKey);
    }
    const live = await liveEmployee(employee.id, customerKey);
    if (!live) throw httpError(409, "This employee is not published, or is paused");
    let provider: AIProvider;
    let knowledgeInput: { embedder: EmbeddingProvider; sourceIds: string[] } | undefined;
    try {
      provider = ai.provider({ ...tenant, employeeId: employee.id, task: "chat" });
      if (live.sourceIds.length > 0) knowledgeInput = { embedder: ai.embedder(), sourceIds: live.sourceIds };
    } catch (err) {
      req.log.error(err, "AI provider is misconfigured");
      throw httpError(503, "The AI provider is not configured correctly on the server.");
    }
    const specs = toolRegistry.specs(live.tools);
    const turn = runTurn({
      provider,
      ...tenant,
      employeeId: employee.id,
      userId: `api:${key.id}`,
      employee: configOf(live.version),
      employeeVersion: live.version.number,
      conversationId: body.conversationId,
      knowledge: knowledgeInput,
      customer: customerId ? { id: customerId, memory, onError: (err) => req.log.error(err, "Updating customer memory failed") } : undefined,
      tools: specs.length > 0 ? { executor: ai.tools, specs } : undefined,
      channel: API_CHANNEL,
      userMessage: body.message,
      timeoutMs: ai.timeoutMs,
      signal,
      onHandoff: ai.onHandoff,
      planLimits: ai.planLimits,
    });
    return (async function* (): AsyncGenerator<StreamEvent> {
      for await (const event of turn) {
        if (event.type === "text") yield { type: "text", text: event.text };
        else if (event.type === "done") {
          const conversationId = event.conversation.id;
          const [message, reply] = event.messages;
          yield {
            type: "done",
            conversationId,
            status: "answered",
            handoff: Boolean(event.handoff),
            message: toMessage({ ...message, conversationId }),
            reply: toMessage({ ...reply, conversationId }),
          };
        } else if (event.type === "held") {
          const conversationId = event.conversation.id;
          yield { type: "done", conversationId, status: "held", handoff: false, message: toMessage({ ...event.message, conversationId }), reply: null };
        } else {
          req.log.error({ err: event.cause, kind: event.kind }, "API turn failed");
          yield { type: "error", error: { type: event.kind === "limit" ? "limit_reached" : "server_error", message: event.message } };
        }
      }
    })();
  };

  return {
    async listEmployees({ query }, { tenant }) {
      const rows = await prisma.aiEmployee.findMany({
        where: { ...tenant, ...(query.status && { status: query.status.toUpperCase() as "ACTIVE" }) },
        include: employeeInclude,
        ...paged(query),
      });
      return pageOf(rows, query.limit, toEmployee);
    },

    async getEmployee({ params }, { tenant }) {
      const employee = await prisma.aiEmployee.findFirst({ where: { id: params.id, ...tenant }, include: employeeInclude });
      if (!employee) throw notFound("Employee");
      return toEmployee(employee);
    },

    async createEmployee({ body }, ctx) {
      const config = checkConfig({
        ...defaultEmployeeConfig(body.timeZone),
        name: body.name,
        role: body.role,
        description: body.description,
        personality: body.personality,
        systemInstructions: body.instructions,
        goals: body.goals,
        language: body.language,
      });
      const created = await employees.create(actorOf(ctx), config);
      return toEmployee(await findEmployee(created.id, ctx.tenant));
    },

    async saveEmployeeVersion({ params, body }, ctx) {
      if (Object.keys(body).length === 0) throw httpError(400, "Send at least one field to change");
      const latest = configOf(await employees.latestVersion(actorOf(ctx), params.id));
      const config = checkConfig({
        ...latest,
        ...(body.name !== undefined && { name: body.name }),
        ...(body.role !== undefined && { role: body.role }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.personality !== undefined && { personality: body.personality }),
        ...(body.instructions !== undefined && { systemInstructions: body.instructions }),
        ...(body.goals !== undefined && { goals: body.goals }),
        ...(body.language !== undefined && { language: body.language }),
        ...(body.timeZone !== undefined && { workingHours: { ...latest.workingHours, timezone: body.timeZone } }),
      } as EmployeeConfig);
      await employees.saveVersion(actorOf(ctx), params.id, config);
      return toEmployee(await findEmployee(params.id, ctx.tenant));
    },

    async publishEmployee({ params, body }, ctx) {
      const version = body.version ?? (await employees.latestVersion(actorOf(ctx), params.id)).number;
      await employees.publish(actorOf(ctx), params.id, version);
      return toEmployee(await findEmployee(params.id, ctx.tenant));
    },

    async streamMessage({ params, body }, ctx) {
      return startTurn(params.id, body, ctx);
    },

    async sendMessage({ params, body }, ctx) {
      for await (const event of await startTurn(params.id, body, ctx)) {
        if (event.type === "done") {
          return { conversationId: event.conversationId, status: event.status, handoff: event.handoff, message: event.message, reply: event.reply };
        }
        if (event.type === "error") throw httpError(event.error.type === "limit_reached" ? 402 : 502, event.error.message);
      }
      throw httpError(502, "The employee did not answer");
    },

    async listConversations({ query }, { tenant }) {
      const rows = await prisma.conversation.findMany({
        where: {
          ...tenant,
          channel: query.channel ?? { not: EVALUATION_CHANNEL },
          ...(query.employeeId && { employeeId: query.employeeId }),
          ...(query.customerId && { customer: { customerId: query.customerId } }),
          ...(query.status && { status: query.status.toUpperCase() as "RESOLVED" }),
        },
        include: conversationInclude,
        ...paged(query),
      });
      return pageOf(rows, query.limit, toConversation);
    },

    async getConversation({ params }, { tenant }) {
      const conversation = await prisma.conversation.findFirst({
        where: { id: params.id, ...tenant, channel: { not: EVALUATION_CHANNEL } },
        include: { ...conversationInclude, messages: { orderBy: { createdAt: "asc" } } },
      });
      if (!conversation) throw notFound("Conversation");
      return { ...toConversation(conversation), messages: conversation.messages.map(toMessage) };
    },

    async resolveConversation({ params }, { tenant }) {
      const where = { id: params.id, ...tenant };
      const conversation = await prisma.conversation.findFirst({ where: { ...where, channel: { not: EVALUATION_CHANNEL } }, select: { status: true } });
      if (!conversation) throw notFound("Conversation");
      // Resolving a resolved conversation is not an error: the caller gets what it asked for.
      if (conversation.status !== "RESOLVED" && !(await resolveConversation(where))) throw httpError(409, "The conversation changed meanwhile. Try again.");
      return toConversation(await prisma.conversation.findUniqueOrThrow({ where: { id: params.id }, include: conversationInclude }));
    },

    async listCustomers({ query }, { tenant }) {
      const rows = await prisma.customer.findMany({
        where: { ...tenant, ...(query.externalId && { externalId: query.externalId }) },
        include: { profile: true },
        ...paged(query),
      });
      return pageOf(rows, query.limit, toCustomer);
    },

    async getCustomer({ params }, { tenant }) {
      const customer = await prisma.customer.findFirst({
        where: { id: params.id, ...tenant },
        include: { profile: true, memories: { orderBy: { updatedAt: "desc" } } },
      });
      if (!customer) throw notFound("Customer");
      return {
        ...toCustomer(customer),
        memories: customer.memories.map((m) => ({ key: m.key, category: m.category, value: m.value, confidence: m.confidence, updatedAt: m.updatedAt.toISOString() })),
      };
    },

    // The same validation as learned facts (secrets and card numbers refused), confidence 1, audited like a person's edit.
    async setCustomerMemory({ params, body }, ctx) {
      const customer = await prisma.customer.findFirst({ where: { id: params.id, ...ctx.tenant }, select: { id: true } });
      if (!customer) throw notFound("Customer");
      const existing = await prisma.customerMemory.findUnique({ where: { customerId_key: { customerId: customer.id, key: params.key } } });
      const fact = validFact({ category: body.category ?? existing?.category ?? "fact", key: params.key, value: body.value, confidence: 1 });
      if (!fact) throw Object.assign(httpError(400, "That fact cannot be stored (keys are snake_case; card numbers and secrets are refused)"), { issues: [{ path: "value", message: "Refused" }] });
      await prisma.$transaction([
        ...factWrites(customer.id, [fact], existing?.conversationId ?? null),
        prisma.customerAuditLog.create({
          data: { ...ctx.tenant, customerId: customer.id, action: "memory_edit", actorId: `api:${ctx.key.id}`, detail: { key: fact.key, via: "api" } },
        }),
      ]);
      const m = await prisma.customerMemory.findUniqueOrThrow({ where: { customerId_key: { customerId: customer.id, key: fact.key } } });
      return { key: m.key, category: m.category, value: m.value, confidence: m.confidence, updatedAt: m.updatedAt.toISOString() };
    },

    async deleteCustomerMemory({ params }, ctx) {
      const memory = await prisma.customerMemory.findFirst({ where: { key: params.key, customer: { id: params.id, ...ctx.tenant } } });
      if (!memory) throw notFound("Memory");
      const profileKey = memory.category === "identity" && (PROFILE_KEYS as readonly string[]).includes(memory.key);
      await prisma.$transaction([
        prisma.customerMemory.delete({ where: { id: memory.id } }),
        ...(profileKey ? [prisma.customerProfile.updateMany({ where: { customerId: memory.customerId }, data: { [memory.key]: null } })] : []),
        prisma.customerAuditLog.create({
          data: { ...ctx.tenant, customerId: memory.customerId, action: "memory_delete", actorId: `api:${ctx.key.id}`, detail: { key: memory.key, via: "api" } },
        }),
      ]);
      return { deleted: true as const };
    },

    async createKnowledgeSource({ body }, ctx) {
      try {
        const source = await prisma.knowledgeSource.create({ data: { ...ctx.tenant, name: body.name, description: body.description, createdBy: `api:${ctx.key.id}` } });
        return { id: source.id, name: source.name, description: source.description, documentCount: 0, createdAt: source.createdAt.toISOString() };
      } catch (err) {
        if (isUniqueViolation(err)) throw httpError(409, `A knowledge source named "${body.name}" already exists`);
        throw err;
      }
    },

    async uploadDocument({ params, body }, ctx) {
      if (!/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(body.contentBase64)) throw Object.assign(httpError(400, "contentBase64 is not base64"), { issues: [{ path: "contentBase64", message: "Not base64" }] });
      const { id } = await knowledge.uploadDocument(actorOf(ctx), params.id, body.name, Buffer.from(body.contentBase64, "base64"), ctx.req.log);
      const d = await prisma.knowledgeDocument.findUniqueOrThrow({ where: { id }, omit: { content: true } });
      return { id: d.id, name: d.name, kind: d.kind, status: d.status.toLowerCase() as "pending", error: d.error, chunkCount: d.chunkCount, createdAt: d.createdAt.toISOString() };
    },

    async listKnowledgeSources({ query }, { tenant }) {
      const rows = await prisma.knowledgeSource.findMany({ where: tenant, include: { _count: { select: { documents: true } } }, ...paged(query) });
      return pageOf(rows, query.limit, (s) => ({ id: s.id, name: s.name, description: s.description, documentCount: s._count.documents, createdAt: s.createdAt.toISOString() }));
    },

    async getKnowledgeSource({ params }, { tenant }) {
      const source = await prisma.knowledgeSource.findFirst({
        where: { id: params.id, ...tenant },
        include: { documents: { orderBy: { createdAt: "desc" }, omit: { content: true } } },
      });
      if (!source) throw notFound("Knowledge source");
      return {
        id: source.id,
        name: source.name,
        description: source.description,
        documentCount: source.documents.length,
        createdAt: source.createdAt.toISOString(),
        documents: source.documents.map((d) => ({
          id: d.id,
          name: d.name,
          kind: d.kind,
          status: d.status.toLowerCase() as "ready",
          error: d.error,
          chunkCount: d.chunkCount,
          createdAt: d.createdAt.toISOString(),
        })),
      };
    },

    async searchKnowledge({ body }, { tenant, req }) {
      // Ids are only a filter: retrieve still limits matches to this organization and workspace.
      const sources = await prisma.knowledgeSource.findMany({ where: { ...tenant, ...(body.sourceIds && { id: { in: body.sourceIds } }) }, select: { id: true } });
      let embedder: EmbeddingProvider;
      try {
        embedder = ai.embedder();
      } catch (err) {
        req.log.error(err, "Embedding provider is misconfigured");
        throw httpError(503, "The embedding provider is not configured correctly on the server.");
      }
      const matches = await retrieve({ ...tenant, sourceIds: sources.map((s) => s.id), query: body.query, embedder, limit: body.limit });
      return { data: matches };
    },

    async listWorkflows({ query }, { tenant }) {
      const rows = await prisma.workflow.findMany({ where: { ...tenant, deletedAt: null }, include: workflowInclude, ...paged(query) });
      return pageOf(rows, query.limit, toWorkflow);
    },

    async getWorkflow({ params }, { tenant }) {
      const workflow = await prisma.workflow.findFirst({ where: { id: params.id, ...tenant, deletedAt: null }, include: workflowInclude });
      if (!workflow) throw notFound("Workflow");
      return toWorkflow(workflow);
    },

    async startExecution({ params, body }, { key, tenant }) {
      const started = await engine.start(tenant, params.id, body.input, `api:${key.id}`).catch((err: unknown) => {
        throw err instanceof WorkflowStartError ? httpError(err.status, err.message) : err;
      });
      return toExecution(await prisma.workflowExecution.findUniqueOrThrow({ where: { id: started.id }, include: executionInclude }));
    },

    async listExecutions({ query }, { tenant }) {
      const rows = await prisma.workflowExecution.findMany({
        where: {
          ...tenant,
          ...(query.workflowId && { workflowId: query.workflowId }),
          ...(query.status && { status: query.status.toUpperCase() as "QUEUED" }),
        },
        include: executionInclude,
        ...paged(query),
      });
      return pageOf(rows, query.limit, toExecution);
    },

    async getExecution({ params }, { tenant }) {
      const execution = await prisma.workflowExecution.findFirst({
        where: { id: params.id, ...tenant },
        include: { ...executionInclude, steps: { orderBy: { startedAt: "asc" } } },
      });
      if (!execution) throw notFound("Execution");
      return {
        ...toExecution(execution),
        input: execution.input as Record<string, unknown>,
        steps: execution.steps.map((s) => ({
          id: s.id,
          nodeId: s.nodeId,
          nodeType: s.nodeType,
          attempt: s.attempt,
          status: s.status.toLowerCase() as "running",
          output: s.output,
          error: s.error,
          startedAt: s.startedAt.toISOString(),
          finishedAt: s.finishedAt?.toISOString() ?? null,
        })),
      };
    },

    async listTools() {
      const tools = toolRegistry.list();
      const specs = new Map(toolRegistry.specs(tools.map((t) => t.name)).map((s) => [s.name, s]));
      return { data: tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: specs.get(t.name)?.inputSchema ?? {} })) };
    },

    async listToolExecutions({ query }, { tenant }) {
      const rows = await prisma.toolExecution.findMany({
        where: { ...tenant, ...(query.employeeId && { employeeId: query.employeeId }), ...(query.conversationId && { conversationId: query.conversationId }) },
        ...paged(query),
      });
      return pageOf(rows, query.limit, toToolExecution);
    },

    async getAnalytics({ query }, { tenant }) {
      const from = new Date(`${query.from}T00:00:00Z`);
      const to = new Date(`${query.to}T00:00:00Z`);
      if (to <= from) throw httpError(400, "`to` must be after `from`");
      if (to.getTime() - from.getTime() > 366 * 86_400_000) throw httpError(400, "At most 366 days");
      const r = await analyticsReport(tenant.organizationId, tenant.workspaceId, from, to);
      const stats = (s: typeof r.latency.aiReply) => ({ count: s.count, averageMs: s.average, medianMs: s.median, p90Ms: s.p90 });
      return {
        from: r.from,
        to: r.to,
        conversations: r.conversations,
        messages: { customer: r.messages.customer, employee: r.messages.ai, agent: r.messages.agent },
        calls: r.calls,
        toolExecutions: r.toolExecutions.total,
        workflowExecutions: r.workflowExecutions.total,
        resolutions: r.resolutions,
        handoffs: r.escalations,
        replyLatency: stats(r.latency.aiReply),
        billedUsd: r.cost.billedUsd,
        quality: r.quality,
        daily: r.daily.map((d) => ({ date: d.date, conversations: d.conversations, messages: d.messages })),
      };
    },
  };
}

/**
 * Replays the first answer to a request carrying an Idempotency-Key (same workspace, 24 hours), so a client retrying
 * after a timeout does not send a message or start a run twice. A request that failed leaves nothing behind.
 */
async function idempotent(workspaceId: string, operation: string, key: string, run: () => Promise<unknown>) {
  const where = { workspaceId_key: { workspaceId, key } };
  for (let tries = 0; tries < 2; tries++) {
    const { count } = await prisma.apiIdempotency.createMany({ data: [{ workspaceId, key, operation }], skipDuplicates: true });
    if (count === 1) break;
    const earlier = await prisma.apiIdempotency.findUnique({ where });
    if (!earlier) continue;
    if (Date.now() - earlier.createdAt.getTime() > IDEMPOTENCY_TTL_MS) {
      await prisma.apiIdempotency.deleteMany({ where: { id: earlier.id } });
      continue;
    }
    if (earlier.operation !== operation) throw httpError(422, "This Idempotency-Key was used for another operation");
    if (earlier.status === null) throw httpError(409, "A request with this Idempotency-Key is still running");
    return { replayed: true, status: earlier.status, response: earlier.response };
  }
  try {
    const response = await run();
    await prisma.apiIdempotency.update({ where, data: { status: 200, response: response as Prisma.InputJsonValue } });
    return { replayed: false, response };
  } catch (err) {
    await prisma.apiIdempotency.deleteMany({ where: { workspaceId, key } });
    throw err;
  }
}

const idempotencyKey = z.string().trim().min(1).max(200).optional();

export function publicRoutes(app: FastifyInstance, deps: Deps) {
  const impl = handlers(deps);

  app.register(
    async (v1) => {
      v1.setErrorHandler((err: Error & { statusCode?: number; expose?: boolean; rate?: { resetSec: number } }, req, reply) => {
        if (err.rate) reply.header("retry-after", String(err.rate.resetSec));
        if (err instanceof ZodError) {
          const issues = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
          return reply.code(400).send({ error: { type: "invalid_request", message: "Validation failed", issues } } satisfies PublicErrorBody);
        }
        const status = err.statusCode ?? 500;
        if (status >= 500) req.log.error(err);
        const message = err.expose || status < 500 ? err.message : "Internal server error";
        // Field problems found outside Zod (a webhook URL that is private) keep their paths, as on the internal API.
        const issues = status === 400 ? (err as { issues?: ApiError["issues"] }).issues : undefined;
        const type = TYPES[status] ?? (status >= 500 ? "server_error" : "invalid_request");
        return reply.code(status).send({ error: { type, message, ...(issues && { issues }) } } satisfies PublicErrorBody);
      });
      // Support can find a request in the log by this id.
      v1.addHook("onRequest", async (req, reply) => {
        reply.header("request-id", req.id);
      });
      v1.setNotFoundHandler((req, reply) =>
        reply.code(404).send({ error: { type: "not_found", message: `No route ${req.method} ${req.url.split("?")[0]}` } } satisfies PublicErrorBody),
      );

      // The contract, public so tools and code generators can read it.
      v1.get("/openapi.json", async () => openApiDocument(process.env.PUBLIC_URL || undefined));

      for (const [operation, spec] of Object.entries(PUBLIC_ROUTES) as [OperationId, (typeof PUBLIC_ROUTES)[OperationId]][]) {
        const handler = impl[operation] as (input: unknown, ctx: Context) => Promise<unknown>;
        v1.route({
          method: spec.method,
          url: spec.path.replace(/^\/v1/, "").replace(/\{(\w+)\}/g, ":$1"),
          ...("bodyLimit" in spec && { bodyLimit: spec.bodyLimit }),
          handler: async (req, reply) => {
            const key = await verifyKey(req.headers.authorization, req.ip, req.log);
            reply.header("x-ratelimit-limit", String(key.rate.limit)).header("x-ratelimit-remaining", String(key.rate.remaining)).header("x-ratelimit-reset", String(key.rate.resetSec));
            if (!key.scopes.includes(spec.scope)) throw httpError(403, `This API key does not have the ${spec.scope} scope`);
            const input = {
              params: "params" in spec ? spec.params.parse(req.params) : undefined,
              query: "query" in spec ? spec.query.parse(req.query) : undefined,
              body: "body" in spec ? spec.body.parse(req.body ?? {}) : undefined,
            };
            // Stop paying for a reply nobody will read when the caller goes away.
            const gone = new AbortController();
            reply.raw.on("close", () => gone.abort());
            const ctx: Context = { key, tenant: { organizationId: key.organizationId, workspaceId: key.workspaceId }, req, signal: gone.signal };
            if ("stream" in spec) {
              const events = (await handler(input, ctx)) as AsyncIterable<unknown>;
              const frames = async function* () {
                for await (const event of events) yield `data: ${JSON.stringify(spec.response.parse(event))}\n\n`;
              };
              return reply.header("content-type", "text/event-stream").header("cache-control", "no-cache").send(Readable.from(frames()));
            }
            const run = async () => spec.response.parse(await handler(input, ctx));
            const status = "status" in spec ? spec.status : 200;
            const header = "idempotent" in spec ? idempotencyKey.parse(req.headers["idempotency-key"]) : undefined;
            if (!header) return reply.code(status).send(await run());
            const result = await idempotent(key.workspaceId, operation, header, run);
            if (result.replayed) reply.header("idempotent-replayed", "true");
            return reply.code(status).send(result.response);
          },
        });
      }
    },
    { prefix: "/v1" },
  );
}
