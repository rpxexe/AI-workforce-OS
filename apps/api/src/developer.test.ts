// Needs the database from .env to be running (pnpm infra:up && pnpm db:migrate).
// Phase 17: API keys (hashing, scopes, rotation, revocation, last use), the public API (/v1) through the SDK, idempotency,
// the OpenAPI document, and webhooks (events found from rows, Standard Webhooks signatures, retries, give-up, redelivery).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import type { AIProvider, EmbeddingProvider } from "@workforce/ai-provider";
import { prisma } from "@workforce/database";
import { EXTRACTION_PROMPT, memoryService } from "@workforce/memory";
import { createClient, verifyWebhook, WebhookVerificationError, WorkforceError } from "@workforce/sdk";
import {
  blankWorkflow,
  defaultEmployeeConfig,
  PUBLIC_ROUTES,
  WEBHOOK_EVENTS,
  type ApiKeyInfo,
  type CreatedApiKey,
  type CreatedWebhookEndpoint,
  type EmployeeDetail,
  type DeveloperAuditEntry,
  type WebhookDeliveryPage,
  type WebhookDeliveryRecord,
  type WebhookEvent,
  type Workspace,
} from "@workforce/shared";
import { buildApp } from "./app.ts";
import { renderTypes } from "../../../packages/sdk/generate.ts";
import { ipAllowed } from "./public/keys.ts";
import { MAX_ATTEMPTS, signWebhook, webhookService } from "./public/webhooks.ts";
import { adminOf, deleteOrgs, headerAuth, memberOf, newOrg } from "./testing.ts";

const KEY = "developer-test-credentials-key-0123456789";
const HOOK_URL = "https://203.0.113.10/hooks"; // TEST-NET-3: public, never resolved
const orgA = newOrg();
const orgB = newOrg();
let app: Awaited<ReturnType<typeof buildApp>>;
let ws: string;
let wsB: string;
let ava: string;

let modelCalls = 0;
const model: AIProvider = {
  name: "fake",
  model: "fake-1",
  async *stream(req) {
    if (req.system.startsWith(EXTRACTION_PROMPT)) {
      yield { type: "text", text: '{"memories":[]}' };
      yield { type: "done", inputTokens: 1, outputTokens: 1 };
      return;
    }
    modelCalls++;
    yield { type: "text", text: "Happy to help." };
    yield { type: "done", inputTokens: 1, outputTokens: 1 };
  },
};
const memory = memoryService(model, 5000);
/** Knowledge uploads are embedded in the background; never by a real provider here. */
const embedder: EmbeddingProvider = { name: "fake", model: "fake-embed", embed: async (texts) => texts.map(() => Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0))) };

const call = (method: string, url: string, payload?: unknown, headers: Record<string, string> = adminOf(orgA)) =>
  app.inject({ method: method as "GET", url, payload: payload as object, headers });

/** The SDK's fetch, answered by the app in process. */
const viaApp: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const res = await app.inject({
    method: (init?.method ?? "GET") as "GET",
    url: url.pathname + url.search,
    headers: init?.headers as Record<string, string>,
    payload: init?.body as string | undefined,
  });
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) if (value !== undefined) headers.set(name, String(value));
  return new Response(res.payload, { status: res.statusCode, headers });
};

const createKey = async (scopes: string[], org = orgA, workspaceId = ws) => {
  const res = await call("POST", "/developer/api-keys", { name: "Integration", workspaceId, scopes }, adminOf(org));
  assert.equal(res.statusCode, 201, res.payload);
  return res.json<CreatedApiKey>();
};
const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });
const createKeyWith = async (settings: Record<string, unknown>) => {
  const res = await call("POST", "/developer/api-keys", { name: "Integration", workspaceId: ws, ...settings });
  assert.equal(res.statusCode, 201, res.payload);
  return res.json<CreatedApiKey>();
};

// Webhook receiver: records every request; answers with `answer`.
type Received = { url: string; headers: Record<string, string>; body: string };
let received: Received[] = [];
let answer = 200;
const receiver: typeof fetch = async (input, init) => {
  received.push({ url: String(input), headers: init?.headers as Record<string, string>, body: init?.body as string });
  return new Response("ok", { status: answer });
};
let hooks: ReturnType<typeof webhookService>;
let endpoint: CreatedWebhookEndpoint;
const deliveries = async () => prisma.webhookDelivery.findMany({ where: { organizationId: orgA }, orderBy: { createdAt: "asc" } });

before(async () => {
  app = await buildApp({
    authenticate: headerAuth,
    provider: model,
    embedder,
    memory: () => memory,
    logger: false,
    credentialsKey: KEY,
    workflows: { intervalMs: 50 },
    webhooks: { fetch: receiver },
  });
  await app.ready();
  hooks = webhookService({ secret: KEY, fetch: receiver, log: app.log });
  const workspaceOf = async (org: string) => (await call("GET", "/workspaces", undefined, adminOf(org))).json<Workspace[]>()[0]?.id ?? "";
  ws = await workspaceOf(orgA);
  wsB = await workspaceOf(orgB);
  const config = defaultEmployeeConfig("UTC");
  const created = await call("POST", `/workspaces/${ws}/employees`, { ...config, name: "Ava", role: "Support agent", escalation: { ...config.escalation, enabled: true, contactEmail: "team@example.test" } });
  assert.equal(created.statusCode, 201, created.payload);
  ava = created.json<EmployeeDetail>().id;
  assert.equal((await call("POST", `/workspaces/${ws}/employees/${ava}/publish`, { version: 1 })).statusCode, 200);
});
after(async () => {
  await app.close();
  await deleteOrgs(orgA, orgB);
});

