// Phase 16: the usage ledger (traceable, idempotent, markup on platform cost only), plan limits enforced on the server,
// Stripe (checkout, signed webhooks, subscription sync, usage added to the renewal invoice once, invoices mirrored) with
// a fake Stripe API, the billing overview, and tenant analytics with date ranges. Needs the database from .env.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { AIProvider } from "@workforce/ai-provider";
import { prisma } from "@workforce/database";
import { defaultEmployeeConfig, type AnalyticsReport, type BillingOverview, type ChatStreamEvent, type EmployeeDetail, type UsageSummary, type Workspace } from "@workforce/shared";
import { createToolExecutor, toolRegistry } from "@workforce/tools";
import { buildApp } from "./app.ts";
import { billingService } from "./billing/service.ts";
import { formEncode } from "./billing/stripe.ts";
import { adminOf, deleteOrgs, headerAuth, memberOf, newOrg } from "./testing.ts";

const orgA = newOrg();
const orgB = newOrg();
let app: Awaited<ReturnType<typeof buildApp>>;
let wsA: string;
let wsB: string;
let ava: string;

// The test's own markup; the real one is set only in the server's environment.
const METER = { markup: 0.5, prices: { sttPerMinute: 0.01, ttsPer1kChars: 0.2, callPerMinute: 0.02, emailPerSend: 0.001 } };
const WEBHOOK_SECRET = "whsec_test";

const fake: AIProvider = {
  name: "fake",
  model: "fake-1",
  async *stream() {
    yield { type: "text", text: "Hi" };
    yield { type: "done", inputTokens: 10, outputTokens: 2 };
  },
};

// ---- a fake Stripe ----
type StripeCall = { method: string; path: string; body: URLSearchParams; idempotencyKey: string | null; version: string | null };
let stripeCalls: StripeCall[] = [];
const now = () => Math.floor(Date.now() / 1000);
let subscription = {
  id: "sub_1",
  customer: "cus_1",
  status: "active",
  cancel_at_period_end: false,
  metadata: {} as Record<string, string>,
  items: { data: [{ id: "si_1", price: { id: "price_starter" }, current_period_start: now() - 86_400, current_period_end: now() + 29 * 86_400 }] },
};
const fakeStripe = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const body = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
  const headers = new Headers(init?.headers);
  stripeCalls.push({ method: init?.method ?? "GET", path: url.pathname, body, idempotencyKey: headers.get("idempotency-key"), version: headers.get("stripe-version") });
  const route = `${init?.method ?? "GET"} ${url.pathname}`;
  if (route === "POST /v1/customers") return Response.json({ id: "cus_1" });
  if (route === "POST /v1/checkout/sessions") return Response.json({ id: "cs_1", url: "https://checkout.stripe.test/cs_1" });
  if (route === "POST /v1/billing_portal/sessions") return Response.json({ url: "https://billing.stripe.test/p_1" });
  if (route === "GET /v1/subscriptions/sub_1") return Response.json(subscription);
  if (route === "POST /v1/subscriptions/sub_1") {
    const price = body.get("items[0][price]");
    if (price) subscription.items.data[0]!.price.id = price;
    if (body.has("cancel_at_period_end")) subscription.cancel_at_period_end = body.get("cancel_at_period_end") === "true";
    return Response.json(subscription);
  }
  if (route === "POST /v1/invoiceitems") return Response.json({ id: "ii_1" });
  if (route === "GET /v1/charges/ch_1") return Response.json({ id: "ch_1", customer: "cus_1", amount: 19_900, currency: "usd" });
  return Response.json({ error: { message: `no route ${route}` } }, { status: 404 });
}) as typeof fetch;

const sign = (payload: string, secret = WEBHOOK_SECRET, t = now()) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
const webhook = (event: object, signature?: string) => {
  const payload = JSON.stringify(event);
  return app.inject({ method: "POST", url: "/billing/stripe/webhook", headers: { "content-type": "application/json", "stripe-signature": signature ?? sign(payload) }, payload });
};

const chat = async (payload: object) => {
  const res = await app.inject({ method: "POST", url: `/workspaces/${wsA}/employees/${ava}/messages`, headers: adminOf(orgA), payload });
  return res.payload
    .split("\n\n")
    .filter(Boolean)
    .map((f) => JSON.parse(f.replace(/^data: /, "")) as ChatStreamEvent)
    .at(-1);
};
const overview = async (org = orgA) => (await app.inject({ method: "GET", url: "/billing", headers: memberOf(org) })).json<BillingOverview>();

