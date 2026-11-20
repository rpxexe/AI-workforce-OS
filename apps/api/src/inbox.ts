// The human agents' side of a conversation: the inbox, taking over and handing back, replying to the
// customer on the conversation's own channel, the AI Copilot, and handoff analytics.
//
// Agents are organization members, not only admins: answering customers is their job. The AI stops
// answering a conversation in WAITING_FOR_HUMAN or HUMAN_ACTIVE (runTurn checks); only returning it
// to the AI (or resolving and reopening it) lets it answer again.
import { errorMessage, startHandoff, suggest, toMessage, toSuggestion } from "@workforce/agent-runtime";
import type { AIProvider, EmbeddingProvider } from "@workforce/ai-provider";
import { prisma, type Prisma } from "@workforce/database";
import {
  agentMessageSchema,
  analyticsQuerySchema,
  conversationActionSchema,
  EVALUATION_CHANNEL,
  inboxQuerySchema,
  INBOX_VIEWS,
  type ConversationStatus,
  type DurationStats,
  type HandoffAnalytics,
  type HandoffRecord,
  type HandoffTrigger,
  type InboxConversation,
  type InboxItem,
  type InboxResponse,
  type InboxView,
  toTransferRecord,
} from "@workforce/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { guards, httpError, type Authenticate } from "./auth.ts";
import type { Ai, ChannelService } from "./channels/service.ts";
import { configOf, within } from "./employees.ts";

const workspaceParams = z.object({ workspaceId: z.string().min(1) });
const conversationParams = workspaceParams.extend({ conversationId: z.string().min(1) });

/** Channels an agent's message can reach the customer on. Calls are not transferred; workflow conversations have no customer line. */
const REPLY_CHANNELS = ["test", "web_chat", "whatsapp", "email"];
const WITH_PEOPLE: ConversationStatus[] = ["WAITING_FOR_HUMAN", "HUMAN_ACTIVE"];
/** Regression replays are not customer conversations: no inbox, no analytics. */
const REAL = { channel: { not: EVALUATION_CHANNEL } } satisfies Prisma.ConversationWhereInput;

const viewWhere = (view: InboxView, userId: string): Prisma.ConversationWhereInput =>
  ({
    queue: { status: "WAITING_FOR_HUMAN", assignedTo: null },
    mine: { assignedTo: userId, status: { in: WITH_PEOPLE } },
    waiting: { status: "WAITING_FOR_HUMAN" },
    human_active: { status: "HUMAN_ACTIVE" },
    ai_active: { status: "AI_ACTIVE" },
    reopened: { status: "REOPENED" },
    resolved: { status: "RESOLVED" },
    all: {},
  })[view] as Prisma.ConversationWhereInput;

const listInclude = {
  employee: {
    select: { id: true, publishedVersion: { select: { name: true } }, versions: { orderBy: { number: "desc" }, take: 1, select: { name: true } } },
  },
  customer: { select: { customer: { select: { id: true, externalId: true, profile: { select: { name: true } } } } } },
} satisfies Prisma.ConversationInclude;

type ListRow = Prisma.ConversationGetPayload<{ include: typeof listInclude }>;

const base = (c: ListRow) => ({
  id: c.id,
  title: c.title,
  channel: c.channel,
  status: c.status,
  assignedTo: c.assignedTo,
  employee: { id: c.employee.id, name: c.employee.publishedVersion?.name ?? c.employee.versions[0]?.name ?? "Employee" },
  customer: c.customer
    ? { id: c.customer.customer.id, externalId: c.customer.customer.externalId, name: c.customer.customer.profile?.name ?? null }
    : null,
  updatedAt: c.updatedAt.toISOString(),
});

const toHandoff = (h: Prisma.HandoffGetPayload<object>): HandoffRecord => ({
  id: h.id,
  trigger: h.trigger as HandoffTrigger,
  reason: h.reason,
  assignedTo: h.assignedTo,
  requestedAt: h.requestedAt.toISOString(),
  acceptedAt: h.acceptedAt?.toISOString() ?? null,
  firstResponseAt: h.firstResponseAt?.toISOString() ?? null,
  endedAt: h.endedAt?.toISOString() ?? null,
  outcome: h.outcome as HandoffRecord["outcome"],
});