test("API keys: created once, stored as a hash, scoped, rotated, revoked", async () => {
  assert.equal((await call("POST", "/developer/api-keys", { name: "x", workspaceId: ws, scopes: ["employees:read"] }, memberOf(orgA))).statusCode, 403);
  assert.equal((await call("POST", "/developer/api-keys", { name: "x", workspaceId: wsB, scopes: ["employees:read"] })).statusCode, 404);
  const bad = await call("POST", "/developer/api-keys", { name: "x", workspaceId: ws, scopes: ["everything"] });
  assert.equal(bad.statusCode, 400);

  const { key, secret } = await createKey(["employees:read"]);
  assert.match(secret, /^wfk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
  assert.equal(key.status, "active");
  assert.ok(secret.startsWith(key.prefix));
  const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: key.id } });
  assert.ok(!JSON.stringify(row).includes(secret.slice(key.prefix.length)), "the secret is not stored");
  assert.equal(row.hash.length, 64);
  const list = await call("GET", "/developer/api-keys", undefined, memberOf(orgA));
  assert.equal(list.statusCode, 200);
  assert.ok(!list.payload.includes(secret.slice(key.prefix.length)), "never listed");

  // Authentication and scopes.
  const noKey = await call("GET", "/v1/employees", undefined, {});
  assert.equal(noKey.statusCode, 401);
  assert.equal(noKey.json().error.type, "authentication_failed");
  const forged = `${secret.slice(0, -4)}AAAA`;
  assert.equal((await call("GET", "/v1/employees", undefined, bearer(forged))).statusCode, 401);
  const ok = await call("GET", "/v1/employees", undefined, bearer(secret));
  assert.equal(ok.statusCode, 200, ok.payload);
  assert.ok(ok.headers["request-id"]);
  const denied = await call("GET", "/v1/customers", undefined, bearer(secret));
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.type, "permission_denied");

  // Last use is recorded (not awaited by the request).
  for (let i = 0; i < 50 && !(await prisma.apiKey.findUniqueOrThrow({ where: { id: key.id } })).lastUsedAt; i++) await sleep(20);
  const used = await prisma.apiKey.findUniqueOrThrow({ where: { id: key.id } });
  assert.ok(used.lastUsedAt);
  assert.ok(used.lastUsedIp);

  // Another organization's key sees nothing of ours.
  const other = await createKey(["employees:read"], orgB, wsB);
  assert.equal((await call("GET", `/v1/employees/${ava}`, undefined, bearer(other.secret))).statusCode, 404);
  assert.equal((await call("GET", "/v1/employees", undefined, bearer(other.secret))).json().data.length, 0);
  assert.equal((await call("DELETE", `/developer/api-keys/${key.id}`, undefined, adminOf(orgB))).statusCode, 404);

  // Rotation with a grace period: both work until it ends.
  const rotated = await call("POST", `/developer/api-keys/${key.id}/rotate`, { expireOldInHours: 1 });
  assert.equal(rotated.statusCode, 201, rotated.payload);
  const next = rotated.json<CreatedApiKey>();
  assert.equal(next.key.name, key.name);
  assert.deepEqual(next.key.scopes, key.scopes);
  assert.notEqual(next.secret, secret);
  assert.equal((await call("GET", "/v1/employees", undefined, bearer(secret))).statusCode, 200);
  assert.equal((await call("GET", "/v1/employees", undefined, bearer(next.secret))).statusCode, 200);
  const old = (await call("GET", "/developer/api-keys")).json<ApiKeyInfo[]>().find((k) => k.id === key.id)!;
  assert.equal(old.status, "expiring");
  assert.equal(old.replacedById, next.key.id);
  assert.equal((await call("POST", `/developer/api-keys/${key.id}/rotate`, {})).statusCode, 409, "an expiring key is not rotated twice");
  // The grace period ends.
  await prisma.apiKey.update({ where: { id: key.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.match((await call("GET", "/v1/employees", undefined, bearer(secret))).json().error.message, /expired/);

  // Rotation without grace revokes at once; revoking works and is idempotent.
  const immediate = (await call("POST", `/developer/api-keys/${next.key.id}/rotate`, { expireOldInHours: 0 })).json<CreatedApiKey>();
  assert.match((await call("GET", "/v1/employees", undefined, bearer(next.secret))).json().error.message, /revoked/);
  assert.equal((await call("DELETE", `/developer/api-keys/${immediate.key.id}`, undefined, memberOf(orgA))).statusCode, 403);
  const revoked = await call("DELETE", `/developer/api-keys/${immediate.key.id}`);
  assert.equal(revoked.json<ApiKeyInfo>().status, "revoked");
  assert.equal((await call("DELETE", `/developer/api-keys/${immediate.key.id}`)).statusCode, 200);
  assert.equal((await call("GET", "/v1/employees", undefined, bearer(immediate.secret))).statusCode, 401);
});

test("webhook endpoints: admins only, public https, secret shown once and sealed", async () => {
  const body = { url: HOOK_URL, workspaceId: ws, events: [...WEBHOOK_EVENTS], description: "CRM" };
  assert.equal((await call("POST", "/developer/webhooks", body, memberOf(orgA))).statusCode, 403);
  const priv = await call("POST", "/developer/webhooks", { ...body, url: "https://127.0.0.1/hook" });
  assert.equal(priv.statusCode, 400);
  assert.equal(priv.json().issues[0].path, "url");
  assert.equal((await call("POST", "/developer/webhooks", { ...body, url: "http://203.0.113.10/hook" })).statusCode, 400);
  assert.equal((await call("POST", "/developer/webhooks", { ...body, workspaceId: wsB })).statusCode, 404);

  const created = await call("POST", "/developer/webhooks", body);
  assert.equal(created.statusCode, 201, created.payload);
  endpoint = created.json<CreatedWebhookEndpoint>();
  assert.match(endpoint.secret, /^whsec_/);
  const row = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.endpoint.id } });
  assert.ok(!row.encryptedSecret.includes(endpoint.secret.slice(6)));
  const list = await call("GET", "/developer/webhooks", undefined, memberOf(orgA));
  assert.ok(!list.payload.includes(endpoint.secret.slice(6)));
  assert.equal((await call("GET", "/developer/webhooks", undefined, adminOf(orgB))).json().length, 0);
  assert.equal((await call("PATCH", `/developer/webhooks/${endpoint.endpoint.id}`, { enabled: false }, adminOf(orgB))).statusCode, 404);
});

