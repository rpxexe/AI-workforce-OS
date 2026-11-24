// Billing routes: the overview (plan, limits, usage, invoices), the usage ledger for a range, buying or changing a plan,
// the Stripe customer portal, and Stripe's webhook. Every read is scoped to the organization in the session.
import { prisma } from "@workforce/database";
import { checkoutSchema, PLAN_IDS, PLANS, rangeQuerySchema, type BillingOverview, type UsageSummary } from "@workforce/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { guards, httpError, type Authenticate } from "../auth.ts";
import type { BillingService } from "./service.ts";
import { periodOf, StripeError, type Stripe, type StripeInvoice, type StripeSubscription } from "./stripe.ts";

const NOT_CONFIGURED = "Billing is not configured on this server: set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and the STRIPE_PRICE_* ids in .env";

export function billingRoutes(
  app: FastifyInstance,
  authenticate: Authenticate,
  deps: { billing: BillingService; stripe: Stripe | null; dashboardOrigin: string },
) {
  const { member, admin } = guards(authenticate);
  const { billing, stripe } = deps;
  const needStripe = () => {
    if (!stripe) throw httpError(503, NOT_CONFIGURED);
    return stripe;
  };
  /** Stripe refusals become 502s with Stripe's message (it names no secrets). */
  const viaStripe = async <T>(work: () => Promise<T>) => {
    try {
      return await work();
    } catch (err) {
      if (err instanceof StripeError) throw httpError(502, err.message);
      throw err;
    }
  };

  app.get("/billing", async (req): Promise<BillingOverview> => {
    const { organizationId } = member(req);
    const { account, plan, period, limits } = await billing.limits(organizationId);
    const [usage, invoices] = await Promise.all([
      billing.summary(organizationId, period.start, period.end),
      prisma.billingInvoice.findMany({ where: { organizationId }, orderBy: { createdAt: "desc" }, take: 24 }),
    ]);
    return {
      stripe: stripe !== null,
      enforced: billing.enforced,
      plan,
      status: account.status,
      period: { start: period.start.toISOString(), end: period.end.toISOString() },
      cancelAtPeriodEnd: account.cancelAtPeriodEnd,
      hasSubscription: account.stripeSubscriptionId !== null,
      limits,
      usage,
      invoices: invoices.map((i) => ({
        id: i.id,
        number: i.number,
        status: i.status,
        amountDue: i.amountDue,
        amountPaid: i.amountPaid,
        currency: i.currency,
        hostedInvoiceUrl: i.hostedInvoiceUrl,
        periodStart: i.periodStart?.toISOString() ?? null,
        periodEnd: i.periodEnd?.toISOString() ?? null,
        createdAt: i.createdAt.toISOString(),
      })),
      plans: PLAN_IDS.map((id) => ({ id, ...PLANS[id] })),
    };
  });

  app.get("/billing/usage", async (req): Promise<UsageSummary> => {
    const { organizationId } = member(req);
    const { from, to } = rangeQuerySchema.parse(req.query);
    return billing.summary(organizationId, from, to);
  });

  /**
   * Buys or changes the plan. Without a subscription: a Stripe Checkout page ({ url }). With one: the subscription moves to
   * the new price at once ({ url: null }); Free cancels it at the end of the period.
   */
  app.post("/billing/checkout", async (req) => {
    const { organizationId } = admin(req);
    const { plan } = checkoutSchema.parse(req.body);
    const s = needStripe();
    const account = await billing.account(organizationId);
    if (plan === "free") {
      if (!account.stripeSubscriptionId) throw httpError(400, "This organization is already on the Free plan");
      await viaStripe(async () => applySubscription(await s.cancelAtPeriodEnd(account.stripeSubscriptionId!), s, app.log, organizationId));
      return { url: null };
    }
    const price = s.priceOf(plan);
    if (!price) throw httpError(503, `No Stripe price is set for the ${PLANS[plan].name} plan: set STRIPE_PRICE_${plan.toUpperCase()} in .env`);
    if (account.stripeSubscriptionId) {
      await viaStripe(async () => {
        const current = await s.subscription(account.stripeSubscriptionId!);
        await applySubscription(await s.changePrice(current, price), s, app.log, organizationId);
      });
      return { url: null };
    }
    return viaStripe(async () => {
      let customer = account.stripeCustomerId;
      if (!customer) {
        const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { name: true } });
        customer = (await s.createCustomer(organizationId, org.name)).id;
        await prisma.billingAccount.update({ where: { organizationId }, data: { stripeCustomerId: customer } });
      }
      const session = await s.checkout({
        customer,
        price,
        organizationId,
        successUrl: `${deps.dashboardOrigin}/billing?checkout=success`,
        cancelUrl: `${deps.dashboardOrigin}/billing?checkout=cancelled`,
      });
      return { url: session.url };
    });
  });

  /** Stripe's customer portal: payment methods, invoices, cancellation. */
  app.post("/billing/portal", async (req) => {
    const { organizationId } = admin(req);
    const s = needStripe();
    const account = await billing.account(organizationId);
    if (!account.stripeCustomerId) throw httpError(409, "Choose a paid plan first");
    return viaStripe(async () => ({ url: (await s.portal(account.stripeCustomerId!, `${deps.dashboardOrigin}/billing`)).url }));
  });

  // Stripe's webhook: verified with STRIPE_WEBHOOK_SECRET over the raw body. Every handler is idempotent (subscriptions are
  // re-read from Stripe, invoices upserted, usage added once per period), so Stripe's retries and duplicates are harmless.
  void app.register(async (hooks) => {
    hooks.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
    hooks.post("/billing/stripe/webhook", async (req, reply) => {
      const s = needStripe();
      const header = req.headers["stripe-signature"];
      const event = s.verify(typeof req.body === "string" ? req.body : "", typeof header === "string" ? header : undefined);
      if (!event) throw httpError(400, "Invalid Stripe signature");
      const object = event.data.object;
      switch (event.type) {
        case "checkout.session.completed":
        case "checkout.session.async_payment_succeeded": {
          const session = object as { client_reference_id?: string; subscription?: string | null };
          if (session.subscription) await applySubscription(await s.subscription(session.subscription), s, req.log, session.client_reference_id);
          break;
        }
        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "customer.subscription.deleted":
          // Re-read rather than trust the event's copy: events can arrive out of order.
          await applySubscription(await s.subscription((object as { id: string }).id), s, req.log);
          break;
        case "invoice.created":
          await chargeUsage(object as unknown as StripeInvoice, s, billing, req.log);
          await mirrorInvoice(object as unknown as StripeInvoice);
          break;
        // Money taken back or at risk: logged with the organization, resolved through the charge's customer, for a person to act on.
        case "charge.refunded":
        case "charge.dispute.created":
        case "radar.early_fraud_warning.created": {
          const charge = event.type === "charge.refunded" ? (object as { id: string; customer: string | null }) : await s.charge((object as { charge: string }).charge);
          const organizationId = charge.customer ? await orgOfCustomer(charge.customer) : null;
          req.log.warn({ event: event.type, eventId: event.id, charge: charge.id, organizationId }, "Stripe reported a refund, dispute or fraud warning");
          break;
        }
        default:
          if (event.type.startsWith("invoice.")) await mirrorInvoice(object as unknown as StripeInvoice);
      }
      return reply.code(200).send({ received: true });
    });
  });
}