/** Count, average, median and 90th percentile of durations in ms. */
export function stats(values: number[]): DurationStats {
  if (values.length === 0) return { count: 0, average: null, median: null, p90: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? null;
  return { count: sorted.length, average: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length), median: at(0.5), p90: at(0.9) };
}

const between = (from: Date, to: Date | null) => (to ? to.getTime() - from.getTime() : null);

export function inboxRoutes(app: FastifyInstance, authenticate: Authenticate, ai: Ai, channels: ChannelService) {
  const { member, inWorkspace } = guards(authenticate);
  const conversationPath = "/workspaces/:workspaceId/conversations/:conversationId";

  const scoped = async (req: Parameters<typeof member>[0]) => {
    const { workspaceId, conversationId } = conversationParams.parse(req.params);
    const scope = await inWorkspace(member(req), workspaceId);
    const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, ...within(scope) }, include: listInclude });
    if (!conversation) throw httpError(404, "Conversation not found");
    return { scope, conversation };
  };

  const detail = async (id: string): Promise<InboxConversation> => {
    const transfers = prisma.callTransfer.findMany({ where: { conversationId: id }, orderBy: { createdAt: "asc" } });
    const c = await prisma.conversation.findUniqueOrThrow({
      where: { id },
      include: {
        ...listInclude,
        // shortcut: the newest 500 messages; page older ones when conversations get that long
        messages: { orderBy: { createdAt: "desc" }, take: 500 },
        handoffs: { orderBy: { requestedAt: "asc" } },
        suggestions: { orderBy: { createdAt: "desc" }, take: 10 },
      },
    });
    return {
      ...base(c),
      messages: c.messages.reverse().map(toMessage),
      handoffs: c.handoffs.map(toHandoff),
      suggestions: c.suggestions.map(toSuggestion),
      transfers: (await transfers).map(toTransferRecord),
      canReply: REPLY_CHANNELS.includes(c.channel) && (c.channel === "test" || c.customer !== null),
    };
  };

  app.get("/workspaces/:workspaceId/inbox", async (req): Promise<InboxResponse> => {
    const { workspaceId } = workspaceParams.parse(req.params);
    const scope = await inWorkspace(member(req), workspaceId);
    const { view, employeeId } = inboxQuerySchema.parse(req.query);
    const where = { ...within(scope), ...REAL, ...(employeeId && { employeeId }) };
    const [rows, byStatus, queue, mine] = await Promise.all([
      prisma.conversation.findMany({
        where: { ...where, ...viewWhere(view, scope.userId) },
        // The queue serves whoever has waited longest first.
        orderBy: { updatedAt: view === "queue" ? "asc" : "desc" },
        // shortcut: newest 100 per view, add a cursor when inboxes grow past that
        take: 100,
        include: {
          ...listInclude,
          messages: { orderBy: { createdAt: "desc" }, take: 1, select: { role: true, content: true, createdAt: true } },
          handoffs: { where: { endedAt: null }, orderBy: { requestedAt: "desc" }, take: 1, select: { trigger: true, reason: true, requestedAt: true } },
        },
      }),
      prisma.conversation.groupBy({ by: ["status"], where, _count: true }),
      prisma.conversation.count({ where: { ...where, ...viewWhere("queue", scope.userId) } }),
      prisma.conversation.count({ where: { ...where, ...viewWhere("mine", scope.userId) } }),
    ]);
    const count = (s: ConversationStatus) => byStatus.find((g) => g.status === s)?._count ?? 0;
    const counts = Object.fromEntries(INBOX_VIEWS.map((v) => [v, 0])) as Record<InboxView, number>;
    Object.assign(counts, {
      queue,
      mine,
      waiting: count("WAITING_FOR_HUMAN"),
      human_active: count("HUMAN_ACTIVE"),
      ai_active: count("AI_ACTIVE"),
      reopened: count("REOPENED"),
      resolved: count("RESOLVED"),
      all: byStatus.reduce((sum, g) => sum + g._count, 0),
    });
    const items = rows.map((c): InboxItem => {
      const last = c.messages[0];
      const open = c.handoffs[0];
      return {
        ...base(c),
        lastMessage: last ? { role: last.role, content: last.content.slice(0, 200), createdAt: last.createdAt.toISOString() } : null,
        handoff: open ? { trigger: open.trigger as HandoffTrigger, reason: open.reason, requestedAt: open.requestedAt.toISOString() } : null,
      };
    });
    return { items, counts };
  });

  app.get(conversationPath, async (req) => {
    const { conversation } = await scoped(req);
    return detail(conversation.id);
  });

  // Take over, assign, hand back to the AI, resolve, reopen. Each moves only from the states it names,
  // in one statement, so two agents acting at once cannot both win.
  app.patch(conversationPath, async (req) => {
    const { scope, conversation } = await scoped(req);
    const body = conversationActionSchema.parse(req.body);
    const now = new Date();
    const where = { id: conversation.id, ...within(scope) };
    const conflict = () => httpError(409, "Someone else changed this conversation. Reload and try again.");
    const withPeople = WITH_PEOPLE.includes(conversation.status);

    switch (body.action) {
      case "take_over":
      case "assign": {
        const assignedTo = body.action === "take_over" ? scope.userId : body.userId;
        const accept = body.action === "take_over";
        if (!withPeople) {
          const reason = accept ? "Taken over from the inbox" : "Assigned from the inbox";
          if (!(await startHandoff(where, { trigger: "agent", reason }, { assignedTo, accept }))) throw conflict();
          break;
        }
        await prisma.$transaction(async (tx) => {
          const { count } = await tx.conversation.updateMany({
            where: { ...where, status: { in: WITH_PEOPLE } },
            // Unassigning puts it back in the queue, waiting.
            data: { assignedTo, ...(accept ? { status: "HUMAN_ACTIVE" } : assignedTo === null && { status: "WAITING_FOR_HUMAN" }) },
          });
          if (count === 0) throw conflict();
          await tx.handoff.updateMany({ where: { conversationId: conversation.id, endedAt: null }, data: { assignedTo } });
          if (accept) await tx.handoff.updateMany({ where: { conversationId: conversation.id, endedAt: null, acceptedAt: null }, data: { acceptedAt: now } });
        });
        break;
      }
      case "return_to_ai":
      case "resolve": {
        const from: ConversationStatus[] = body.action === "resolve" ? ["AI_ACTIVE", "REOPENED", ...WITH_PEOPLE] : WITH_PEOPLE;
        await prisma.$transaction(async (tx) => {
          const { count } = await tx.conversation.updateMany({
            where: { ...where, status: { in: from } },
            data:
              body.action === "resolve"
                ? { status: "RESOLVED", resolvedAt: now }
                : { status: "AI_ACTIVE", assignedTo: null, failedTurns: 0 },
          });
          if (count === 0) throw conflict();
          await tx.handoff.updateMany({
            where: { conversationId: conversation.id, endedAt: null },
            data: { endedAt: now, outcome: body.action === "resolve" ? "resolved" : "returned_to_ai" },
          });
        });
        break;
      }
      case "reopen": {
        const { count } = await prisma.conversation.updateMany({ where: { ...where, status: "RESOLVED" }, data: { status: "REOPENED", resolvedAt: null } });
        if (count === 0) throw conflict();
        break;
      }
    }
    return detail(conversation.id);
  });

  // A human agent's message. Sending takes the conversation over: the AI stays silent from now on.
  app.post(`${conversationPath}/messages`, async (req) => {
    const { scope, conversation } = await scoped(req);
    const { text, suggestionId } = agentMessageSchema.parse(req.body);
    if (!REPLY_CHANNELS.includes(conversation.channel))
      throw httpError(409, conversation.channel === "voice" ? "Phone calls cannot be continued by text. Call the customer back." : "This conversation has no customer to write to.");
    const customer = conversation.customer?.customer;
    if (!customer && conversation.channel !== "test") throw httpError(409, "This conversation has no customer to write to.");
    const where = { id: conversation.id, ...within(scope) };
    if (!WITH_PEOPLE.includes(conversation.status))
      await startHandoff(where, { trigger: "agent", reason: "An agent wrote to the customer" }, { assignedTo: scope.userId, accept: true });

    // Delivered before it is stored, so the conversation never shows a message the customer did not get.
    const error = await channels.deliverAgentMessage(
      {
        id: conversation.id,
        employeeId: conversation.employeeId,
        channel: conversation.channel,
        title: conversation.title,
        customerId: customer?.id ?? "",
        to: customer?.externalId ?? "",
        fromName: base(conversation).employee.name,
      },
      text,
    );
    if (error) throw httpError(502, `The message could not be sent: ${error}`);

    const now = new Date();
    await prisma.$transaction(async (tx) => {
      const message = await tx.conversationMessage.create({ data: { conversationId: conversation.id, role: "AGENT", content: text, authorId: scope.userId, createdAt: now } });
      await tx.conversation.update({ where: { id: conversation.id }, data: { status: "HUMAN_ACTIVE", updatedAt: now } });
      await tx.conversation.updateMany({ where: { id: conversation.id, assignedTo: null }, data: { assignedTo: scope.userId } });
      const open = { conversationId: conversation.id, endedAt: null };
      await tx.handoff.updateMany({ where: { ...open, firstResponseAt: null }, data: { firstResponseAt: now } });
      await tx.handoff.updateMany({ where: { ...open, acceptedAt: null }, data: { acceptedAt: now } });
      await tx.handoff.updateMany({ where: { ...open, assignedTo: null }, data: { assignedTo: scope.userId } });
      if (suggestionId) {
        const suggestion = await tx.copilotSuggestion.findFirst({ where: { id: suggestionId, conversationId: conversation.id }, select: { reply: true } });
        if (suggestion)
          await tx.copilotSuggestion.update({ where: { id: suggestionId }, data: { usedInMessageId: message.id, edited: suggestion.reply.trim() !== text } });
      }
    });
    return detail(conversation.id);
  });

  // The AI Copilot: a suggestion for the agent, stored apart from the conversation and never sent.
  app.post(`${conversationPath}/copilot`, async (req) => {
    const { scope, conversation } = await scoped(req);
    const employee = await prisma.aiEmployee.findUniqueOrThrow({
      where: { id: conversation.employeeId },
      include: { publishedVersion: true, versions: { orderBy: { number: "desc" }, take: 1 }, knowledgeSources: { select: { sourceId: true } } },
    });
    // Test chats talk to the latest version; everything else to the published one.
    const version = (conversation.channel === "test" ? null : employee.publishedVersion) ?? employee.versions[0];
    if (!version) throw httpError(404, "Employee not found");
    const sourceIds = employee.knowledgeSources.map((k) => k.sourceId);
    let provider: AIProvider;
    let knowledge: { embedder: EmbeddingProvider; sourceIds: string[] } | undefined;
    try {
      provider = ai.provider();
      if (sourceIds.length > 0) knowledge = { embedder: ai.embedder(), sourceIds };
    } catch (err) {
      req.log.error(err, "AI provider is misconfigured");
      throw httpError(503, "The AI provider is not configured correctly on the server.");
    }
    try {
      return await suggest({
        provider,
        ...within(scope),
        conversationId: conversation.id,
        requestedBy: scope.userId,
        employee: configOf(version),
        knowledge,
        memory: ai.memory(provider, ai.timeoutMs),
        timeoutMs: ai.timeoutMs,
      });
    } catch (err) {
      req.log.error(err, "Copilot failed");
      throw httpError(502, `The copilot could not answer: ${errorMessage(err)}`);
    }
  });

  app.get("/workspaces/:workspaceId/handoffs/analytics", async (req): Promise<HandoffAnalytics> => {
    const { workspaceId } = workspaceParams.parse(req.params);
    const scope = await inWorkspace(member(req), workspaceId);
    const { days } = analyticsQuerySchema.parse(req.query);
    const since = new Date(Date.now() - days * 86_400_000);
    const tenant = { ...within(scope), ...REAL };
    const [active, handoffs, queue, assigned, humanActive, suggestionsTotal, suggestionsUsed, replies] = await Promise.all([
      prisma.conversation.count({ where: { ...tenant, updatedAt: { gte: since } } }),
      // shortcut: the newest 10,000 handoffs of the period; aggregate in SQL when a workspace has more
      prisma.handoff.findMany({ where: { ...within(scope), conversation: REAL, requestedAt: { gte: since } }, orderBy: { requestedAt: "desc" }, take: 10_000 }),
      prisma.conversation.count({ where: { ...tenant, status: "WAITING_FOR_HUMAN", assignedTo: null } }),
      prisma.conversation.count({ where: { ...tenant, status: "WAITING_FOR_HUMAN", assignedTo: { not: null } } }),
      prisma.conversation.count({ where: { ...tenant, status: "HUMAN_ACTIVE" } }),
      prisma.copilotSuggestion.count({ where: { ...within(scope), createdAt: { gte: since } } }),
      prisma.copilotSuggestion.count({ where: { ...within(scope), createdAt: { gte: since }, usedInMessageId: { not: null } } }),
      // Reply time: from a customer's message to the reply that follows it, by who replied.
      prisma.$queryRaw<{ role: string; gaps: number[] }[]>`
        SELECT role::text AS role, array_agg(gap) AS gaps FROM (
          SELECT m.role, LAG(m.role) OVER w AS previous,
                 EXTRACT(EPOCH FROM (m."createdAt" - LAG(m."createdAt") OVER w)) * 1000 AS gap
          FROM "ConversationMessage" m JOIN "Conversation" c ON c.id = m."conversationId"
          WHERE c."organizationId" = ${scope.organizationId} AND c."workspaceId" = ${scope.workspaceId} AND m."createdAt" >= ${since} AND c.channel <> ${EVALUATION_CHANNEL}
          WINDOW w AS (PARTITION BY m."conversationId" ORDER BY m."createdAt")
        ) t
        WHERE previous = 'USER' AND role IN ('ASSISTANT', 'AGENT')
        GROUP BY role`,
    ]);
    const gaps = (role: string) => (replies.find((r) => r.role === role)?.gaps ?? []).map(Number);
    const durations = (pick: (h: (typeof handoffs)[number]) => number | null, list = handoffs) =>
      stats(list.map(pick).filter((d): d is number => d !== null));
    const agents = [...new Set(handoffs.map((h) => h.assignedTo).filter((a) => a !== null))];
    return {
      days,
      conversations: active,
      handoffs: handoffs.length,
      handoffRate: active > 0 ? new Set(handoffs.map((h) => h.conversationId)).size / active : null,
      byTrigger: [...new Set(handoffs.map((h) => h.trigger as HandoffTrigger))]
        .map((trigger) => ({ trigger, count: handoffs.filter((h) => h.trigger === trigger).length }))
        .sort((a, b) => b.count - a.count),
      outcomes: {
        resolved: handoffs.filter((h) => h.outcome === "resolved").length,
        returnedToAi: handoffs.filter((h) => h.outcome === "returned_to_ai").length,
        open: handoffs.filter((h) => h.endedAt === null).length,
      },
      open: { queue, assigned, humanActive },
      timeToAccept: durations((h) => between(h.requestedAt, h.acceptedAt)),
      timeToFirstResponse: durations((h) => between(h.requestedAt, h.firstResponseAt)),
      timeToResolve: durations((h) => (h.outcome === "resolved" ? between(h.requestedAt, h.endedAt) : null)),
      replyTime: { ai: stats(gaps("ASSISTANT")), human: stats(gaps("AGENT")) },
      byAgent: agents
        .map((agentId) => {
          const mine = handoffs.filter((h) => h.assignedTo === agentId);
          return {
            agentId,
            handoffs: mine.length,
            resolved: mine.filter((h) => h.outcome === "resolved").length,
            firstResponse: durations((h) => between(h.requestedAt, h.firstResponseAt), mine),
          };
        })
        .sort((a, b) => b.handoffs - a.handoffs),
      suggestions: { total: suggestionsTotal, used: suggestionsUsed },
    };
  });
}