test("the public API through the SDK: messages, idempotency, paging, shapes, events delivered and signed", async () => {
  const { secret } = await createKey(["employees:read", "conversations:read", "conversations:write", "customers:read", "analytics:read"]);
  const wf = createClient({ apiKey: secret, fetch: viaApp, maxRetries: 0 });

  // Contract shapes: only the documented fields.
  const employees = await wf.employees.list();
  assert.deepEqual(Object.keys(employees.data[0]!).sort(), Object.keys(PUBLIC_ROUTES.getEmployee.response.shape).sort());
  assert.equal(employees.data[0]!.status, "active");
  assert.equal(employees.data[0]!.publishedVersion, 1);

  // A message with an idempotency key: the retry replays the first answer, the model is called once.
  modelCalls = 0;
  const first = await wf.employees.sendMessage(ava, { message: "What are your hours?", customer: "Rahul@Example.com" }, { idempotencyKey: "msg-1" });
  assert.equal(first.status, "answered");
  assert.equal(first.reply?.text, "Happy to help.");
  assert.equal(first.reply?.role, "employee");
  assert.equal(first.message.role, "customer");
  const again = await wf.employees.sendMessage(ava, { message: "What are your hours?", customer: "Rahul@Example.com" }, { idempotencyKey: "msg-1" });
  assert.deepEqual(again, first);
  assert.equal(modelCalls, 1);
  const replay = await call("POST", `/v1/employees/${ava}/messages`, { message: "x" }, { ...bearer(secret), "idempotency-key": "msg-1" });
  assert.equal(replay.headers["idempotent-replayed"], "true");

  // The conversation continues; it is on the api channel with the customer remembered by their normalized id.
  const second = await wf.employees.sendMessage(ava, { message: "And on Sunday?", conversationId: first.conversationId });
  assert.equal(second.conversationId, first.conversationId);
  const conversation = await wf.conversations.get(first.conversationId);
  assert.equal(conversation.channel, "api");
  assert.equal(conversation.messages.length, 4);
  const customer = await wf.customers.get(conversation.customerId!);
  assert.equal(customer.externalId, "rahul@example.com");
  assert.equal((await wf.customers.list({ externalId: "rahul@example.com" })).data.length, 1);

  // Paging.
  await wf.employees.sendMessage(ava, { message: "Another question" });
  const page1 = await wf.conversations.list({ limit: 1 });
  assert.equal(page1.data.length, 1);
  assert.ok(page1.nextCursor);
  const page2 = await wf.conversations.list({ limit: 1, cursor: page1.nextCursor! });
  assert.notEqual(page2.data[0]!.id, page1.data[0]!.id);
  const all: string[] = [];
  for await (const c of wf.paginate(wf.conversations.list, { limit: 1 })) all.push(c.id);
  assert.equal(all.length, 2);

  // Errors in the public format.
  await assert.rejects(wf.conversations.list({ limit: 500 }), (err: WorkforceError) => err.status === 400 && err.type === "invalid_request" && err.issues[0]?.path === "limit");
  await assert.rejects(wf.employees.sendMessage("nope", { message: "hi" }), (err: WorkforceError) => err.status === 404 && err.type === "not_found");
  await assert.rejects(wf.workflows.list(), (err: WorkforceError) => err.status === 403);

  // Analytics for today, no internal cost fields.
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const analytics = await wf.analytics.get({ from: today, to: tomorrow });
  assert.ok(analytics.conversations.total >= 2);
  assert.ok(analytics.messages.employee >= 3);
  assert.ok(!JSON.stringify(analytics).includes("markup"));

  // Webhooks: events since the endpoint was created, queued once, signed, verifiable with the SDK.
  received = [];
  answer = 200;
  await hooks.tick(orgA);
  assert.equal(await hooks.scan(orgA), 0, "scanning again queues nothing");
  const types = received.map((r) => JSON.parse(r.body).type as string);
  assert.equal(types.filter((t) => t === "conversation.started").length, 2);
  assert.equal(types.filter((t) => t === "message.received").length, 3);
  assert.equal(types.filter((t) => t === "message.sent").length, 3);
  for (const r of received) {
    assert.equal(r.url, HOOK_URL);
    const event = await verifyWebhook(r.body, r.headers, endpoint.secret);
    assert.equal(event.id, r.headers["webhook-id"]);
    assert.equal(event.workspaceId, ws);
  }
  const sent = received.map((r) => JSON.parse(r.body) as WebhookEvent).find((e) => e.type === "message.sent" && e.data.conversationId === first.conversationId)!;
  assert.deepEqual(Object.keys(sent.data).sort(), ["conversationId", "createdAt", "id", "role", "text"]);
  assert.equal((await deliveries()).every((d) => d.status === "succeeded" && d.attempts === 1), true);

  // Tampering and replays are refused.
  const r = received[0]!;
  await assert.rejects(verifyWebhook(r.body.replace("}", ', "x": 1}'), r.headers, endpoint.secret), WebhookVerificationError);
  await assert.rejects(verifyWebhook(r.body, r.headers, endpoint.secret, { now: Date.now() + 3600_000 }), /too old/);
  await assert.rejects(verifyWebhook(r.body, r.headers, "whsec_" + Buffer.from("another secret here!").toString("base64")), /does not match/);

  // Handoff: the request for a person hands off, the next message is held for people.
  const handoff = await wf.employees.sendMessage(ava, { message: "Can I talk to a human please?" });
  assert.equal(handoff.handoff, true);
  const held = await wf.employees.sendMessage(ava, { message: "Hello?", conversationId: handoff.conversationId });
  assert.equal(held.status, "held");
  assert.equal(held.reply, null);
  // An agent answers from the inbox; the integration reads it from the conversation (nothing is sent anywhere).
  const agent = await call("POST", `/workspaces/${ws}/conversations/${handoff.conversationId}/messages`, { text: "Hi, Priya here." }, memberOf(orgA));
  assert.equal(agent.statusCode, 200, agent.payload);
  assert.equal((await wf.conversations.get(handoff.conversationId)).messages.at(-1)?.role, "agent");
  // Resolving it from the inbox completes the conversation.
  assert.equal((await call("PATCH", `/workspaces/${ws}/conversations/${handoff.conversationId}`, { action: "resolve" })).statusCode, 200);
  received = [];
  await hooks.tick(orgA);
  const later = received.map((x) => JSON.parse(x.body) as WebhookEvent);
  assert.ok(later.some((e) => e.type === "human.handoff" && e.data.conversationId === handoff.conversationId));
  const completed = later.find((e) => e.type === "conversation.completed");
  assert.equal(completed?.type === "conversation.completed" && completed.data.status, "resolved");
});