before(async () => {
  app = await buildApp({
    authenticate: headerAuth,
    provider: fake,
    embedder: { name: "fake", model: "fake-embed", embed: async (texts) => texts.map(() => new Array(1536).fill(0)) },
    logger: false,
    billing: {
      stripe: { secretKey: "sk_test", webhookSecret: WEBHOOK_SECRET, prices: { starter: "price_starter", growth: "price_growth" }, apiBase: "https://stripe.test", fetch: fakeStripe },
      enforced: true,
      meter: METER,
    },
  });
  const first = async (org: string) => (await app.inject({ method: "GET", url: "/workspaces", headers: adminOf(org) })).json<Workspace[]>()[0]!.id;
  wsA = await first(orgA);
  wsB = await first(orgB);
  const created = await app.inject({ method: "POST", url: `/workspaces/${wsA}/employees`, headers: adminOf(orgA), payload: { ...defaultEmployeeConfig(), name: "Ava", role: "Support" } });
  assert.equal(created.statusCode, 201, created.payload);
  ava = created.json<EmployeeDetail>().id;
});
after(async () => {
  await deleteOrgs(orgA, orgB);
  await app.close();
});

test("the ledger: one traceable row per source, metered twice without doubling, markup only on platform cost", async () => {
  const scope = { organizationId: orgA, workspaceId: wsA };
  const usage = (extra: object) => ({ ...scope, task: "chat", requestId: "r", attempt: 1, provider: "fake", model: "m", inputTokens: 0, outputTokens: 0, latencyMs: 100, success: true, ...extra });
  const [platform, ownKey, speech, phone, unknown] = await Promise.all([
    prisma.aiUsage.create({ data: usage({ inputTokens: 1000, outputTokens: 200, costUsd: 0.01 }) }),
    prisma.aiUsage.create({ data: usage({ credentialId: "conn_own", costUsd: 0.02 }) }),
    prisma.aiUsage.create({ data: usage({ providerType: "stt", operation: "live_transcribe", seconds: 120 }) }),
    prisma.aiUsage.create({ data: usage({ providerType: "telephony", operation: "call", seconds: 61 }) }),
    prisma.aiUsage.create({ data: usage({ model: "unpriced-model" }) }),
  ]);
  const conversation = await prisma.conversation.create({
    data: { ...scope, employeeId: ava, channel: "whatsapp", title: "Hi", createdBy: "test", messages: { create: [{ role: "USER", content: "hi" }, { role: "ASSISTANT", content: "hello" }] } },
  });
  await prisma.conversation.create({ data: { ...scope, employeeId: ava, channel: "evaluation", title: "Replay", createdBy: "test", messages: { create: [{ role: "ASSISTANT", content: "x" }] } } });
  const call = { ...scope, employeeId: ava, employeeVersion: 1, direction: "INBOUND" as const, status: "COMPLETED" as const, from: "+15550001", to: "+15550002", greeting: "" };
  const settled = await prisma.call.create({ data: { ...call, durationSec: 61, endedAt: new Date(Date.now() - 20 * 60_000) } });
  const fresh = await prisma.call.create({ data: { ...call, durationSec: 30, endedAt: new Date() } });
  const tool = { ...scope, employeeId: ava, conversationId: conversation.id, tool: "send_email", input: {}, attempts: 1, durationMs: 5 };
  const ran = await prisma.toolExecution.create({ data: { ...tool, id: randomUUID(), status: "SUCCEEDED" } });
  const denied = await prisma.toolExecution.create({ data: { ...tool, id: randomUUID(), status: "DENIED" } });

  const billing = billingService({ ...METER, enforced: true }, app.log);
  const since = new Date(Date.now() - 3_600_000);
  const added = await billing.meter(orgA, since);
  assert.equal(await billing.meter(orgA, since), 0, "metering again adds nothing");
  assert.equal(await billing.meter(null, since) >= 0, true);
  assert.equal(await prisma.usageEvent.count({ where: { organizationId: orgA, id: { startsWith: "ai_usage:" } } }), 5);

  const row = (id: string) => prisma.usageEvent.findUniqueOrThrow({ where: { id } });
  const p = await row(`ai_usage:${platform.id}`);
  assert.equal(p.kind, "provider");
  assert.equal(p.sourceType, "ai_usage");
  assert.equal(p.sourceId, platform.id, "traceable to the AiUsage row");
  assert.equal(p.quantity, 1200);
  assert.equal(p.costUsd, 0.01);
  assert.ok(Math.abs(p.amountUsd! - 0.015) < 1e-9, "cost x (1 + markup)");
  assert.equal((await row(`ai_usage:${ownKey.id}`)).amountUsd, 0, "own keys are paid to the vendor");
  const s = await row(`ai_usage:${speech.id}`);
  assert.ok(Math.abs(s.costUsd! - 0.02) < 1e-9 && Math.abs(s.amountUsd! - 0.03) < 1e-9, "platform speech priced per minute");
  assert.equal((await row(`ai_usage:${phone.id}`)).amountUsd, 0, "telephony is billed on the call");
  assert.equal((await row(`ai_usage:${unknown.id}`)).amountUsd, null, "unknown cost: recorded, not billed");
  const minutes = await row(`call:${settled.id}`);
  assert.equal(minutes.quantity, 2, "61 s rounds up to 2 minutes");
  assert.ok(Math.abs(minutes.amountUsd! - 0.06) < 1e-9);
  assert.equal(await prisma.usageEvent.count({ where: { id: `call:${fresh.id}` } }), 0, "a call that just ended waits to settle");
  assert.ok(await prisma.usageEvent.findUnique({ where: { id: `tool_execution:${ran.id}` } }));
  assert.equal(await prisma.usageEvent.count({ where: { id: `tool_execution:${denied.id}` } }), 0, "denied tool calls are not billed");
  assert.equal(await prisma.usageEvent.count({ where: { organizationId: orgA, kind: "conversation" } }), 1, "regression replays are not usage");
  assert.equal(await prisma.usageEvent.count({ where: { organizationId: orgA, kind: "message" } }), 1);
  assert.ok(added >= 9);

  const usage1 = (await app.inject({ method: "GET", url: `/billing/usage?from=${new Date(Date.now() - 86_400_000).toISOString()}&to=${new Date(Date.now() + 60_000).toISOString()}`, headers: memberOf(orgA) })).json<UsageSummary>();
  assert.ok(!("unpriced" in usage1) && !("costUsd" in usage1), "tenants never see provider cost");
  assert.ok(Math.abs(usage1.amountUsd - (0.015 + 0.03 + 0.06)) < 1e-6);
  assert.ok(usage1.recent.some((e) => e.sourceType === "call" && e.sourceId === settled.id));
  const usageB = (await app.inject({ method: "GET", url: `/billing/usage?from=2026-01-01&to=2027-01-01`, headers: memberOf(orgB) })).json<UsageSummary>();
  assert.equal(usageB.recent.length, 0, "another organization sees none of it");
  assert.equal((await app.inject({ method: "GET", url: "/billing/usage?from=2026-02-01&to=2026-01-01", headers: memberOf(orgA) })).statusCode, 400);
});

