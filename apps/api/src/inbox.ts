// The human agents' side of a conversation: the inbox, taking over and handing back, replying to the
// customer on the conversation's own channel, the AI Copilot, and handoff analytics.
//
// Agents are organization members, not only admins: answering customers is their job. The AI stops
// answering a conversation in WAITING_FOR_HUMAN or HUMAN_ACTIVE (runTurn checks); only returning it
// to the AI (or resolving and reopening it) lets it answer again.
import type { LiveBus, Presence } from "./live.ts";
import { ANALYZER_VERSION, analyzeConversation, errorMessage, regionOf, startHandoff, suggest, toMessage, toSuggestion } from "@workforce/agent-runtime";
import type { AIProvider, EmbeddingProvider } from "@workforce/ai-provider";
import { Prisma, prisma } from "@workforce/database";
import {
  agentMessageSchema,
  agentTypingSchema,
  analyticsQuerySchema,
  conversationActionSchema,
  EVALUATION_CHANNEL,
  inboxQuerySchema,
  INBOX_VIEWS,
  REPLY_BANDS,
  RESOLUTIONS,
  SENTIMENTS,
  type ConversationStatus,
  type DetectedLanguage,
  type DurationStats,
  type EntityType,
  type HandoffAnalytics,
  type HandoffRecord,
  type HandoffTrigger,
  type InboxConversation,
  type InboxItem,
  type InboxResponse,
  type InboxView,
  type InsightsOverview,
  type Intent,
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
const REPLY_CHANNELS = ["test", "api", "web_chat", "whatsapp", "email"];
/** Channels whose callers read agents' messages from the conversation (test chat, the public API), so nothing is sent. */
const READ_BACK_CHANNELS = ["test", "api"];
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

const versionSelect = { name: true, language: true, workingHours: true } as const;
const listInclude = {
  employee: {
    select: { id: true, publishedVersion: { select: versionSelect }, versions: { orderBy: { number: "desc" }, take: 1, select: versionSelect } },
  },
  customer: { select: { customer: { select: { id: true, externalId: true, profile: { select: { name: true } } } } } },
} satisfies Prisma.ConversationInclude;

type ListRow = Prisma.ConversationGetPayload<{ include: typeof listInclude }>;

/** The business's operating context for the analyzer: region and time zone of the live (else latest) version. Never the customer's. */
const operating = (c: Pick<ListRow, "employee">) => {
  const v = c.employee.publishedVersion ?? c.employee.versions[0];
  const timezone = (v?.workingHours as { timezone?: string } | null)?.timezone ?? "UTC";
  return { timezone, region: v ? regionOf({ language: v.language, workingHours: { timezone } }) : null };
};

type Scope = { organizationId: string; workspaceId: string };

/**
 * Distinct conversations of the workspace (not evaluation replays) with at least one message in [from, to). Driven by the
 * workspace's messages of the period (index on the message's own tenant + createdAt), not by probing every conversation.
 */
export async function activeConversations(scope: Scope, from: Date, to?: Date) {
  // Distinct first (index-only), then each conversation once for the channel.
  const [row] = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (
      SELECT DISTINCT m."conversationId" FROM "ConversationMessage" m
      WHERE m."organizationId" = ${scope.organizationId} AND m."workspaceId" = ${scope.workspaceId}
        AND m."createdAt" >= ${from} ${to ? Prisma.sql`AND m."createdAt" < ${to}` : Prisma.empty}
    ) p JOIN "Conversation" c ON c.id = p."conversationId"
    WHERE c.channel <> ${EVALUATION_CHANNEL}`;
  return row?.n ?? 0;
}

/** Conversations (re)analyzed per insights read; the rest catch up on the following reads. */
const INSIGHT_BATCH = 500;
/**
 * The safety net behind the insights job: stores the analyzer's output for the period's conversations that have none
 * yet, or whose stored row is older than the conversation's last activity (updatedAt) or from an older ANALYZER_VERSION,
 * newest first and at most INSIGHT_BATCH per call. Returns how many it analyzed (normally only conversations still active).
 */
export async function refreshInsights(scope: Scope, since: Date) {
  const stale = await prisma.$queryRaw<{ id: string }[]>`
    SELECT c.id FROM "Conversation" c LEFT JOIN "ConversationInsight" i ON i."conversationId" = c.id
    WHERE c."organizationId" = ${scope.organizationId} AND c."workspaceId" = ${scope.workspaceId} AND c.channel <> ${EVALUATION_CHANNEL}
      AND c."updatedAt" >= ${since} AND (i.id IS NULL OR i."activityAt" < c."updatedAt" OR i."analyzerVersion" < ${ANALYZER_VERSION})
    ORDER BY c."updatedAt" DESC
    LIMIT ${INSIGHT_BATCH}`;
  return analyzeInsights(scope, stale.map((s) => s.id));
}

/**
 * Conversations that went quiet (no activity for `idleMs`, active in the last 3 days) with a missing or stale insight:
 * the insights sweep queues an insights/analyze job for each, like the evaluation sweep. `organizationId` keeps tests
 * to their own data.
 */
export async function quietInsights({ idleMs, limit = INSIGHT_BATCH, organizationId }: { idleMs: number; limit?: number; organizationId?: string }) {
  return prisma.$queryRaw<(Scope & { conversationId: string })[]>`
    SELECT c.id AS "conversationId", c."organizationId", c."workspaceId" FROM "Conversation" c
    LEFT JOIN "ConversationInsight" i ON i."conversationId" = c.id
    WHERE c.channel <> ${EVALUATION_CHANNEL} AND (${organizationId ?? null}::text IS NULL OR c."organizationId" = ${organizationId ?? null})
      AND c."updatedAt" <= ${new Date(Date.now() - idleMs)} AND c."updatedAt" > now() - interval '3 days'
      AND (i.id IS NULL OR i."activityAt" < c."updatedAt" OR i."analyzerVersion" < ${ANALYZER_VERSION})
    ORDER BY c."updatedAt" ASC
    LIMIT ${limit}`;
}

/** Runs the analyzer on these conversations of the workspace and upserts their ConversationInsight rows; the insights/analyze job. */
export async function analyzeInsights(scope: Scope, ids: string[]) {
  if (ids.length === 0) return 0;
  const rows = await prisma.conversation.findMany({
    where: { ...scope, ...REAL, id: { in: ids } },
    select: {
      id: true,
      status: true,
      employee: listInclude.employee,
      // The last 100 customer messages, as the analyzer has always been given.
      messages: { where: { role: "USER" }, orderBy: { createdAt: "desc" }, take: 100, select: { role: true, content: true, createdAt: true } },
      handoffs: { select: { trigger: true } },
      updatedAt: true,
    },
  });
  await prisma.$transaction(
    rows.map((c) => {
      const i = analyzeConversation({ messages: c.messages.reverse(), status: c.status, handoffs: c.handoffs, ...operating(c) });
      const data = {
        primaryLanguage: i.primaryLanguage,
        codeSwitchedMessages: i.codeSwitchedMessages,
        switches: i.switches,
        sentiment: i.sentiment,
        intent: i.intent,
        entityTypes: i.entities.map((e) => e.type),
        resolution: i.resolution,
        escalated: i.escalation.escalated,
        escalationSignals: i.escalation.signals.length,
        activityAt: c.updatedAt,
        analyzerVersion: ANALYZER_VERSION,
      };
      return prisma.conversationInsight.upsert({ where: { conversationId: c.id }, create: { ...scope, conversationId: c.id, ...data }, update: data });
    }),
  );
  return rows.length;
}

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

/** Resolves a conversation from any open state and ends its open handoff; false when it was already resolved. */
export async function resolveConversation(where: { id: string; organizationId: string; workspaceId: string }, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.conversation.updateMany({
      where: { ...where, status: { in: ["AI_ACTIVE", "REOPENED", ...WITH_PEOPLE] } },
      data: { status: "RESOLVED", resolvedAt: now },
    });
    if (count === 0) return false;
    await tx.handoff.updateMany({ where: { conversationId: where.id, endedAt: null }, data: { endedAt: now, outcome: "resolved" } });
    return true;
  });
}

export function inboxRoutes(
  app: FastifyInstance,
  authenticate: Authenticate,
  ai: Ai,
  channels: ChannelService,
  { live, presence }: { live: LiveBus; presence: Presence },
) {
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
    const messages = c.messages.reverse();
    return {
      ...base(c),
      messages: messages.map(toMessage),
      handoffs: c.handoffs.map(toHandoff),
      suggestions: c.suggestions.map(toSuggestion),
      transfers: (await transfers).map(toTransferRecord),
      canReply: REPLY_CHANNELS.includes(c.channel) && (READ_BACK_CHANNELS.includes(c.channel) || c.customer !== null),
      insight: analyzeConversation({ messages, status: c.status, handoffs: c.handoffs, ...operating(c) }),
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
      case "resolve":
        if (!(await resolveConversation(where, now))) throw conflict();
        break;
      case "return_to_ai": {
        await prisma.$transaction(async (tx) => {
          const { count } = await tx.conversation.updateMany({
            where: { ...where, status: { in: WITH_PEOPLE } },
            data: { status: "AI_ACTIVE", assignedTo: null, failedTurns: 0 },
          });
          if (count === 0) throw conflict();
          await tx.handoff.updateMany({ where: { conversationId: conversation.id, endedAt: null }, data: { endedAt: now, outcome: "returned_to_ai" } });
        });
        break;
      }
      case "reopen": {
        const { count } = await prisma.conversation.updateMany({ where: { ...where, status: "RESOLVED" }, data: { status: "REOPENED", resolvedAt: null } });
        if (count === 0) throw conflict();
        break;
      }
    }
    // Live notifications: fresh inbox counts for everyone, and an alert for whoever was just given it.
    if (body.action === "resolve" || body.action === "return_to_ai") presence.forget(conversation.id);
    live.publish(scope.workspaceId, { type: "inbox_changed" });
    if (body.action === "assign" && body.userId && body.userId !== scope.userId)
      live.publish(scope.workspaceId, { type: "assigned", conversationId: conversation.id, assignedTo: body.userId, by: scope.userId });
    return detail(conversation.id);
  });

  // A human agent's message. Sending takes the conversation over: the AI stays silent from now on.
  app.post(`${conversationPath}/messages`, async (req) => {
    const { scope, conversation } = await scoped(req);
    const { text, suggestionId, name } = agentMessageSchema.parse(req.body);
    if (!REPLY_CHANNELS.includes(conversation.channel))
      throw httpError(409, conversation.channel === "voice" ? "Phone calls cannot be continued by text. Call the customer back." : "This conversation has no customer to write to.");
    const customer = conversation.customer?.customer;
    if (!customer && !READ_BACK_CHANNELS.includes(conversation.channel)) throw httpError(409, "This conversation has no customer to write to.");
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
      const message = await tx.conversationMessage.create({ data: { ...within(scope), conversationId: conversation.id, role: "AGENT", content: text, authorId: scope.userId, createdAt: now } });
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
    presence.touch(conversation.id, name ?? "", false);
    live.publish(scope.workspaceId, { type: "inbox_changed" });
    return detail(conversation.id);
  });

  // The agent is typing: the web chat widget shows their name and "typing" for a few seconds.
  app.post(`${conversationPath}/typing`, async (req, reply) => {
    const { conversation } = await scoped(req);
    const { name } = agentTypingSchema.parse(req.body);
    presence.touch(conversation.id, name, true);
    return reply.code(204).send();
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
      provider = ai.provider({ ...within(scope), employeeId: conversation.employeeId, task: "copilot" });
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
        memory: ai.memory(within(scope)),
        timeoutMs: ai.timeoutMs,
      });
    } catch (err) {
      req.log.error(err, "Copilot failed");
      throw httpError(502, `The copilot could not answer: ${errorMessage(err)}`);
    }
  });

  // Conversation intelligence over the period: languages, code-switching, sentiment, intents, entities, resolution, escalation.
  app.get("/workspaces/:workspaceId/insights", async (req): Promise<InsightsOverview> => {
    const { workspaceId } = workspaceParams.parse(req.params);
    const scope = await inWorkspace(member(req), workspaceId);
    const { days } = analyticsQuerySchema.parse(req.query);
    const since = new Date(Date.now() - days * 86_400_000);
    await refreshInsights(within(scope), since);
    // Stored insights of the period's conversations, counted in SQL; ties keep the most recent first, as before.
    const base = Prisma.sql`"ConversationInsight" i JOIN "Conversation" c ON c.id = i."conversationId"
      WHERE i."organizationId" = ${scope.organizationId} AND i."workspaceId" = ${scope.workspaceId}
        AND c."organizationId" = ${scope.organizationId} AND c."workspaceId" = ${scope.workspaceId}
        AND c.channel <> ${EVALUATION_CHANNEL} AND c."updatedAt" >= ${since}`;
    const [conversations, [totals], groups] = await Promise.all([
      prisma.conversation.count({ where: { ...within(scope), ...REAL, updatedAt: { gte: since } } }),
      prisma.$queryRaw<{ analyzed: number; codeSwitched: number; withSwitches: number; escalated: number; withSignals: number }[]>`
        SELECT count(*)::int AS analyzed, count(*) FILTER (WHERE i."codeSwitchedMessages" > 0)::int AS "codeSwitched",
               count(*) FILTER (WHERE i.switches > 0)::int AS "withSwitches", count(*) FILTER (WHERE i.escalated)::int AS escalated,
               count(*) FILTER (WHERE i."escalationSignals" > 0)::int AS "withSignals"
        FROM ${base}`,
      prisma.$queryRaw<{ kind: string; key: string; date: string | null; n: number }[]>`
        SELECT kind, key, date, count(*)::int AS n FROM (
          SELECT 'language' AS kind, i."primaryLanguage" AS key, NULL AS date, i."activityAt" FROM ${base}
          UNION ALL SELECT 'sentiment', i.sentiment, NULL, i."activityAt" FROM ${base}
          UNION ALL SELECT 'intent', i.intent, NULL, i."activityAt" FROM ${base}
          UNION ALL SELECT 'resolution', i.resolution, NULL, i."activityAt" FROM ${base}
          UNION ALL SELECT 'entity', unnest(i."entityTypes"), NULL, i."activityAt" FROM ${base}
          -- Each conversation dated by the last activity it was analyzed at (UTC, as stored).
          UNION ALL SELECT 'daily', i.sentiment, to_char(i."activityAt", 'YYYY-MM-DD'), i."activityAt" FROM ${base}
        ) t
        GROUP BY kind, key, date
        ORDER BY count(*) DESC, max("activityAt") DESC`,
    ]);
    const of = (kind: string) => groups.filter((g) => g.kind === kind);
    const counts = <K extends string>(kind: string, keys: readonly K[], date?: string) =>
      Object.fromEntries(keys.map((k) => [k, of(kind).find((g) => g.key === k && (date === undefined || g.date === date))?.n ?? 0])) as Record<K, number>;
    const analyzed = totals?.analyzed ?? 0;
    return {
      days,
      conversations,
      analyzed,
      languages: of("language").filter((g) => g.key !== "unknown").map((g) => ({ language: g.key as DetectedLanguage, conversations: g.n })),
      codeSwitched: totals?.codeSwitched ?? 0,
      withSwitches: totals?.withSwitches ?? 0,
      sentiment: counts("sentiment", SENTIMENTS),
      intents: of("intent").map((g) => ({ intent: g.key as Intent, conversations: g.n })),
      entities: of("entity").map((g) => ({ type: g.key as EntityType, count: g.n })),
      resolution: counts("resolution", RESOLUTIONS),
      escalation: { conversations: totals?.escalated ?? 0, rate: analyzed > 0 ? (totals?.escalated ?? 0) / analyzed : null, withSignals: totals?.withSignals ?? 0 },
      sentimentDaily: [...new Set(of("daily").map((g) => g.date!))].sort().map((date) => ({ date, ...counts("daily", SENTIMENTS, date) })),
    };
  });

  app.get("/workspaces/:workspaceId/handoffs/analytics", async (req): Promise<HandoffAnalytics> => {
    const { workspaceId } = workspaceParams.parse(req.params);
    const scope = await inWorkspace(member(req), workspaceId);
    const { days } = analyticsQuerySchema.parse(req.query);
    const since = new Date(Date.now() - days * 86_400_000);
    const tenant = { ...within(scope), ...REAL };
    const before = new Date(since.getTime() - days * 86_400_000);
    // The same instant `since` was taken from (fractional seconds kept), so week 0 is exactly the period's last 7 days.
    const nowSec = since.getTime() / 1000 + days * 86_400;
    const [active, handoffs, queue, assigned, humanActive, suggestionsTotal, suggestionsUsed, replies, started, activeDaily, previousReplies, previousActive, previousHandedOff, weeks] = await Promise.all([
      // Active: at least one message in the period (updatedAt cannot be used for the previous period, it has moved on).
      activeConversations(scope, since),
      handoffTotals(scope, since),
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
      prisma.$queryRaw<{ date: string; count: number }[]>`
        SELECT to_char(c."createdAt", 'YYYY-MM-DD') AS date, count(*)::int AS count
        FROM "Conversation" c
        WHERE c."organizationId" = ${scope.organizationId} AND c."workspaceId" = ${scope.workspaceId} AND c."createdAt" >= ${since} AND c.channel <> ${EVALUATION_CHANNEL}
        GROUP BY 1`,
      // Conversations with at least one message that day: the base of the daily handoff rate. Timestamps are stored as UTC.
      prisma.$queryRaw<{ date: string; count: number }[]>`
        SELECT to_char(m."createdAt", 'YYYY-MM-DD') AS date, count(DISTINCT m."conversationId")::int AS count
        FROM "ConversationMessage" m JOIN "Conversation" c ON c.id = m."conversationId"
        WHERE c."organizationId" = ${scope.organizationId} AND c."workspaceId" = ${scope.workspaceId} AND m."createdAt" >= ${since} AND c.channel <> ${EVALUATION_CHANNEL}
        GROUP BY 1`,
      // Median reply time over the period of equal length before this one, to compare against.
      prisma.$queryRaw<{ role: string; median: number }[]>`
        SELECT role::text AS role, (percentile_cont(0.5) WITHIN GROUP (ORDER BY gap))::float8 AS median FROM (
          SELECT m.role, LAG(m.role) OVER w AS previous,
                 EXTRACT(EPOCH FROM (m."createdAt" - LAG(m."createdAt") OVER w)) * 1000 AS gap
          FROM "ConversationMessage" m JOIN "Conversation" c ON c.id = m."conversationId"
          WHERE c."organizationId" = ${scope.organizationId} AND c."workspaceId" = ${scope.workspaceId} AND c.channel <> ${EVALUATION_CHANNEL}
            AND m."createdAt" >= ${before} AND m."createdAt" < ${since}
          WINDOW w AS (PARTITION BY m."conversationId" ORDER BY m."createdAt")
        ) t
        WHERE previous = 'USER' AND role IN ('ASSISTANT', 'AGENT')
        GROUP BY role`,
      activeConversations(scope, before, since),
      prisma.handoff.groupBy({ by: ["conversationId"], where: { ...within(scope), conversation: REAL, requestedAt: { gte: before, lt: since } } }),
      // Distinct conversations per 7-day week counted back from now (week 0 = the last 7 days). Epochs, not casts:
      // timestamps are stored as UTC without a zone, and EXTRACT(EPOCH) reads them as UTC whatever the session zone.
      prisma.$queryRaw<{ w: number; active: number; handed: number }[]>`
        SELECT w, count(DISTINCT a)::int AS active, count(DISTINCT h)::int AS handed FROM (
          SELECT GREATEST(0, floor((${nowSec} - EXTRACT(EPOCH FROM m."createdAt")) / 604800))::int AS w, m."conversationId" AS a, NULL::text AS h
          FROM "ConversationMessage" m JOIN "Conversation" c ON c.id = m."conversationId"
          WHERE c."organizationId" = ${scope.organizationId} AND c."workspaceId" = ${scope.workspaceId} AND m."createdAt" >= ${since} AND c.channel <> ${EVALUATION_CHANNEL}
          UNION ALL
          SELECT GREATEST(0, floor((${nowSec} - EXTRACT(EPOCH FROM h."requestedAt")) / 604800))::int, NULL::text, h."conversationId"
          FROM "Handoff" h JOIN "Conversation" c ON c.id = h."conversationId"
          WHERE h."organizationId" = ${scope.organizationId} AND h."workspaceId" = ${scope.workspaceId} AND h."requestedAt" >= ${since} AND c.channel <> ${EVALUATION_CHANNEL}
        ) t
        GROUP BY w`,
    ]);
    const previous = (role: string) => {
      const m = previousReplies.find((r) => r.role === role)?.median;
      return m === undefined || m === null ? null : Math.round(Number(m));
    };
    // Counts per band: below edges[0], [edges[i-1], edges[i]), and at or above the last edge.
    const bands = (list: number[], edges: readonly number[]) =>
      [...edges, Infinity].map((edge, i) => list.filter((g) => g < edge && g >= (i === 0 ? -Infinity : edges[i - 1]!)).length);
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const dates: string[] = [];
    for (let t = Date.parse(day(since)); t <= Date.now(); t += 86_400_000) dates.push(day(new Date(t)));
    const gaps = (role: string) => (replies.find((r) => r.role === role)?.gaps ?? []).map(Number);
    const { total, agents, triggers, daily } = handoffs;
    return {
      days,
      conversations: active,
      handoffs: total.handoffs,
      handoffRate: active > 0 ? total.conversations / active : null,
      previousHandoffRate: previousActive > 0 ? previousHandedOff.length / previousActive : null,
      byTrigger: triggers.map((t) => ({ trigger: t.trigger as HandoffTrigger, count: t.count })),
      outcomes: { resolved: total.resolved, returnedToAi: total.returned, open: total.open },
      open: { queue, assigned, humanActive },
      timeToAccept: durationStats(total, "accept"),
      timeToFirstResponse: durationStats(total, "first"),
      timeToResolve: durationStats(total, "resolve"),
      replyTime: { ai: stats(gaps("ASSISTANT")), human: stats(gaps("AGENT")) },
      previousReplyMedian: { ai: previous("ASSISTANT"), human: previous("AGENT") },
      replyBands: { ai: bands(gaps("ASSISTANT"), REPLY_BANDS.ai), human: bands(gaps("AGENT"), REPLY_BANDS.human) },
      byAgent: agents.map((a) => ({ agentId: a.agentId!, handoffs: a.handoffs, resolved: a.resolved, firstResponse: durationStats(a, "first") })),
      suggestions: { total: suggestionsTotal, used: suggestionsUsed },
      weekly: Array.from({ length: Math.ceil(days / 7) }, (_, i) => {
        const w = Math.ceil(days / 7) - 1 - i;
        const row = weeks.find((x) => x.w === w);
        return {
          from: day(new Date(Math.max(since.getTime(), (nowSec - (w + 1) * 604_800) * 1000))),
          to: day(new Date((nowSec - w * 604_800) * 1000)),
          active: row?.active ?? 0,
          handedOff: row?.handed ?? 0,
        };
      }),
      daily: dates.map((date) => {
        const d = daily.find((x) => x.date === date);
        return {
          date,
          conversations: started.find((s) => s.date === date)?.count ?? 0,
          handoffs: d?.handoffs ?? 0,
          resolved: d?.resolved ?? 0,
          active: activeDaily.find((a) => a.date === date)?.count ?? 0,
          handedOff: d?.handedOff ?? 0,
        };
      }),
    };
  });
}

type HandoffGroup = {
  agentId: string | null;
  handoffs: number;
  conversations: number;
  resolved: number;
  returned: number;
  open: number;
} & Record<`${"accept" | "first" | "resolve"}${"N" | "Sum" | "P50" | "P90"}`, number | null>;

/** The same numbers stats() gives: percentile_disc is its nearest rank, and the average is rounded the same way. */
const durationStats = (g: HandoffGroup, key: "accept" | "first" | "resolve"): DurationStats => {
  const n = g[`${key}N`] ?? 0;
  if (n === 0) return { count: 0, average: null, median: null, p90: null };
  return { count: n, average: Math.round(Number(g[`${key}Sum`]) / n), median: Number(g[`${key}P50`]), p90: Number(g[`${key}P90`]) };
};

/** Handoffs requested since `since`, aggregated in SQL: the period's totals, per agent, per trigger and per day. */
async function handoffTotals(scope: { organizationId: string; workspaceId: string }, since: Date) {
  const from = Prisma.sql`FROM "Handoff" h JOIN "Conversation" c ON c.id = h."conversationId"
    WHERE h."organizationId" = ${scope.organizationId} AND h."workspaceId" = ${scope.workspaceId} AND h."requestedAt" >= ${since} AND c.channel <> ${EVALUATION_CHANNEL}`;
  const ms = (to: string) => Prisma.raw(`(EXTRACT(EPOCH FROM (h."${to}" - h."requestedAt")) * 1000)::float8`);
  const duration = (key: string, value: Prisma.Sql) => Prisma.sql`
    count(${value})::int AS ${Prisma.raw(`"${key}N"`)}, sum(${value}) AS ${Prisma.raw(`"${key}Sum"`)},
    percentile_disc(0.5) WITHIN GROUP (ORDER BY ${value}) AS ${Prisma.raw(`"${key}P50"`)},
    percentile_disc(0.9) WITHIN GROUP (ORDER BY ${value}) AS ${Prisma.raw(`"${key}P90"`)}`;
  const [groups, triggers, daily] = await Promise.all([
    // One row for the whole period (total = 1) and one per assigned agent; ties keep the most recent first, as before.
    prisma.$queryRaw<(HandoffGroup & { total: number })[]>`
      SELECT GROUPING(h."assignedTo")::int AS total, h."assignedTo" AS "agentId", count(*)::int AS handoffs,
             count(DISTINCT h."conversationId")::int AS conversations,
             count(*) FILTER (WHERE h.outcome = 'resolved')::int AS resolved,
             count(*) FILTER (WHERE h.outcome = 'returned_to_ai')::int AS returned,
             count(*) FILTER (WHERE h."endedAt" IS NULL)::int AS open,
             ${duration("accept", ms("acceptedAt"))}, ${duration("first", ms("firstResponseAt"))},
             ${duration("resolve", Prisma.sql`CASE WHEN h.outcome = 'resolved' THEN ${ms("endedAt")} END`)}
      ${from}
      GROUP BY GROUPING SETS ((), (h."assignedTo"))
      ORDER BY count(*) DESC, max(h."requestedAt") DESC`,
    prisma.$queryRaw<{ trigger: string; count: number }[]>`
      SELECT h.trigger, count(*)::int AS count ${from} GROUP BY h.trigger ORDER BY count(*) DESC, max(h."requestedAt") DESC`,
    // Timestamps are stored as UTC, so the day is the stored date. Resolved handoffs count on the day they ended.
    prisma.$queryRaw<{ date: string; handoffs: number; handedOff: number; resolved: number }[]>`
      SELECT date, sum(handoffs)::int AS handoffs, sum("handedOff")::int AS "handedOff", sum(resolved)::int AS resolved FROM (
        SELECT to_char(h."requestedAt", 'YYYY-MM-DD') AS date, count(*) AS handoffs, count(DISTINCT h."conversationId") AS "handedOff", 0 AS resolved
        ${from} GROUP BY 1
        UNION ALL
        SELECT to_char(h."endedAt", 'YYYY-MM-DD'), 0, 0, count(*) ${from} AND h.outcome = 'resolved' AND h."endedAt" IS NOT NULL GROUP BY 1
      ) t GROUP BY date`,
  ]);
  const empty: HandoffGroup = { agentId: null, handoffs: 0, conversations: 0, resolved: 0, returned: 0, open: 0 } as HandoffGroup;
  return {
    total: groups.find((g) => g.total === 1) ?? empty,
    agents: groups.filter((g) => g.total === 0 && g.agentId !== null),
    triggers,
    daily,
  };
}