test("webhooks: retries with the same id, gives up, redelivers; workflow and call events; disabled endpoints get nothing", async () => {
  // A failing receiver: the delivery waits for its retry.
  await prisma.call.create({
    data: {
      organizationId: orgA, workspaceId: ws, employeeId: ava, employeeVersion: 1, direction: "INBOUND", status: "COMPLETED",
      from: "+15550001111", to: "+15550002222", greeting: "Hi", durationSec: 61, endedAt: new Date(),
    },
  });
  received = [];
  answer = 500;
  await hooks.tick(orgA);
  const failing = (await deliveries()).find((d) => d.event === "call.completed")!;
  assert.equal(failing.status, "pending");
  assert.equal(failing.attempts, 1);
  assert.ok(failing.nextAttemptAt! > new Date(Date.now() + 50_000), "the first retry waits a minute");
  assert.equal((failing.log as { statusCode: number }[])[0]!.statusCode, 500);
  const firstId = received.find((x) => JSON.parse(x.body).type === "call.completed")!.headers["webhook-id"];

  // Not due yet: nothing is sent. Once due, it succeeds with the same webhook-id.
  received = [];
  answer = 200;
  await hooks.tick(orgA);
  assert.equal(received.length, 0);
  await prisma.webhookDelivery.update({ where: { id: failing.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
  await hooks.tick(orgA);
  assert.equal(received.length, 1);
  assert.equal(received[0]!.headers["webhook-id"], firstId);
  const call1 = JSON.parse(received[0]!.body) as WebhookEvent;
  assert.equal(call1.type === "call.completed" && call1.data.durationSec, 61);
  const done = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: failing.id } });
  assert.equal(done.status, "succeeded");
  assert.equal((done.log as unknown[]).length, 2);

  // The last attempt fails: given up. Redelivery sends it again with a fresh set of attempts.
  await prisma.webhookDelivery.update({ where: { id: failing.id }, data: { status: "pending", attempts: MAX_ATTEMPTS - 1, nextAttemptAt: new Date(Date.now() - 1000) } });
  answer = 503;
  await hooks.tick(orgA);
  assert.equal((await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: failing.id } })).status, "failed");
  const log = await call("GET", `/developer/webhooks/${endpoint.endpoint.id}/deliveries?status=failed`, undefined, memberOf(orgA));
  assert.equal(log.json<WebhookDeliveryPage>().data[0]?.id, failing.id);
  assert.equal((await call("GET", `/developer/webhooks/${endpoint.endpoint.id}/deliveries`, undefined, adminOf(orgB))).statusCode, 404);
  assert.equal((await call("POST", `/developer/webhook-deliveries/${failing.id}/redeliver`, undefined, adminOf(orgB))).statusCode, 404);
  const again = await call("POST", `/developer/webhook-deliveries/${failing.id}/redeliver`);
  assert.equal(again.json<WebhookDeliveryRecord>().status, "pending");
  assert.equal((await call("POST", `/developer/webhook-deliveries/${failing.id}/redeliver`)).statusCode, 409);
  answer = 200;
  received = [];
  await hooks.tick(orgA);
  assert.equal(received.length, 1);
  assert.equal((await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: failing.id } })).status, "succeeded");

  // A workflow started through the API: started and completed events.
  const created = await call("POST", `/workspaces/${ws}/workflows`, { name: "Ping", definition: blankWorkflow() });
  assert.equal(created.statusCode, 201, created.payload);
  const workflowId = created.json().id as string;
  assert.equal((await call("POST", `/workspaces/${ws}/workflows/${workflowId}/publish`, { version: 1 })).statusCode, 200);
  const { secret } = await createKey(["workflows:read", "workflows:write", "executions:read", "tools:read", "knowledge:read"]);
  const wf = createClient({ apiKey: secret, fetch: viaApp, maxRetries: 0 });
  const workflow = await wf.workflows.get(workflowId);
  assert.deepEqual([workflow.status, workflow.publishedVersion, workflow.latestVersion], ["active", 1, 1]);
  assert.equal((await wf.workflows.list()).data.length, 1);
  const tools = await wf.tools.list();
  assert.equal((tools.data.find((t) => t.name === "calendar_book_meeting")?.inputSchema as { type?: string }).type, "object");
  assert.deepEqual((await wf.tools.listExecutions()).data, []);
  assert.deepEqual((await wf.knowledge.listSources()).data, []);
  const run = await wf.workflows.start(workflowId, { lead: "Asha" }, { idempotencyKey: "run-1" });
  assert.equal(run.startedBy, "api");
  assert.deepEqual(await wf.workflows.start(workflowId, { lead: "Asha" }, { idempotencyKey: "run-1" }), run, "the retry starts nothing");
  assert.equal((await wf.executions.list({ workflowId })).data.length, 1);
  for (let i = 0; i < 100 && (await wf.executions.get(run.id)).status !== "completed"; i++) await sleep(50);
  const detail = await wf.executions.get(run.id);
  assert.equal(detail.status, "completed");
  assert.deepEqual(detail.input, { lead: "Asha" });
  assert.ok(detail.steps.length >= 1);
  received = [];
  await hooks.tick(orgA);
  const events = received.map((x) => JSON.parse(x.body) as WebhookEvent);
  const started = events.find((e) => e.type === "workflow.started");
  assert.equal(started?.data.id, run.id);
  assert.equal(started?.type === "workflow.started" && started.data.status, "queued");
  assert.equal(events.find((e) => e.type === "workflow.completed")?.data.id, run.id);

  // A disabled endpoint, or one not subscribed to the event, gets nothing.
  assert.equal((await call("PATCH", `/developer/webhooks/${endpoint.endpoint.id}`, { events: ["call.completed"] })).statusCode, 200);
  const msgKey = await createKey(["conversations:write"]);
  await createClient({ apiKey: msgKey.secret, fetch: viaApp }).employees.sendMessage(ava, { message: "Hi again" });
  received = [];
  await hooks.tick(orgA);
  assert.equal(received.length, 0);
  assert.equal((await call("PATCH", `/developer/webhooks/${endpoint.endpoint.id}`, { enabled: false, events: [...WEBHOOK_EVENTS] })).statusCode, 200);
  await hooks.tick(orgA);
  assert.equal(received.length, 0);
  assert.equal((await call("DELETE", `/developer/webhooks/${endpoint.endpoint.id}`)).statusCode, 204);
  assert.equal(await prisma.webhookDelivery.count({ where: { endpointId: endpoint.endpoint.id } }), 0);
});