test("limits on the Free plan: employees, conversations, messages, tool calls, storage, voice minutes", async () => {
  // Employees: Free allows 1 (archived ones do not count).
  const second = await app.inject({ method: "POST", url: `/workspaces/${wsA}/employees`, headers: adminOf(orgA), payload: { ...defaultEmployeeConfig(), name: "Bo", role: "Sales" } });
  assert.equal(second.statusCode, 402);
  assert.match(second.json<{ error: string }>().error, /Free plan limit for ai employees \(1\)/);

  // Conversations: 100 a period; a new one is refused, an existing one goes on.
  const scope = { organizationId: orgA, workspaceId: wsA, employeeId: ava, createdBy: "test", channel: "test", title: "x" };
  await prisma.conversation.createMany({ data: Array.from({ length: 100 }, () => scope) });
  const refused = await chat({ message: "Hello" });
  assert.equal(refused?.type, "error");
  assert.match((refused as { error: string }).error, /conversations per period \(100\)/);
  const existing = await prisma.conversation.findFirstOrThrow({ where: { organizationId: orgA, channel: "test" } });
  assert.equal((await chat({ message: "Hello again", conversationId: existing.id }))?.type, "done");

  // Messages: 500 AI messages a period.
  await prisma.conversationMessage.createMany({ data: Array.from({ length: 500 }, () => ({ conversationId: existing.id, role: "ASSISTANT" as const, content: "." })) });
  const noMore = await chat({ message: "And again", conversationId: existing.id });
  assert.match((noMore as { error: string }).error, /ai messages per period \(500\)/);
  assert.equal(await prisma.conversationMessage.count({ where: { conversationId: existing.id, content: "And again" } }), 0, "a refused turn saves nothing");

  // Tool calls: 200 a period; the next is DENIED (and DENIED calls are not usage).
  const billing = billingService({ ...METER, enforced: true }, app.log);
  const tool = { organizationId: orgA, workspaceId: wsA, employeeId: ava, conversationId: existing.id, tool: "send_email", input: {}, attempts: 1, durationMs: 1, status: "SUCCEEDED" as const };
  await prisma.toolExecution.createMany({ data: Array.from({ length: 200 }, () => ({ ...tool, id: randomUUID() })) });
  await prisma.toolPermission.create({ data: { employeeId: ava, tool: "send_email", config: {}, grantedBy: "test", permissions: [...toolRegistry.get("send_email")!.permissions] } });
  const executor = createToolExecutor(toolRegistry, { planLimits: billing.check });
  const outcome = await executor.execute(
    { id: "c1", name: "send_email", input: { to: "a@example.com", subject: "s", body: "b" } },
    { organizationId: orgA, workspaceId: wsA, employeeId: ava, conversationId: existing.id, timezone: "UTC" },
    AbortSignal.timeout(5000),
  );
  assert.equal(outcome.status, "DENIED");
  assert.match(outcome.result.content, /tool calls per period \(200\)/);

  // Knowledge storage: 50 MB.
  const source = await app.inject({ method: "POST", url: `/workspaces/${wsA}/knowledge/sources`, headers: adminOf(orgA), payload: { name: "Docs" } });
  const sourceId = source.json<{ id: string }>().id;
  await prisma.knowledgeDocument.create({ data: { organizationId: orgA, workspaceId: wsA, sourceId, name: "big.txt", kind: "txt", sizeBytes: 50 * 1_048_576, createdBy: "test" } });
  const upload = await app.inject({
    method: "POST",
    url: `/workspaces/${wsA}/knowledge/sources/${sourceId}/documents?name=a.txt`,
    headers: { ...adminOf(orgA), "content-type": "application/octet-stream" },
    payload: Buffer.from("hello"),
  });
  assert.equal(upload.statusCode, 402);
  assert.match(upload.json<{ error: string }>().error, /knowledge storage/);

  // Voice minutes: 30 a period (the 2 metered above plus 29 more).
  await prisma.call.create({
    data: { organizationId: orgA, workspaceId: wsA, employeeId: ava, employeeVersion: 1, direction: "OUTBOUND", status: "COMPLETED", from: "+1", to: "+2", greeting: "", durationSec: 29 * 60, endedAt: new Date(Date.now() - 20 * 60_000) },
  });
  await billing.meter(orgA, new Date(Date.now() - 3_600_000));
  assert.match((await billing.check(orgA, ["voiceMinutes"])) ?? "", /voice minutes per period \(30\)/);

  // The overview shows every limit with its use; members can read it.
  const o = await overview();
  assert.equal(o.plan, "free");
  assert.equal(o.enforced, true);
  const limit = (key: string) => o.limits.find((l) => l.key === key)!;
  assert.deepEqual([limit("employees").used, limit("employees").limit], [1, 1]);
  assert.equal(limit("conversations").used, 101);
  assert.equal(limit("messages").used, 502);
  assert.equal(limit("toolCalls").used, 201);
  assert.equal(limit("voiceMinutes").used, 31);

  // Without billing on, nothing is limited.
  assert.equal(await billingService({ ...METER, enforced: false }, app.log).check(orgA, ["messages", "employees"]), null);
});

