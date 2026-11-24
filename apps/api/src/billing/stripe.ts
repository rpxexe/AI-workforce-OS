// Everything Stripe-specific lives in this file: its REST API (fetch, form-encoded, no SDK), its object shapes and its
// webhook signature. The rest of billing speaks in plans, periods and amounts, so another payment provider means
// rewriting this file and the webhook route's event names.
import { createHmac, timingSafeEqual } from "node:crypto";
import { PLAN_IDS, type PlanId } from "@workforce/shared";

export type StripeConfig = {
  secretKey: string;
  webhookSecret: string;
  /** Stripe Price id per paid plan (STRIPE_PRICE_STARTER, ...). */
  prices: Partial<Record<PlanId, string>>;
  apiBase?: string;
  fetch?: typeof fetch;
};

/** The parts of Stripe's objects billing reads. */
export type StripeSubscription = {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  metadata?: Record<string, string>;
  // Older API versions put the period on the subscription, newer ones on each item.
  current_period_start?: number;
  current_period_end?: number;
  items: { data: { id: string; price: { id: string }; current_period_start?: number; current_period_end?: number }[] };
};
export type StripeInvoice = {
  id: string;
  customer: string;
  number: string | null;
  status: string | null;
  amount_due: number;
  amount_paid: number;
  currency: string;
  hosted_invoice_url: string | null;
  period_start: number;
  period_end: number;
  created: number;
  billing_reason: string | null;
};
export type StripeEvent = { id: string; type: string; data: { object: Record<string, unknown> } };

/** A Stripe API refusal; `status` is its HTTP status. */
export class StripeError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Stripe's form encoding: nested objects and arrays as a[b][0][c]=v. */
export function formEncode(params: Record<string, unknown>, prefix = "", out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === "object") formEncode(value as Record<string, unknown>, name, out);
    else out.append(name, String(value));
  }
  return out;
}

const SIGNATURE_TOLERANCE_S = 300;
/** Pinned so object shapes cannot change under us when the account's default version moves. */
export const STRIPE_API_VERSION = "2026-11-18.endive";
/** Tags our Checkout Sessions in the Dashboard (Stripe asks for a label with an 8-letter random suffix). */
const INTEGRATION_IDENTIFIER = "workforce-plans-qhvmtzke";

export function stripeClient(config: StripeConfig) {
  const base = config.apiBase ?? "https://api.stripe.com";
  const doFetch = config.fetch ?? fetch;

  async function call<T>(method: "GET" | "POST", path: string, params?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
    const body = method === "POST" && params ? formEncode(params).toString() : undefined;
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.secretKey}`,
        "stripe-version": STRIPE_API_VERSION,
        ...(body !== undefined && { "content-type": "application/x-www-form-urlencoded" }),
        ...(idempotencyKey && { "idempotency-key": idempotencyKey }),
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!res.ok) throw new StripeError(res.status, `Stripe answered ${res.status}: ${json.error?.message ?? "no details"}`);
    return json as T;
  }

  return {
    priceOf: (plan: PlanId) => config.prices[plan] ?? null,
    planOfPrice: (priceId: string): PlanId | null => PLAN_IDS.find((p) => config.prices[p] === priceId) ?? null,

    createCustomer: (organizationId: string, name: string) =>
      call<{ id: string }>("POST", "/v1/customers", { name, metadata: { organizationId } }, `customer-${organizationId}`),

    checkout: (o: { customer: string; price: string; organizationId: string; successUrl: string; cancelUrl: string }) =>
      call<{ id: string; url: string }>("POST", "/v1/checkout/sessions", {
        mode: "subscription",
        integration_identifier: INTEGRATION_IDENTIFIER,
        customer: o.customer,
        client_reference_id: o.organizationId,
        line_items: [{ price: o.price, quantity: 1 }],
        subscription_data: { metadata: { organizationId: o.organizationId } },
        success_url: o.successUrl,
        cancel_url: o.cancelUrl,
      }),

    portal: (customer: string, returnUrl: string) => call<{ url: string }>("POST", "/v1/billing_portal/sessions", { customer, return_url: returnUrl }),

    subscription: (id: string) => call<StripeSubscription>("GET", `/v1/subscriptions/${encodeURIComponent(id)}`),

    /** A charge's customer: disputes and early fraud warnings name only the charge. */
    charge: (id: string) => call<{ id: string; customer: string | null; amount: number; currency: string }>("GET", `/v1/charges/${encodeURIComponent(id)}`),

    /** Moves a subscription to another plan's price (prorated by Stripe) and undoes a pending cancellation. */
    changePrice: (sub: StripeSubscription, price: string) =>
      call<StripeSubscription>("POST", `/v1/subscriptions/${encodeURIComponent(sub.id)}`, {
        items: [{ id: sub.items.data[0]?.id, price }],
        cancel_at_period_end: false,
        proration_behavior: "create_prorations",
      }),

    cancelAtPeriodEnd: (id: string) => call<StripeSubscription>("POST", `/v1/subscriptions/${encodeURIComponent(id)}`, { cancel_at_period_end: true }),

    /** A one-off line on a draft invoice; the idempotency key makes a retried webhook add it once. */
    addInvoiceItem: (o: { customer: string; invoice: string; amountCents: number; description: string; idempotencyKey: string; metadata: Record<string, string> }) =>
      call<{ id: string }>(
        "POST",
        "/v1/invoiceitems",
        { customer: o.customer, invoice: o.invoice, amount: o.amountCents, currency: "usd", description: o.description, metadata: o.metadata },
        o.idempotencyKey,
      ),

    /** Checks Stripe-Signature (HMAC-SHA256 of "<t>.<body>", within 5 minutes) and returns the event, or null if forged or stale. */
    verify(rawBody: string, header: string | undefined, now = Date.now()): StripeEvent | null {
      if (!header) return null;
      const parts = header.split(",").map((p) => p.split("=") as [string, string]);
      const t = Number(parts.find(([k]) => k === "t")?.[1]);
      if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > SIGNATURE_TOLERANCE_S) return null;
      const expected = Buffer.from(createHmac("sha256", config.webhookSecret).update(`${t}.${rawBody}`).digest("hex"));
      const valid = parts.some(([k, v]) => k === "v1" && v && v.length === expected.length && timingSafeEqual(Buffer.from(v), expected));
      if (!valid) return null;
      try {
        return JSON.parse(rawBody) as StripeEvent;
      } catch {
        return null;
      }
    },
  };
}

export type Stripe = ReturnType<typeof stripeClient>;

/** The subscription's period: on the subscription in older API versions, on its first item in newer ones. */
export function periodOf(sub: StripeSubscription) {
  const item = sub.items.data[0];
  const start = sub.current_period_start ?? item?.current_period_start;
  const end = sub.current_period_end ?? item?.current_period_end;
  return start && end ? { start: new Date(start * 1000), end: new Date(end * 1000) } : null;
}

/** Stripe from .env, or null without STRIPE_SECRET_KEY (a restricted rk_ key is recommended) and STRIPE_WEBHOOK_SECRET. */
export function stripeFromEnv(env: Record<string, string | undefined> = process.env): StripeConfig | null {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) return null;
  const prices: Partial<Record<PlanId, string>> = {};
  for (const plan of PLAN_IDS) {
    const price = env[`STRIPE_PRICE_${plan.toUpperCase()}`];
    if (price) prices[plan] = price;
  }
  return { secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET, prices };
}