test("the OpenAPI document covers every route and event, and needs no key", async () => {
  const res = await call("GET", "/v1/openapi.json", undefined, {});
  assert.equal(res.statusCode, 200);
  const doc = res.json<{ openapi: string; paths: Record<string, Record<string, { operationId: string }>>; webhooks: Record<string, unknown> }>();
  assert.equal(doc.openapi, "3.1.0");
  for (const [operationId, spec] of Object.entries(PUBLIC_ROUTES)) assert.equal(doc.paths[spec.path]?.[spec.method.toLowerCase()]?.operationId, operationId);
  assert.deepEqual(Object.keys(doc.webhooks).sort(), [...WEBHOOK_EVENTS, "webhook.test"].sort());
  const missing = await call("GET", "/v1/nothing-here", undefined, {});
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.type, "not_found");
});

test("API key settings: IP allowlist, rate limit, expiry at creation, edits, audit log", async () => {
  // Addresses: single addresses, ranges, IPv4 callers seen as IPv4-mapped IPv6, IPv6 ranges.
  assert.equal(ipAllowed("203.0.113.5", []), true);
  assert.equal(ipAllowed("203.0.113.5", ["203.0.113.0/24"]), true);
  assert.equal(ipAllowed("::ffff:203.0.113.5", ["203.0.113.0/24"]), true);
  assert.equal(ipAllowed("198.51.100.1", ["203.0.113.0/24", "2001:db8::/32"]), false);
  assert.equal(ipAllowed("2001:db8::7", ["2001:db8::/32"]), true);
  assert.equal(ipAllowed("127.0.0.1", ["127.0.0.1"]), true);
  assert.equal((await call("POST", "/developer/api-keys", { name: "x", workspaceId: ws, scopes: ["employees:read"], allowedIps: ["not an ip"] })).statusCode, 400);

  // Only from another network: refused here (the test client is 127.0.0.1); allowed after the edit.
  const fenced = await createKeyWith({ scopes: ["employees:read"], allowedIps: ["198.51.100.0/24"], expiresInDays: 30 });
  assert.equal(fenced.key.status, "expiring");
  assert.ok(Math.abs(new Date(fenced.key.expiresAt!).getTime() - Date.now() - 30 * 86_400_000) < 60_000);
  const outside = await call("GET", "/v1/employees", undefined, bearer(fenced.secret));
  assert.equal(outside.statusCode, 403);
  assert.match(outside.json().error.message, /cannot be used from/);
  assert.equal((await call("PATCH", `/developer/api-keys/${fenced.key.id}`, { allowedIps: ["127.0.0.0/8"] }, memberOf(orgA))).statusCode, 403);
  const edited = await call("PATCH", `/developer/api-keys/${fenced.key.id}`, { allowedIps: ["127.0.0.0/8", "::1"], name: "Office" });
  assert.equal(edited.json<ApiKeyInfo>().name, "Office");
  assert.equal((await call("GET", "/v1/employees", undefined, bearer(fenced.secret))).statusCode, 200);

  // Rate limit: 3 a minute, the 4th is 429 with Retry-After; headers count down.
  const limited = await createKeyWith({ scopes: ["employees:read"], rateLimitPerMinute: 3 });
  const first = await call("GET", "/v1/employees", undefined, bearer(limited.secret));
  assert.equal(first.headers["x-ratelimit-limit"], "3");
  assert.equal(first.headers["x-ratelimit-remaining"], "2");
  await call("GET", "/v1/employees", undefined, bearer(limited.secret));
  await call("GET", "/v1/employees", undefined, bearer(limited.secret));
  const over = await call("GET", "/v1/employees", undefined, bearer(limited.secret));
  assert.equal(over.statusCode, 429);
  assert.equal(over.json().error.type, "rate_limited");
  assert.ok(Number(over.headers["retry-after"]) >= 1);
  // Rotation keeps the settings.
  const rotated = (await call("POST", `/developer/api-keys/${limited.key.id}/rotate`, { expireOldInHours: 0 })).json<CreatedApiKey>();
  assert.equal(rotated.key.rateLimitPerMinute, 3);

  // The audit log: admins only, names and settings, never secrets.
  assert.equal((await call("GET", "/developer/audit", undefined, memberOf(orgA))).statusCode, 403);
  const audit = await call("GET", "/developer/audit");
  const actions = audit.json<DeveloperAuditEntry[]>().map((e) => e.action);
  for (const action of ["api_key.create", "api_key.update", "api_key.rotate", "api_key.revoke", "webhook.create", "webhook.update", "webhook.delete", "webhook.redeliver"])
    assert.ok(actions.includes(action), action);
  assert.ok(!audit.payload.includes(fenced.secret.slice(fenced.key.prefix.length)));
  assert.equal((await call("GET", "/developer/audit", undefined, adminOf(orgB))).json<DeveloperAuditEntry[]>().length > 0, true);
  assert.ok(!(await call("GET", "/developer/audit", undefined, adminOf(orgB))).json<DeveloperAuditEntry[]>().some((e) => e.targetId === fenced.key.id));
});

