// Plans, billing periods, usage from the ledger, and plan limits. Stripe is not known here: subscriptions arrive
// as plan + status + period through `applySubscription`, written by the webhook route.
import { prisma } from "@workforce/database";
import { LIMIT_LABELS, PLANS, USAGE_KINDS, type LimitKey, type LimitUsage, type PlanId, type UsageKind, type UsageLimiter, type UsageSummary } from "@workforce/shared";
import type { FastifyBaseLogger } from "fastify";
import { meter, type MeterConfig } from "./meter.ts";

/** Subscription states in which the paid plan applies; anything else falls back to Free. */
const PAYING = ["active", "trialing", "past_due"];
/** A limit check meters this far back first, so what the organization just did counts. */
const HOT_WINDOW_MS = 15 * 60_000;
/** Reads that show usage meter this far back; the sweep has covered anything older. */
const READ_WINDOW_MS = 3 * 86_400_000;

const LEDGER_KIND: Partial<Record<LimitKey, UsageKind>> = {
  conversations: "conversation",
  messages: "message",
  voiceMinutes: "voice_minutes",
  toolCalls: "tool_call",
};

type Account = Awaited<ReturnType<typeof prisma.billingAccount.findUniqueOrThrow>>;

export type BillingService = ReturnType<typeof billingService>;