const orgOfCustomer = async (customer: string) => (await prisma.billingAccount.findUnique({ where: { stripeCustomerId: customer } }))?.organizationId ?? null;

/** Writes a subscription's plan, status and period onto the organization's account. */
async function applySubscription(sub: StripeSubscription, stripe: Stripe, log: FastifyBaseLogger, organizationHint?: string | null) {
  const organizationId = (await orgOfCustomer(sub.customer)) || organizationHint || sub.metadata?.organizationId;
  if (!organizationId || !(await prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true } }))) {
    log.warn({ subscription: sub.id }, "A Stripe subscription names no organization we know; ignored");
    return;
  }
  const ended = ["canceled", "incomplete_expired"].includes(sub.status);
  const priceId = sub.items.data[0]?.price.id;
  const plan = (priceId && stripe.planOfPrice(priceId)) || "free";
  if (plan === "free" && !ended) log.warn({ subscription: sub.id, priceId }, "A Stripe subscription's price matches no STRIPE_PRICE_*; treated as Free");
  const period = periodOf(sub);
  const data = {
    plan: ended ? "free" : plan,
    status: sub.status,
    stripeCustomerId: sub.customer,
    stripeSubscriptionId: ended ? null : sub.id,
    currentPeriodStart: ended ? null : (period?.start ?? null),
    currentPeriodEnd: ended ? null : (period?.end ?? null),
    cancelAtPeriodEnd: !ended && sub.cancel_at_period_end,
  };
  await prisma.billingAccount.upsert({ where: { organizationId }, create: { organizationId, ...data }, update: data });
}