test("writes through the API: employees, streaming, resolve, customer memory, knowledge; and their events", async () => {
  const body = { url: HOOK_URL, workspaceId: ws, events: [...WEBHOOK_EVENTS] };
  const hook = (await call("POST", "/developer/webhooks", body)).json<CreatedWebhookEndpoint>();
  const { secret } = await createKeyWith({
    scopes: ["employees:read", "employees:write", "conversations:read", "conversations:write", "customers:read", "customers:write", "knowledge:read", "knowledge:write"],
  });
  const wf = createClient({ apiKey: secret, fetch: viaApp, maxRetries: 0 });

  // Employees: create (draft, version 1), invalid time zone with the public field name, save a version, publish it.
  const bea = await wf.employees.create({ name: "Bea", role: "Sales", instructions: "Be brief.", timeZone: "Asia/Kolkata", language: "en-IN" });
  assert.deepEqual([bea.status, bea.latestVersion, bea.publishedVersion, bea.language], ["draft", 1, null, "en-IN"]);
  await assert.rejects(wf.employees.saveVersion(bea.id, { timeZone: "Mars/Olympus" }), (err: WorkforceError) => err.status === 400 && err.issues[0]?.path === "timeZone");
  await assert.rejects(wf.employees.saveVersion(bea.id, {}), (err: WorkforceError) => err.status === 400);
  const v2 = await wf.employees.saveVersion(bea.id, { instructions: "Be very brief.", goals: ["Book demos"] });
  assert.equal(v2.latestVersion, 2);
  const config = await prisma.aiEmployeeVersion.findFirstOrThrow({ where: { employeeId: bea.id, number: 2 } });
  assert.equal(config.systemInstructions, "Be very brief.");
  assert.equal((config.workingHours as { timezone: string }).timezone, "Asia/Kolkata", "unchanged fields are kept");
  const live = await wf.employees.publish(bea.id);
  assert.deepEqual([live.status, live.publishedVersion], ["active", 2]);
  const release = await prisma.employeeRelease.findFirstOrThrow({ where: { employeeId: bea.id } });
  assert.equal(release.by, `api:${(await prisma.apiKey.findFirstOrThrow({ where: { prefix: secret.slice(4, 16) } })).id}`);
  await assert.rejects(createClient({ apiKey: (await createKeyWith({ scopes: ["employees:read"] })).secret, fetch: viaApp }).employees.create({ name: "x", role: "y" }), (err: WorkforceError) => err.status === 403);

  // Streaming: text pieces, then done with both messages.
  const events: { type: string }[] = [];
  for await (const event of wf.employees.streamMessage(bea.id, { message: "Hello there", customer: "+91 98765 43210" })) events.push(event);
  assert.deepEqual(events.map((e) => e.type), ["text", "done"]);
  const done = events[1] as Extract<import("@workforce/sdk").StreamEvent, { type: "done" }>;
  assert.equal(done.reply?.text, "Happy to help.");
  // Errors before the stream starts are normal JSON errors.
  await assert.rejects(async () => {
    for await (const _ of wf.employees.streamMessage("nope", { message: "x" })) void _;
  }, (err: WorkforceError) => err.status === 404);

  // Resolve, twice: the second is not an error.
  assert.equal((await wf.conversations.resolve(done.conversationId)).status, "resolved");
  assert.equal((await wf.conversations.resolve(done.conversationId)).status, "resolved");

  // Customer memory: set (category kept on update), identity keys reach the profile, secrets refused, delete.
  const customerId = (await wf.conversations.get(done.conversationId)).customerId!;
  assert.equal((await wf.customers.get(customerId)).externalId, "+919876543210");
  const plan = await wf.customers.setMemory(customerId, "plan", { value: "enterprise", category: "lead" });
  assert.deepEqual([plan.key, plan.value, plan.category, plan.confidence], ["plan", "enterprise", "lead", 1]);
  assert.equal((await wf.customers.setMemory(customerId, "plan", { value: "growth" })).category, "lead");
  await wf.customers.setMemory(customerId, "name", { value: "Anita", category: "identity" });
  assert.equal((await wf.customers.get(customerId)).name, "Anita");
  await assert.rejects(wf.customers.setMemory(customerId, "card", { value: "4242 4242 4242 4242" }), (err: WorkforceError) => err.status === 400);
  assert.deepEqual(await wf.customers.deleteMemory(customerId, "name"), { deleted: true });
  assert.equal((await wf.customers.get(customerId)).name, null);
  await assert.rejects(wf.customers.deleteMemory(customerId, "name"), (err: WorkforceError) => err.status === 404);
  assert.ok(await prisma.customerAuditLog.findFirst({ where: { customerId, action: "memory_delete", actorId: { startsWith: "api:" } } }));

  // Knowledge: a source, a duplicate name, an upload processed in the background, refused files.
  const source = await wf.knowledge.createSource({ name: "Pricing" });
  await assert.rejects(wf.knowledge.createSource({ name: "Pricing" }), (err: WorkforceError) => err.status === 409);
  const doc = await wf.knowledge.uploadDocument(source.id, { name: "prices.txt", content: new TextEncoder().encode("The enterprise plan costs $499 a month.") });
  assert.equal(doc.status, "pending");
  for (let i = 0; i < 100 && (await wf.knowledge.getSource(source.id)).documents[0]?.status !== "ready"; i++) await sleep(50);
  assert.equal((await wf.knowledge.getSource(source.id)).documents[0]?.status, "ready");
  await assert.rejects(wf.knowledge.uploadDocument(source.id, { name: "virus.exe", content: new Uint8Array([1]) }), (err: WorkforceError) => err.status === 400);
  const notBase64 = await call("POST", `/v1/knowledge/sources/${source.id}/documents`, { name: "a.txt", contentBase64: "%%%" }, bearer(secret));
  assert.equal(notBase64.statusCode, 400);

  // Events: the release, the customer's memory changes.
  received = [];
  answer = 200;
  await hooks.tick(orgA);
  const sent = received.map((r) => JSON.parse(r.body) as WebhookEvent);
  const published = sent.find((e) => e.type === "employee.published");
  assert.equal(published?.type === "employee.published" && published.data.version, 2);
  assert.equal(published?.type === "employee.published" && published.data.action, "publish");
  assert.ok(sent.some((e) => e.type === "customer.updated" && e.data.id === customerId));
  await call("DELETE", `/developer/webhooks/${hook.endpoint.id}`);
});

