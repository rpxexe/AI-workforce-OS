import { Readable } from "node:stream";
import { runTurn, toMessage } from "@workforce/agent-runtime";
import type { AIProvider, EmbeddingProvider } from "@workforce/ai-provider";
import { prisma } from "@workforce/database";
import type { MemoryService } from "@workforce/memory";
import { toolRegistry, type ToolExecutor } from "@workforce/tools";
import {
  sendMessageSchema,
  type ChatStreamEvent,
  type ConversationDetail,
  type ConversationSummary,
} from "@workforce/shared";
import type { FastifyInstance } from "fastify";
import { guards, httpError, type Authenticate } from "./auth.ts";
import { configOf, employeeParams, within } from "./employees.ts";

const conversationParams = employeeParams.extend({ conversationId: employeeParams.shape.id });

const toSummary = (c: { id: string; title: string; updatedAt: Date }): ConversationSummary => ({
  id: c.id,
  title: c.title,
  updatedAt: c.updatedAt.toISOString(),
});

const frame = (event: ChatStreamEvent) => `data: ${JSON.stringify(event)}\n\n`;

/**
 * Test chat for an AI employee. This file only authorizes the caller and turns the runtime's
 * events into a stream; the conversation itself is run and stored by `@workforce/agent-runtime`.
 */
export function conversationRoutes(
  app: FastifyInstance,
  authenticate: Authenticate,
  ai: {
    provider: () => AIProvider;
    embedder: () => EmbeddingProvider;
    memory: (provider: AIProvider, timeoutMs: number) => MemoryService;
    tools: ToolExecutor;
    timeoutMs: number;
  },
) {
  const { member, admin, inWorkspace } = guards(authenticate);
  const base = "/workspaces/:workspaceId/employees/:id";

  app.get(`${base}/conversations`, async (req): Promise<ConversationSummary[]> => {
    const { workspaceId, id } = employeeParams.parse(req.params);
    const scope = await inWorkspace(member(req), workspaceId);
    const conversations = await prisma.conversation.findMany({
      where: { employeeId: id, ...within(scope) },
      orderBy: { updatedAt: "desc" },
      // shortcut: newest 50 only, add a cursor when people need older test chats
      take: 50,
    });
    return conversations.map(toSummary);
  });

  app.get(`${base}/conversations/:conversationId`, async (req): Promise<ConversationDetail> => {
    const { workspaceId, id, conversationId } = conversationParams.parse(req.params);
    const scope = await inWorkspace(member(req), workspaceId);
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, employeeId: id, ...within(scope) },
      include: {
        messages: { orderBy: { createdAt: "asc" } },
        customer: { select: { customer: { select: { externalId: true } } } },
      },
    });
    if (!conversation) throw httpError(404, "Conversation not found");
    return {
      ...toSummary(conversation),
      messages: conversation.messages.map(toMessage),
      customer: conversation.customer?.customer.externalId ?? null,
    };
  });

  // Answers with server-sent events (`ChatStreamEvent`). Everything that can be refused is
  // refused before the stream opens, so a 4xx is still a normal JSON error.
  app.post(`${base}/messages`, async (req, reply) => {
    const { workspaceId, id } = employeeParams.parse(req.params);
    const scope = await inWorkspace(admin(req), workspaceId);
    const { conversationId, message, customer: externalId } = sendMessageSchema.parse(req.body);

    // Test chat talks to the latest version, published or not: that is what is being tested.
    const latest = await prisma.aiEmployeeVersion.findFirst({
      where: { employee: { id, ...within(scope) } },
      orderBy: { number: "desc" },
      include: {
        employee: {
          select: { status: true, knowledgeSources: { select: { sourceId: true } }, tools: { select: { tool: true } } },
        },
      },
    });
    if (!latest) throw httpError(404, "Employee not found");
    if (latest.employee.status === "ARCHIVED") throw httpError(409, "Restore this employee before testing it");
    // A conversation keeps the customer it started with.
    let customerId: string | undefined;
    if (conversationId) {
      const conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, employeeId: id, ...within(scope) },
        select: { customer: { select: { customerId: true } } },
      });
      if (!conversation) throw httpError(404, "Conversation not found");
      customerId = conversation.customer?.customerId;
    }

    const sourceIds = latest.employee.knowledgeSources.map((k) => k.sourceId);
    // The model is only told about granted tools; the executor checks the grant again on every call.
    const toolSpecs = toolRegistry.specs(latest.employee.tools.map((t) => t.tool));
    let provider: AIProvider;
    let knowledge: { embedder: EmbeddingProvider; sourceIds: string[] } | undefined;
    try {
      provider = ai.provider();
      // The embedder is only needed, and only has to be configured, when knowledge is attached.
      if (sourceIds.length > 0) knowledge = { embedder: ai.embedder(), sourceIds };
    } catch (err) {
      req.log.error(err, "AI provider is misconfigured");
      throw httpError(503, "The AI provider is not configured correctly on the server.");
    }

    const memory = ai.memory(provider, ai.timeoutMs);
    if (!conversationId && externalId) customerId = await memory.identify(scope, externalId);

    // Stop paying for a reply nobody will read when the browser goes away.
    const gone = new AbortController();
    reply.raw.on("close", () => gone.abort());

    const turn = runTurn({
      provider,
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      employeeId: id,
      userId: scope.userId,
      employee: configOf(latest),
      employeeVersion: latest.number,
      conversationId,
      knowledge,
      customer: customerId
        ? { id: customerId, memory, onError: (err) => req.log.error(err, "Updating customer memory failed") }
        : undefined,
      tools: toolSpecs.length > 0 ? { executor: ai.tools, specs: toolSpecs } : undefined,
      channel: "test",
      userMessage: message,
      timeoutMs: ai.timeoutMs,
      signal: gone.signal,
    });
    const events = async function* () {
      for await (const event of turn) {
        if (event.type !== "error") yield frame(event);
        else {
          req.log.error({ err: event.cause, kind: event.kind }, "AI turn failed");
          yield frame({ type: "error", error: event.message });
        }
      }
    };
    return reply
      .header("content-type", "text/event-stream")
      .header("cache-control", "no-cache")
      .send(Readable.from(events()));
  });
}