test("Stripe: checkout, signed webhooks, the plan follows the subscription, usage added to the renewal invoice once", async () => {
  // Members cannot buy; admins get a Checkout page; the customer is created once.
  assert.equal((await app.inject({ method: "POST", url: "/billing/checkout", headers: memberOf(orgA), payload: { plan: "starter" } })).statusCode, 403);
  stripeCalls = [];
  const checkout = await app.inject({ method: "POST", url: "/billing/checkout", headers: adminOf(orgA), payload: { plan: "starter" } });
  assert.equal(checkout.statusCode, 200, checkout.payload);
  assert.equal(checkout.json<{ url: string }>().url, "https://checkout.stripe.test/cs_1");
  const session = stripeCalls.find((c) => c.path === "/v1/checkout/sessions")!;
  assert.equal(session.body.get("client_reference_id"), orgA);
  assert.equal(session.body.get("line_items[0][price]"), "price_starter");
  assert.equal(session.body.get("subscription_data[metadata][organizationId]"), orgA);
  assert.match(session.body.get("integration_identifier") ?? "", /^workforce-plans-[a-z]{8}$/);
  assert.ok(!session.body.has("payment_method_types"), "Stripe picks payment methods dynamically");
  assert.ok(stripeCalls.every((c) => c.version === "2026-11-18.endive"), "every call pins the API version");
  await app.inject({ method: "POST", url: "/billing/checkout", headers: adminOf(orgA), payload: { plan: "starter" } });
  assert.equal(stripeCalls.filter((c) => c.path === "/v1/customers").length, 1, "one Stripe customer per organization");
  assert.equal((await app.inject({ method: "POST", url: "/billing/checkout", headers: adminOf(orgA), payload: { plan: "scale" } })).statusCode, 503, "no price for that plan");

  // Webhooks: forged or stale signatures are refused.
  const completed = { id: "evt_1", type: "checkout.session.completed", data: { object: { client_reference_id: orgA, subscription: "sub_1", customer: "cus_1" } } };
  assert.equal((await webhook(completed, sign(JSON.stringify(completed), "whsec_wrong"))).statusCode, 400);
  assert.equal((await webhook(completed, sign(JSON.stringify(completed), WEBHOOK_SECRET, now() - 600))).statusCode, 400);
  assert.equal((await webhook(completed)).statusCode, 200);
  let o = await overview();
  assert.ok(!("markup" in o), "the markup is never sent to tenants");
  assert.equal(o.plan, "starter");
  assert.equal(o.hasSubscription, true);
  assert.equal(new Date(o.period.end).getTime(), subscription.items.data[0]!.current_period_end * 1000);
  // Starter allows 1,000 conversations: a new one is answered again.
  assert.equal((await chat({ message: "Hello after upgrading" }))?.type, "done");

  // Changing plan moves the subscription's price; Stripe's own event (re-read, so order does not matter) agrees.
  stripeCalls = [];
  assert.equal((await app.inject({ method: "POST", url: "/billing/checkout", headers: adminOf(orgA), payload: { plan: "growth" } })).json<{ url: null }>().url, null);
  assert.equal(stripeCalls.find((c) => c.method === "POST" && c.path === "/v1/subscriptions/sub_1")?.body.get("items[0][price]"), "price_growth");
  assert.equal((await overview()).plan, "growth");
  assert.equal((await webhook({ id: "evt_2", type: "customer.subscription.updated", data: { object: { id: "sub_1" } } })).statusCode, 200);
  assert.equal((await overview()).plan, "growth");

  // The renewal invoice (a draft) gets the period's usage: the ledger's billed amount, once.
  const periodStart = now() - 2 * 86_400;
  const periodEnd = now() + 60;
  const invoice = {
    id: "in_1",
    customer: "cus_1",
    number: null,
    status: "draft",
    amount_due: 19_900,
    amount_paid: 0,
    currency: "usd",
    hosted_invoice_url: null,
    period_start: periodStart,
    period_end: periodEnd,
    created: now(),
    billing_reason: "subscription_cycle",
  };
  stripeCalls = [];
  assert.equal((await webhook({ id: "evt_3", type: "invoice.created", data: { object: invoice } })).statusCode, 200);
  assert.equal((await webhook({ id: "evt_3", type: "invoice.created", data: { object: invoice } })).statusCode, 200, "Stripe delivers again");
  const items = stripeCalls.filter((c) => c.path === "/v1/invoiceitems");
  assert.equal(items.length, 1, "usage is added once");
  const { _sum } = await prisma.usageEvent.aggregate({ where: { organizationId: orgA, occurredAt: { gte: new Date(periodStart * 1000), lt: new Date(periodEnd * 1000) } }, _sum: { amountUsd: true } });
  assert.equal(items[0]!.body.get("amount"), String(Math.round((_sum.amountUsd ?? 0) * 100)));
  assert.equal(items[0]!.body.get("invoice"), "in_1");
  const charge = await prisma.usageCharge.findFirstOrThrow({ where: { organizationId: orgA } });
  assert.equal(items[0]!.idempotencyKey, `usage-${charge.id}`);
  assert.equal(charge.stripeInvoiceItemId, "ii_1");

  // Invoices are mirrored, newest state wins.
  await webhook({ id: "evt_4", type: "invoice.paid", data: { object: { ...invoice, status: "paid", number: "INV-1", amount_paid: 19_900, hosted_invoice_url: "https://invoice.stripe.test/1" } } });
  o = await overview();
  assert.deepEqual(o.invoices.map((i) => [i.id, i.status, i.number, i.amountPaid]), [["in_1", "paid", "INV-1", 19_900]]);
  assert.equal((await overview(orgB)).invoices.length, 0, "another organization sees no invoices");
  assert.equal((await overview(orgB)).plan, "free");

  // Disputes and fraud warnings name a charge; it is fetched to find the organization.
  stripeCalls = [];
  assert.equal((await webhook({ id: "evt_6", type: "charge.dispute.created", data: { object: { id: "dp_1", charge: "ch_1" } } })).statusCode, 200);
  assert.ok(stripeCalls.some((c) => c.path === "/v1/charges/ch_1"));

  // The portal; cancelling the subscription returns the organization to Free.
  assert.equal((await app.inject({ method: "POST", url: "/billing/portal", headers: adminOf(orgA) })).json<{ url: string }>().url, "https://billing.stripe.test/p_1");
  assert.equal((await app.inject({ method: "POST", url: "/billing/portal", headers: adminOf(orgB) })).statusCode, 409);
  subscription = { ...subscription, status: "canceled" };
  await webhook({ id: "evt_5", type: "customer.subscription.deleted", data: { object: { id: "sub_1" } } });
  o = await overview();
  assert.equal(o.plan, "free");
  assert.equal(o.hasSubscription, false);
});