test("webhooks: secret rotation signs with both secrets, test events, catching up after downtime", async () => {
  const created = (await call("POST", "/developer/webhooks", { url: HOOK_URL, workspaceId: ws, events: ["call.completed"] })).json<CreatedWebhookEndpoint>();
  const id = created.endpoint.id;

  // A test event, sent at once, whatever the endpoint subscribes to.
  received = [];
  answer = 200;
  const test1 = await call("POST", `/developer/webhooks/${id}/test`);
  assert.equal(test1.statusCode, 200, test1.payload);
  assert.equal(test1.json<WebhookDeliveryRecord>().status, "succeeded");
  assert.equal(test1.json<WebhookDeliveryRecord>().event, "webhook.test");
  const event = await verifyWebhook(received[0]!.body, received[0]!.headers, created.secret);
  assert.equal(event.type === "webhook.test" && event.data.endpointId, id);
  assert.equal((await call("POST", `/developer/webhooks/${id}/test`, undefined, memberOf(orgA))).statusCode, 403);

  // Rotation with a grace period: two signatures, both secrets verify; the old one stops after the grace period.
  const rotated = (await call("POST", `/developer/webhooks/${id}/rotate-secret`, { keepOldForHours: 1 })).json<CreatedWebhookEndpoint>();
  assert.notEqual(rotated.secret, created.secret);
  assert.ok(rotated.endpoint.previousSecretUntil);
  received = [];
  await call("POST", `/developer/webhooks/${id}/test`);
  const both = received[0]!;
  assert.equal(both.headers["webhook-signature"]!.split(" ").length, 2);
  await verifyWebhook(both.body, both.headers, rotated.secret);
  await verifyWebhook(both.body, both.headers, created.secret);
  await call("POST", `/developer/webhooks/${id}/rotate-secret`, { keepOldForHours: 0 });
  received = [];
  const latest = (await call("POST", `/developer/webhooks/${id}/rotate-secret`, { keepOldForHours: 0 })).json<CreatedWebhookEndpoint>();
  await call("POST", `/developer/webhooks/${id}/test`);
  assert.equal(received[0]!.headers["webhook-signature"]!.split(" ").length, 1);
  await verifyWebhook(received[0]!.body, received[0]!.headers, latest.secret);
  await assert.rejects(verifyWebhook(received[0]!.body, received[0]!.headers, rotated.secret), WebhookVerificationError);

  // Catching up: the API was down for hours. A call that ended 2 hours ago is still sent; one 8 days ago is not.
  await prisma.webhookEndpoint.update({ where: { id }, data: { scannedAt: new Date(Date.now() - 3 * 3_600_000), createdAt: new Date(Date.now() - 10 * 86_400_000) } });
  const callOf = (endedAgoMs: number) =>
    prisma.call.create({
      data: {
        organizationId: orgA, workspaceId: ws, employeeId: ava, employeeVersion: 1, direction: "OUTBOUND", status: "COMPLETED",
        from: "+15550001111", to: "+15550003333", greeting: "Hi", durationSec: 30, createdAt: new Date(Date.now() - endedAgoMs - 60_000), endedAt: new Date(Date.now() - endedAgoMs),
      },
    });
  const recent = await callOf(2 * 3_600_000);
  const ancient = await callOf(8 * 86_400_000);
  received = [];
  await hooks.tick(orgA);
  const ids = received.map((r) => (JSON.parse(r.body) as { data: { id?: string } }).data.id);
  assert.ok(ids.includes(recent.id));
  assert.ok(!ids.includes(ancient.id));
  assert.ok((await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id } })).scannedAt! > new Date(Date.now() - 60_000), "the cursor moved");

  // Paged delivery log, filtered by event.
  const page = (await call("GET", `/developer/webhooks/${id}/deliveries?limit=2&event=webhook.test`, undefined, memberOf(orgA))).json<WebhookDeliveryPage>();
  assert.equal(page.data.length, 2);
  assert.ok(page.nextCursor);
  const rest = (await call("GET", `/developer/webhooks/${id}/deliveries?limit=2&event=webhook.test&cursor=${page.nextCursor}`, undefined, memberOf(orgA))).json<WebhookDeliveryPage>();
  assert.ok(rest.data.length >= 1);
  assert.ok(!rest.data.some((d) => page.data.some((p) => p.id === d.id)));
  // A cursor is tied to its filter: reused with another one it is refused.
  assert.equal((await call("GET", `/developer/webhooks/${id}/deliveries?limit=2&cursor=${page.nextCursor}`, undefined, memberOf(orgA))).statusCode, 400);
  assert.ok(!rest.data.some((d) => page.data.some((p) => p.id === d.id)));
  await call("DELETE", `/developer/webhooks/${id}`);
});

