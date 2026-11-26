// The dashboard's numbers in one request (GET /workspaces/:workspaceId/dashboard): counts and averages in SQL instead
// of the full analytics, quality and billing reports. Always the workspace in the session's organization.
import { prisma, type Prisma } from "@workforce/database";
import { ATTENTION_DEFAULTS, attentionSchema, dashboardQuerySchema, EMPLOYEE_STATUSES, EVALUATION_CHANNEL, PLANS, type DashboardSummary, type EmployeeStatus } from "@workforce/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { guards, type Authenticate } from "./auth.ts";
import type { BillingService } from "./billing/service.ts";
import { listEmployees, within } from "./employees.ts";
import { activeConversations } from "./inbox.ts";

const DAY_MS = 86_400_000;
/** Regression replays are not customer conversations. */
const REAL = { channel: { not: EVALUATION_CHANNEL } } satisfies Prisma.ConversationWhereInput;
/** Grades of real conversations, not of regression runs. */
const PRODUCTION = { trigger: { in: ["auto", "manual"] }, status: "COMPLETED" } satisfies Prisma.EvaluationWhereInput;

export function dashboardRoutes(app: FastifyInstance, authenticate: Authenticate, billing: BillingService) {
  const { member, admin, inWorkspace } = guards(authenticate);

  /** The workspace's stored thresholds over the defaults; a stored value that no longer validates falls back. */
  const attentionOf = async (scope: { organizationId: string; workspaceId: string }) => {
    const row = await prisma.workspace.findFirst({ where: { id: scope.workspaceId, organizationId: scope.organizationId }, select: { attention: true } });
    const stored = attentionSchema.partial().safeParse(row?.attention ?? {});
    return { ...ATTENTION_DEFAULTS, ...(stored.success ? stored.data : {}) };
  };

  app.put("/workspaces/:workspaceId/attention", async (req) => {
    const { workspaceId } = z.object({ workspaceId: z.string().min(1) }).parse(req.params);
    const scope = await inWorkspace(admin(req), workspaceId);
    const attention = attentionSchema.parse(req.body);
    await prisma.workspace.updateMany({ where: { id: scope.workspaceId, organizationId: scope.organizationId }, data: { attention } });
    return attention;
  });

  app.get("/workspaces/:workspaceId/dashboard", async (req): Promise<DashboardSummary> => {
    const { workspaceId } = z.object({ workspaceId: z.string().min(1) }).parse(req.params);
    const { days } = dashboardQuerySchema.parse(req.query);
    const scope = await inWorkspace(member(req), workspaceId);
    const tenant = within(scope);
    const now = Date.now();
    const since = new Date(now - days * DAY_MS);
    const before = new Date(now - 2 * days * DAY_MS);

    /** Distinct conversations handed off over conversations with a message, in [from, to). */
    const handoffRate = async (from: Date, to?: Date) => {
      const range = { gte: from, ...(to && { lt: to }) };
      const [active, handed] = await Promise.all([
        activeConversations(scope, from, to),
        prisma.handoff.groupBy({ by: ["conversationId"], where: { ...tenant, conversation: REAL, requestedAt: range } }),
      ]);
      return active > 0 ? handed.length / active : null;
    };
    const graded = { ...tenant, ...PRODUCTION, createdAt: { gte: since } } satisfies Prisma.EvaluationWhereInput;

    // Limits first: it meters the period so far, so the usage sums below include it.
    const { plan, period, limits } = await billing.limits(scope.organizationId);
    const usage = (where: Prisma.UsageEventWhereInput) =>
      prisma.usageEvent.aggregate({ where: { ...where, occurredAt: { gte: period.start, lt: period.end }, amountUsd: { not: null } }, _sum: { amountUsd: true } });

    const [conversations, handoffs, rate, previousRate, queue, assigned, humanActive, grades, passed, judged, failing, employees, archived, workspaceUsage, organizationUsage] =
      await Promise.all([
        prisma.conversation.count({ where: { ...tenant, ...REAL, createdAt: { gte: since } } }),
        prisma.handoff.count({ where: { ...tenant, conversation: REAL, requestedAt: { gte: since } } }),
        handoffRate(since),
        handoffRate(before, since),
        prisma.conversation.count({ where: { ...tenant, ...REAL, status: "WAITING_FOR_HUMAN", assignedTo: null } }),
        prisma.conversation.count({ where: { ...tenant, ...REAL, status: "WAITING_FOR_HUMAN", assignedTo: { not: null } } }),
        prisma.conversation.count({ where: { ...tenant, ...REAL, status: "HUMAN_ACTIVE" } }),
        prisma.evaluation.aggregate({ where: graded, _avg: { score: true }, _sum: { failures: true }, _count: { _all: true } }),
        prisma.evaluation.count({ where: { ...graded, passed: true } }),
        prisma.evaluation.count({ where: { ...graded, passed: { not: null } } }),
        prisma.evaluationResult.groupBy({
          by: ["evaluatorId"],
          where: { status: "scored", passed: false, evaluation: graded },
          _count: { evaluatorId: true },
          orderBy: { _count: { evaluatorId: "desc" } },
          take: 1,
        }),
        listEmployees(scope),
        prisma.aiEmployee.count({ where: { ...tenant, status: "ARCHIVED" } }),
        usage({ organizationId: scope.organizationId, workspaceId: scope.workspaceId }),
        usage({ organizationId: scope.organizationId }),
      ]);

    const attention = await attentionOf(scope);
    const top = failing[0];
    const topName = top
      ? ((await prisma.evaluatorVersion.findFirst({ where: { evaluatorId: top.evaluatorId, evaluator: tenant }, orderBy: { number: "desc" }, select: { name: true } }))?.name ?? null)
      : null;
    const counts = Object.fromEntries(EMPLOYEE_STATUSES.map((s) => [s, employees.filter((e) => e.status === s).length])) as Record<EmployeeStatus, number>;
    counts.ARCHIVED = archived;
    const average = grades._avg.score;

    return {
      days,
      attention,
      conversations,
      handoffs,
      handoffRate: rate,
      previousHandoffRate: previousRate,
      open: { queue, assigned, humanActive },
      quality: {
        evaluations: grades._count._all,
        averageScore: average === null ? null : Math.round(average * 10) / 10,
        passRate: judged > 0 ? passed / judged : null,
        failures: grades._sum.failures ?? 0,
        topFailure: topName,
      },
      employees: { counts, list: employees },
      billing: {
        planName: PLANS[plan].name,
        periodEnd: period.end.toISOString(),
        workspaceUsd: workspaceUsage._sum.amountUsd ?? 0,
        organizationUsd: organizationUsage._sum.amountUsd ?? 0,
        limits,
      },
    };
  });
}