test("analytics report: a date range, tenant-scoped, workspace filter checked", async () => {
  const from = new Date(Date.now() - 86_400_000).toISOString();
  const to = new Date(Date.now() + 60_000).toISOString();
  const res = await app.inject({ method: "GET", url: `/analytics/report?from=${from}&to=${to}`, headers: memberOf(orgA) });
  assert.equal(res.statusCode, 200, res.payload);
  const r = res.json<AnalyticsReport>();
  assert.ok(r.conversations.total >= 102, "the seeded and chatted conversations, not the replay");
  assert.ok(!r.conversations.byChannel.some((c) => c.channel === "evaluation"));
  assert.ok(r.messages.ai >= 503);
  assert.equal(r.calls.total, 3);
  assert.ok(r.tokens.input >= 1000);
  assert.ok(r.toolExecutions.total >= 202);
  assert.ok(r.cost.billedUsd > 0);
  assert.deepEqual(Object.keys(r.cost), ["billedUsd"], "no provider cost in reports");
  assert.equal(r.daily.length, 2, "one row per UTC day in the range");
  assert.ok(r.latency.provider.count >= 1);

  const b = (await app.inject({ method: "GET", url: `/analytics/report?from=${from}&to=${to}`, headers: memberOf(orgB) })).json<AnalyticsReport>();
  assert.deepEqual([b.conversations.total, b.calls.total, b.tokens.input, b.cost.billedUsd], [0, 0, 0, 0], "nothing from another organization");
  assert.equal((await app.inject({ method: "GET", url: `/analytics/report?from=${from}&to=${to}&workspaceId=${wsB}`, headers: memberOf(orgA) })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `/analytics/report?from=${from}&to=${to}&workspaceId=${wsA}`, headers: memberOf(orgA) })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: `/analytics/report?from=${to}&to=${from}`, headers: memberOf(orgA) })).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: `/analytics/report?from=2024-01-01&to=2026-01-01`, headers: memberOf(orgA) })).statusCode, 400, "at most 366 days");
  assert.equal((await app.inject({ method: "GET", url: `/analytics/report?from=${from}&to=${to}` })).statusCode, 401);
});

test("Stripe form encoding", () => {
  assert.equal(formEncode({ a: 1, line_items: [{ price: "p", quantity: 1 }], m: { k: "v" }, skip: undefined }).toString(), "a=1&line_items%5B0%5D%5Bprice%5D=p&line_items%5B0%5D%5Bquantity%5D=1&m%5Bk%5D=v");
});