test("the SDK's generated types match the contract", () => {
  // Git may check the file out with CRLF (core.autocrlf on Windows); the contract is the text, not the line endings.
  const file = readFileSync(new URL("../../../packages/sdk/src/types.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.equal(file, renderTypes(), "run pnpm --filter @workforce/sdk generate");
});

const python = spawnSync("python", ["--version"]).status === 0 ? "python" : null;
test("the Python SDK: calls the API and verifies webhooks", { skip: python ? false : "python is not installed" }, async () => {
  const { secret } = await createKeyWith({ scopes: ["employees:read", "conversations:write"] });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as { port: number }).port;
  const whsec = "whsec_" + Buffer.from("python-sdk-test-secret-123").toString("base64");
  const body = JSON.stringify({ id: "message.sent:1", type: "message.sent", createdAt: new Date().toISOString(), workspaceId: ws, data: {} });
  const ts = Math.floor(Date.now() / 1000);
  const script = `
import json, sys
from workforce_sdk import Client, verify_webhook, WebhookVerificationError, WorkforceError
wf = Client(api_key=sys.argv[1], base_url=sys.argv[2], max_retries=0)
out = {"employees": len(wf.employees.list(limit=5)["data"])}
answer = wf.employees.send_message(sys.argv[3], message="Hi from Python", customer="py@example.com")
out["reply"] = answer["reply"]["text"]
out["stream"] = [e["type"] for e in wf.employees.stream_message(sys.argv[3], message="Again", conversation_id=answer["conversationId"])]
try:
    wf.customers.list()
except WorkforceError as err:
    out["denied"] = [err.status, err.type]
headers = {"Webhook-Id": "message.sent:1", "Webhook-Timestamp": sys.argv[5], "Webhook-Signature": sys.argv[6]}
out["verified"] = verify_webhook(sys.argv[4], headers, sys.argv[7])["type"]
try:
    verify_webhook(sys.argv[4] + " ", headers, sys.argv[7])
except WebhookVerificationError:
    out["tampered"] = "refused"
print(json.dumps(out))
`;
  const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(python!, ["-c", script, secret, `http://127.0.0.1:${port}`, ava, body, String(ts), signWebhook(whsec, "message.sent:1", ts, body), whsec], {
      env: { ...process.env, PYTHONPATH: new URL("../../../packages/sdk-python", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    child.on("close", (status: number | null) => resolve({ status, stdout, stderr }));
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    employees: 2,
    reply: "Happy to help.",
    stream: ["text", "done"],
    denied: [403, "permission_denied"],
    verified: "message.sent",
    tampered: "refused",
  });
});
