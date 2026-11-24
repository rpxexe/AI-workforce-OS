// Tenant analytics for a date range: conversations, calls, messages, tokens, tool and workflow executions,
// resolutions, escalations, handoffs, latency, cost and quality. Always the organization in the session; a
// workspace filter must be one of its workspaces (404 otherwise). Regression replays are left out.
import { Prisma, prisma } from "@workforce/database";
import { EVALUATION_CHANNEL, rangeQuerySchema, type AnalyticsReport, type DurationStats } from "@workforce/shared";
import type { FastifyInstance } from "fastify";
import { guards, type Authenticate } from "./auth.ts";

type Percentiles = { count: bigint; average: number | null; median: number | null; p90: number | null };
const toStats = (p: Percentiles | undefined): DurationStats => {
  const round = (v: number | null) => (v === null ? null : Math.round(Number(v)));
  return { count: Number(p?.count ?? 0), average: round(p?.average ?? null), median: round(p?.median ?? null), p90: round(p?.p90 ?? null) };
};

/** The report for one organization, optionally one of its workspaces (the caller checked it is the organization's). */
export async function analyticsReport(organizationId: string, ws: string | null, from: Date, to: Date): Promise<AnalyticsReport> {
  const tenant = { organizationId, ...(ws && { workspaceId: ws }) };
  const range = { gte: from, lt: to };
  const real = { ...tenant, channel: { not: EVALUATION_CHANNEL } };
  // Raw SQL: the same tenant filter, on the conversation the row belongs to.
  const inTenant = (alias: string) =>
    Prisma.sql`${Prisma.raw(`${alias}."organizationId"`)} = ${organizationId} ${ws ? Prisma.sql`AND ${Prisma.raw(`${alias}."workspaceId"`)} = ${ws}` : Prisma.empty}`;

  const [
    byChannel,
    calls,
    completedCalls,
    byRole,
    tokens,
    tools,
    runs,
    resolutions,
    escalations,
    humanHandoffs,
    [aiLatency],
    [providerLatency],
    billed,
    quality,
    passed,
    daily,
  ] = await Promise.all([
    prisma.conversation.groupBy({ by: ["channel"], where: { ...real, createdAt: range }, _count: { _all: true } }),
    prisma.call.aggregate({ where: { ...tenant, createdAt: range }, _count: { _all: true }, _sum: { durationSec: true } }),
    prisma.call.count({ where: { ...tenant, createdAt: range, status: "COMPLETED" } }),
    prisma.conversationMessage.groupBy({ by: ["role"], where: { createdAt: range, conversation: real }, _count: { _all: true } }),
    prisma.aiUsage.aggregate({ where: { ...tenant, createdAt: range }, _sum: { inputTokens: true, outputTokens: true } }),
    prisma.toolExecution.groupBy({ by: ["status"], where: { ...tenant, createdAt: range }, _count: { _all: true } }),
    prisma.workflowExecution.groupBy({ by: ["status"], where: { ...tenant, createdAt: range }, _count: { _all: true } }),
    prisma.conversation.count({ where: { ...real, resolvedAt: range } }),
    prisma.handoff.count({ where: { ...tenant, requestedAt: range, conversation: { channel: { not: EVALUATION_CHANNEL } } } }),
    prisma.handoff.count({ where: { ...tenant, requestedAt: range, acceptedAt: { not: null }, conversation: { channel: { not: EVALUATION_CHANNEL } } } }),
    prisma.$queryRaw<Percentiles[]>`
      SELECT count(*) AS count, avg(m."latencyMs")::float8 AS average,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY m."latencyMs")::float8 AS median,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY m."latencyMs")::float8 AS p90
      FROM "ConversationMessage" m JOIN "Conversation" c ON c.id = m."conversationId"
      WHERE ${inTenant("c")} AND c.channel <> ${EVALUATION_CHANNEL} AND m.role = 'ASSISTANT' AND m."latencyMs" IS NOT NULL
        AND m."createdAt" >= ${from} AND m."createdAt" < ${to}`,
    prisma.$queryRaw<Percentiles[]>`
      SELECT count(*) AS count, avg(u."latencyMs")::float8 AS average,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY u."latencyMs")::float8 AS median,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY u."latencyMs")::float8 AS p90
      FROM "AiUsage" u
      WHERE ${inTenant("u")} AND u.success AND u."latencyMs" > 0 AND u."createdAt" >= ${from} AND u."createdAt" < ${to}`,
    prisma.usageEvent.aggregate({ where: { ...tenant, occurredAt: range }, _sum: { amountUsd: true } }),
    prisma.evaluation.aggregate({ where: { ...tenant, createdAt: range, status: "COMPLETED", trigger: { in: ["auto", "manual"] } }, _avg: { score: true }, _count: { _all: true } }),
    prisma.evaluation.count({ where: { ...tenant, createdAt: range, status: "COMPLETED", trigger: { in: ["auto", "manual"] }, passed: true } }),
    prisma.$queryRaw<{ date: Date; conversations: bigint; messages: bigint; cost: number | null }[]>`
      WITH days AS (SELECT generate_series(date_trunc('day', ${from}::timestamp), ${to}::timestamp - interval '1 microsecond', interval '1 day') AS date)
      SELECT d.date,
             (SELECT count(*) FROM "Conversation" c WHERE ${inTenant("c")} AND c.channel <> ${EVALUATION_CHANNEL}
                AND c."createdAt" >= greatest(d.date, ${from}::timestamp) AND c."createdAt" < least(d.date + interval '1 day', ${to}::timestamp)) AS conversations,
             (SELECT count(*) FROM "ConversationMessage" m JOIN "Conversation" c ON c.id = m."conversationId"
                WHERE ${inTenant("c")} AND c.channel <> ${EVALUATION_CHANNEL}
                AND m."createdAt" >= greatest(d.date, ${from}::timestamp) AND m."createdAt" < least(d.date + interval '1 day', ${to}::timestamp)) AS messages,
             (SELECT sum(e."amountUsd") FROM "UsageEvent" e WHERE ${inTenant("e")}
                AND e."occurredAt" >= greatest(d.date, ${from}::timestamp) AND e."occurredAt" < least(d.date + interval '1 day', ${to}::timestamp)) AS cost
      FROM days d ORDER BY d.date`,
  ]);

  const count = (rows: { _count: { _all: number } }[]) => rows.reduce((s, r) => s + r._count._all, 0);
  const role = (r: string) => byRole.find((x) => x.role === r)?._count._all ?? 0;
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    workspaceId: ws,
    conversations: { total: count(byChannel), byChannel: byChannel.map((c) => ({ channel: c.channel, count: c._count._all })).sort((a, b) => b.count - a.count) },
    calls: { total: calls._count._all, completed: completedCalls, minutes: Math.round(((calls._sum.durationSec ?? 0) / 60) * 10) / 10 },
    messages: { customer: role("USER"), ai: role("ASSISTANT"), agent: role("AGENT") },
    tokens: { input: tokens._sum.inputTokens ?? 0, output: tokens._sum.outputTokens ?? 0 },
    toolExecutions: { total: count(tools), byStatus: tools.map((t) => ({ status: t.status, count: t._count._all })) },
    workflowExecutions: { total: count(runs), byStatus: runs.map((r) => ({ status: r.status, count: r._count._all })) },
    resolutions,
    escalations,
    humanHandoffs,
    latency: { aiReply: toStats(aiLatency), provider: toStats(providerLatency) },
    cost: { billedUsd: billed._sum.amountUsd ?? 0 },
    quality: {
      evaluations: quality._count._all,
      averageScore: quality._avg.score === null ? null : Math.round(quality._avg.score * 10) / 10,
      passRate: quality._count._all > 0 ? passed / quality._count._all : null,
    },
    daily: daily.map((d) => ({ date: d.date.toISOString().slice(0, 10), conversations: Number(d.conversations), messages: Number(d.messages), billedUsd: Number(d.cost ?? 0) })),
  };
}

export function reportRoutes(app: FastifyInstance, authenticate: Authenticate) {
  const { member, inWorkspace } = guards(authenticate);

  app.get("/analytics/report", async (req): Promise<AnalyticsReport> => {
    const auth = member(req);
    const { from, to, workspaceId } = rangeQuerySchema.parse(req.query);
    const ws = workspaceId ? (await inWorkspace(auth, workspaceId)).workspaceId : null;
    return analyticsReport(auth.organizationId, ws, from, to);
  });
}