/** `enforced`: limits apply (Stripe configured, or asked for). */
export function billingService(config: MeterConfig & { enforced: boolean }, log: FastifyBaseLogger) {
  /** The organization's billing account, created on first use (Free). */
  async function account(organizationId: string): Promise<Account> {
    await prisma.billingAccount.createMany({ data: [{ organizationId }], skipDuplicates: true });
    return prisma.billingAccount.findUniqueOrThrow({ where: { organizationId } });
  }

  const planOf = (a: Account): PlanId => (PAYING.includes(a.status) && a.plan in PLANS ? (a.plan as PlanId) : "free");

  /** The subscription's current period; without one (or outside it), the calendar month in UTC. */
  function periodOf(a: Account, now = new Date()) {
    if (a.currentPeriodStart && a.currentPeriodEnd && a.currentPeriodStart <= now && now < a.currentPeriodEnd)
      return { start: a.currentPeriodStart, end: a.currentPeriodEnd };
    return { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) };
  }

  const meterSince = (organizationId: string | null, since: Date) => meter(organizationId, since, config);

  /** Ledger totals per kind in [from, to). */
  async function ledger(organizationId: string, from: Date, to: Date) {
    const rows = await prisma.usageEvent.groupBy({
      by: ["kind"],
      where: { organizationId, occurredAt: { gte: from, lt: to } },
      _sum: { quantity: true, amountUsd: true, costUsd: true },
      _count: { _all: true },
    });
    const unpriced = await prisma.usageEvent.count({
      where: { organizationId, occurredAt: { gte: from, lt: to }, kind: { in: ["provider", "voice_minutes"] }, amountUsd: null },
    });
    return {
      byKind: new Map(rows.map((r) => [r.kind as UsageKind, { quantity: r._sum.quantity ?? 0, events: r._count._all }])),
      amountUsd: rows.reduce((s, r) => s + (r._sum.amountUsd ?? 0), 0),
      costUsd: rows.reduce((s, r) => s + (r._sum.costUsd ?? 0), 0),
      unpriced,
    };
  }

  /** What the organization has used of each limit now: state limits counted live, usage limits from the ledger this period. */
  async function used(organizationId: string, keys: readonly LimitKey[], period: { start: Date; end: Date }) {
    const totals = keys.some((k) => LEDGER_KIND[k] || k === "aiUsageUsd") ? await ledger(organizationId, period.start, period.end) : null;
    const out = {} as Record<LimitKey, number>;
    for (const key of keys) {
      if (key === "employees") out[key] = await prisma.aiEmployee.count({ where: { organizationId, status: { not: "ARCHIVED" } } });
      else if (key === "storageMb") {
        const { _sum } = await prisma.knowledgeDocument.aggregate({ where: { organizationId }, _sum: { sizeBytes: true } });
        out[key] = (_sum.sizeBytes ?? 0) / 1_048_576;
      } else if (key === "aiUsageUsd") out[key] = totals!.amountUsd;
      else out[key] = totals!.byKind.get(LEDGER_KIND[key]!)?.quantity ?? 0;
    }
    return out;
  }

  /** Every limit with its current use, after metering the period so far. */
  async function limits(organizationId: string): Promise<{ account: Account; plan: PlanId; period: { start: Date; end: Date }; limits: LimitUsage[] }> {
    const a = await account(organizationId);
    const period = periodOf(a);
    await meterSince(organizationId, new Date(Math.max(period.start.getTime(), Date.now() - READ_WINDOW_MS)));
    const plan = planOf(a);
    const keys = Object.keys(PLANS[plan].limits) as LimitKey[];
    const use = await used(organizationId, keys, period);
    return { account: a, plan, period, limits: keys.map((key) => ({ key, label: LIMIT_LABELS[key], used: use[key], limit: PLANS[plan].limits[key] })) };
  }

  /**
   * Refuses when using more would pass the plan's limit. A failure to check is logged and allowed: a billing hiccup
   * must not stop conversations (the ledger still records the usage).
   */
  const check: UsageLimiter = async (organizationId, keys, adding = {}) => {
    if (!config.enforced) return null;
    try {
      const a = await account(organizationId);
      const plan = PLANS[planOf(a)];
      await meterSince(organizationId, new Date(Date.now() - HOT_WINDOW_MS));
      const use = await used(organizationId, keys, periodOf(a));
      for (const key of keys) {
        const limit = plan.limits[key];
        const over = key === "aiUsageUsd" ? use[key] >= limit : use[key] + (adding[key] ?? (key === "storageMb" ? 0 : 1)) > limit;
        if (over)
          return `This organization has reached its ${plan.name} plan limit for ${LIMIT_LABELS[key].toLowerCase()} (${limit}). An admin can upgrade the plan in Billing.`;
      }
      return null;
    } catch (err) {
      log.error({ err, organizationId, keys }, "Checking plan limits failed; allowed");
      return null;
    }
  };

  /** The ledger for a range: totals per kind, cost and amount billed, and the newest entries with their sources. */
  async function summary(organizationId: string, from: Date, to: Date): Promise<UsageSummary> {
    await meterSince(organizationId, new Date(Math.max(from.getTime(), Date.now() - READ_WINDOW_MS)));
    const [totals, recent] = await Promise.all([
      ledger(organizationId, from, to),
      prisma.usageEvent.findMany({ where: { organizationId, occurredAt: { gte: from, lt: to } }, orderBy: { occurredAt: "desc" }, take: 100 }),
    ]);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      byKind: USAGE_KINDS.map((kind) => ({ kind, ...(totals.byKind.get(kind) ?? { quantity: 0, events: 0 }) })),
      amountUsd: totals.amountUsd,
      recent: recent.map((e) => ({
        id: e.id,
        kind: e.kind as UsageKind,
        quantity: e.quantity,
        amountUsd: e.amountUsd,
        sourceType: e.sourceType,
        sourceId: e.sourceId,
        workspaceId: e.workspaceId,
        occurredAt: e.occurredAt.toISOString(),
        detail: e.detail,
      })),
    };
  }

  /** The amount billed for usage in [from, to), with the number of ledger entries behind it. */
  async function billed(organizationId: string, from: Date, to: Date) {
    await meterSince(organizationId, from);
    const { _sum, _count } = await prisma.usageEvent.aggregate({
      where: { organizationId, occurredAt: { gte: from, lt: to }, amountUsd: { not: null } },
      _sum: { amountUsd: true },
      _count: { _all: true },
    });
    return { amountUsd: _sum.amountUsd ?? 0, events: _count._all };
  }

  return { account, planOf, periodOf, limits, check, summary, billed, ledger, meter: meterSince, enforced: config.enforced };
}