/** Keeps a copy of a Stripe invoice, newest state wins. */
async function mirrorInvoice(inv: StripeInvoice) {
  const organizationId = await orgOfCustomer(inv.customer);
  if (!organizationId) return;
  const data = {
    number: inv.number,
    status: inv.status ?? "draft",
    amountDue: inv.amount_due,
    amountPaid: inv.amount_paid,
    currency: inv.currency,
    hostedInvoiceUrl: inv.hosted_invoice_url,
    periodStart: new Date(inv.period_start * 1000),
    periodEnd: new Date(inv.period_end * 1000),
  };
  await prisma.billingInvoice.upsert({
    where: { id: inv.id },
    create: { id: inv.id, organizationId, createdAt: new Date(inv.created * 1000), ...data },
    update: data,
  });
}

/**
 * Adds the usage of the period that just ended to a renewal invoice while it is a draft: the ledger's billed amount
 * for [period_start, period_end). One UsageCharge per organization and period, and Stripe's idempotency key, so a
 * retried or duplicated webhook adds it once.
 */
async function chargeUsage(inv: StripeInvoice, stripe: Stripe, billing: BillingService, log: FastifyBaseLogger) {
  if (inv.billing_reason !== "subscription_cycle" || inv.status !== "draft") return;
  const organizationId = await orgOfCustomer(inv.customer);
  if (!organizationId) return;
  const periodStart = new Date(inv.period_start * 1000);
  const periodEnd = new Date(inv.period_end * 1000);
  if (periodEnd <= periodStart) return;
  const { amountUsd, events } = await billing.billed(organizationId, periodStart, periodEnd);
  await prisma.usageCharge.createMany({ data: [{ organizationId, periodStart, periodEnd, amountUsd, events }], skipDuplicates: true });
  const charge = await prisma.usageCharge.findUniqueOrThrow({ where: { organizationId_periodStart: { organizationId, periodStart } } });
  const cents = Math.round(charge.amountUsd * 100);
  if (charge.stripeInvoiceItemId || cents <= 0) return;
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const item = await stripe.addInvoiceItem({
    customer: inv.customer,
    invoice: inv.id,
    amountCents: cents,
    description: `Usage ${day(periodStart)} to ${day(periodEnd)} (${charge.events} metered events)`,
    idempotencyKey: `usage-${charge.id}`,
    metadata: { organizationId, usageChargeId: charge.id },
  });
  await prisma.usageCharge.update({ where: { id: charge.id }, data: { stripeInvoiceId: inv.id, stripeInvoiceItemId: item.id } });
  log.info({ organizationId, cents, invoice: inv.id }, "Usage added to the Stripe invoice");
}
