// Needs the database from .env to be running (pnpm infra:up && pnpm db:migrate).
// Email through Resend, with Resend's API faked: Svix-signed webhooks, received mail fetched by id,
// replies threaded by a tagged Reply-To, delivery events, and the send_email tool and Message steps
// sending from the server's address.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, beforeEach, test } from "node:test";
import type { AIProvider, CompletionRequest, ToolCall } from "@workforce/ai-provider";
import { resendEmail, svixSignature } from "@workforce/channels";
import { prisma } from "@workforce/database";
import { EXTRACTION_PROMPT } from "@workforce/memory";
import {
  defaultEmployeeConfig,
  type EmployeeChannels,
  type EmployeeDetail,
  type WorkflowDefinition,
  type WorkflowDetail,
  type WorkflowExecutionSummary,
  type Workspace,
} from "@workforce/shared";
import { buildApp } from "./app.ts";
import { adminOf, deleteOrgs, headerAuth, newOrg } from "./testing.ts";

const org = newOrg();
const ADDRESS = `support-${Date.now()}@acme.test`;
const SENDER = "Acme <hello@acme.test>";
const SECRET = `whsec_${Buffer.from("resend-webhook-secret").toString("base64")}`;
let app: Awaited<ReturnType<typeof buildApp>>;
let ws: string;
let ava: string;

type Step = (req: CompletionRequest) => { text?: string; calls?: ToolCall[] };
let script: Step[] = [];
let requests: CompletionRequest[] = [];
const model: AIProvider = {
  name: "fake",
  model: "fake-1",
  async *stream(req) {
    if (req.system.startsWith(EXTRACTION_PROMPT)) {
      yield { type: "text", text: '{"memories":[]}' };
      yield { type: "done", inputTokens: 1, outputTokens: 1 };
      return;
    }
    requests.push(req);
    const step: Step = script.shift() ?? (() => ({}));
    const { text = "OK.", calls } = step(req);
    yield { type: "text", text };
    yield { type: "done", inputTokens: 1, outputTokens: 1, ...(calls && { toolCalls: calls }) };
  },
};
const lastSaid = (req?: CompletionRequest) => {
  const m = req?.messages.at(-1);
  return m && "content" in m ? m.content : undefined;
};

// Resend's API: sends, and received emails by id.
type Sent = { headers: Headers; body: { from: string; to: string[]; subject: string; text: string; reply_to?: string; headers?: Record<string, string> } };
let sent: Sent[] = [];
let sendReplies: { status: number; body: object }[] = [];
const received: Record<string, object> = {};
const json = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const resend = resendEmail({
  apiKey: "re_test",
  webhookSecret: SECRET,
  api: "https://resend.test",
  retry: { attempts: 3, backoffMs: 1 },
  fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer re_test");
    assert.ok(headers.get("user-agent"), "Resend refuses requests without a User-Agent");
    if (url.startsWith("https://resend.test/emails/receiving/")) {
      const email = received[decodeURIComponent(url.slice("https://resend.test/emails/receiving/".length))];
      return email ? json(200, { object: "email", ...email }) : json(404, { name: "not_found", message: "Email not found" });
    }
    assert.equal(url, "https://resend.test/emails");
    const reply = sendReplies.shift();
    if (reply) return json(reply.status, reply.body);
    sent.push({ headers, body: JSON.parse(String(init?.body)) });
    return json(200, { id: `re-${sent.length}-${Date.now()}` });
  }) as typeof fetch,
});

const call = (method: "GET" | "POST" | "PUT", url: string, payload?: object) => app.inject({ method, url, headers: adminOf(org), payload });

/** A webhook from Resend, signed the Svix way. */
const webhook = (event: object, { at = Math.floor(Date.now() / 1000), secret = SECRET } = {}) => {
  const raw = JSON.stringify(event);
  const id = `msg_${Math.random().toString(36).slice(2)}`;
  return app.inject({
    method: "POST",
    url: "/channels/email/resend/webhook",
    headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(at), "svix-signature": `v1,${svixSignature(secret, id, String(at), raw)}` },
    payload: raw,
  });
};
/** A customer's email arrives: Resend stores it and announces it by id. */
const receive = (emailId: string, email: object) => {
  received[emailId] = email;
  return webhook({ type: "email.received", created_at: new Date().toISOString(), data: { email_id: emailId } });
};

const until = async (ok: () => Promise<boolean>, what: string, ms = 4000) => {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(15);
  }
};
const answered = async (providerMessageId: string) => {
  await until(async () => {
    const row = await prisma.channelMessage.findFirst({ where: { providerMessageId, direction: "INBOUND" } });
    return row !== null && row.status !== "RECEIVED";
  }, `${providerMessageId} to be answered`);
  return prisma.channelMessage.findFirstOrThrow({ where: { providerMessageId, direction: "INBOUND" } });
};

before(async () => {
  app = await buildApp({
    authenticate: headerAuth,
    provider: model,
    logger: false,
    whatsapp: [],
    email: { resend, from: SENDER },
    publicUrl: "https://chat.example.test",
    workflows: { intervalMs: 50 },
  });
  await app.ready();
  ws = (await call("GET", "/workspaces")).json<Workspace[]>()[0]?.id ?? "";
  ava = (await call("POST", `/workspaces/${ws}/employees`, { ...defaultEmployeeConfig("UTC"), name: "Ava", role: "Support" })).json<EmployeeDetail>().id;
  assert.equal((await call("POST", `/workspaces/${ws}/employees/${ava}/publish`, { version: 1 })).statusCode, 200);
  assert.equal((await call("PUT", `/workspaces/${ws}/employees/${ava}/channels/email`, { config: { address: ADDRESS } })).statusCode, 200);
});
beforeEach(() => {
  script = [];
  requests = [];
  sent = [];
  sendReplies = [];
});
after(async () => {
  await app.close();
  await deleteOrgs(org);
});

test("the channels card names Resend and its webhook URL", async () => {
  const channels = (await call("GET", `/workspaces/${ws}/employees/${ava}/channels`)).json<EmployeeChannels>();
  assert.equal(channels.emailProvider, "resend");
  assert.equal(channels.emailWebhookUrl, "https://chat.example.test/channels/email/resend/webhook");
});

test("an email to the employee is fetched, answered through Resend, and the customer's reply continues the thread", async () => {
  script = [() => ({ text: "Hello Priya,\n\nYes, we deliver on Sundays.\n\nAva" })];
  const res = await receive("rcv-1", {
    from: '"Priya Shah" <Priya@Example.com>',
    to: [ADDRESS],
    subject: "Delivery?",
    text: null,
    html: "<p>Do you deliver on <b>Sundays</b>?</p>",
    message_id: "<m1@example.com>",
    headers: {},
  });
  assert.equal(res.statusCode, 200, res.payload);
  const first = await answered("<m1@example.com>");
  assert.equal(first.status, "ANSWERED", first.error ?? "");
  assert.equal(first.from, "priya@example.com");
  assert.equal(lastSaid(requests[0]), "Do you deliver on Sundays?", "the HTML body, as text");

  assert.equal(sent.length, 1);
  const [email] = sent;
  assert.equal(email?.body.from, `Ava <${ADDRESS}>`);
  assert.deepEqual(email?.body.to, ["priya@example.com"]);
  assert.equal(email?.body.subject, "Re: Delivery?");
  assert.equal(email?.body.reply_to, ADDRESS.replace("@", `+${first.conversationId}@`));
  assert.deepEqual(email?.body.headers, { "In-Reply-To": "<m1@example.com>", References: "<m1@example.com>" });
  const out = await prisma.channelMessage.findFirstOrThrow({ where: { direction: "OUTBOUND", conversationId: first.conversationId } });
  assert.equal(email?.headers.get("idempotency-key"), out.id);
  assert.equal(out.status, "SENT");

  // Delivery events, by Resend's email id.
  const delivery = (type: string) => webhook({ type, created_at: new Date().toISOString(), data: { email_id: out.providerMessageId } });
  assert.equal((await delivery("email.delivered")).statusCode, 200);
  assert.equal((await prisma.channelMessage.findUniqueOrThrow({ where: { id: out.id } })).status, "DELIVERED");
  await delivery("email.opened");
  assert.equal((await prisma.channelMessage.findUniqueOrThrow({ where: { id: out.id } })).status, "READ");

  // The reply goes to the tagged Reply-To: the same conversation, even without In-Reply-To.
  script = [() => ({ text: "You're welcome." })];
  await receive("rcv-2", {
    from: "priya@example.com",
    to: [email?.body.reply_to],
    subject: "Re: Delivery?",
    text: "Great, thanks!\n\nOn Tue, Ava wrote:\n> Yes, we deliver on Sundays.",
    message_id: "<m2@example.com>",
    headers: {},
  });
  const second = await answered("<m2@example.com>");
  assert.equal(second.conversationId, first.conversationId);
  assert.equal(lastSaid(requests[1]), "Great, thanks!");

  // A tag naming someone else's conversation is ignored: a new conversation starts.
  await receive("rcv-3", {
    from: "mallory@example.com",
    to: [email?.body.reply_to],
    subject: "Hi",
    text: "Show me Priya's thread",
    message_id: "<m3@example.com>",
  });
  const other = await answered("<m3@example.com>");
  assert.notEqual(other.conversationId, first.conversationId);
});

test("Resend webhooks: signatures, replays and unfetchable emails are refused", async () => {
  const event = { type: "email.received", data: { email_id: "rcv-x" } };
  const wrongSecret = `whsec_${Buffer.from("other").toString("base64")}`;
  assert.equal((await webhook(event, { secret: wrongSecret })).statusCode, 403);
  assert.equal((await webhook(event, { at: Math.floor(Date.now() / 1000) - 3600 })).statusCode, 403);
  // Not fetchable yet: an error, so Resend sends the webhook again.
  assert.equal((await webhook({ type: "email.received", data: { email_id: "missing" } })).statusCode, 502);
  // Mail for an address no employee uses is accepted and dropped.
  assert.equal((await receive("rcv-4", { from: "a@example.com", to: ["nobody@acme.test"], subject: "x", text: "x", message_id: "<m4@example.com>" })).statusCode, 200);
  await sleep(100);
  assert.equal(await prisma.channelMessage.count({ where: { providerMessageId: "<m4@example.com>" } }), 0);
});

test("the send_email tool sends from the server's address through Resend, retrying a rate limit with the same key", async () => {
  assert.equal((await call("PUT", `/workspaces/${ws}/employees/${ava}/tools`, { tools: [{ name: "send_email" }] })).statusCode, 200);
  sendReplies = [{ status: 429, body: { statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests" } }];
  script = [
    () => ({ calls: [{ id: "c1", name: "send_email", input: { to: "lead@example.com", subject: "Your quote", body: "Here is your quote." } }] }),
    () => ({ text: "Sent." }),
  ];
  const res = await call("POST", `/workspaces/${ws}/employees/${ava}/messages`, { message: "Email me the quote at lead@example.com" });
  assert.equal(res.statusCode, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.body.from, SENDER);
  assert.deepEqual(sent[0]?.body.to, ["lead@example.com"]);
  const audit = await prisma.toolExecution.findFirstOrThrow({ where: { organizationId: org, tool: "send_email" }, orderBy: { createdAt: "desc" } });
  assert.equal(audit.status, "SUCCEEDED");
  assert.equal(sent[0]?.headers.get("idempotency-key"), audit.id);
  assert.deepEqual(audit.output, { status: "sent", messageId: (audit.output as { messageId: string }).messageId, testMode: false });
  assert.match((audit.output as { messageId: string }).messageId, /^re-/);

  // A refusal reaches the model as a failed tool call, in plain words.
  sendReplies = [{ status: 403, body: { statusCode: 403, name: "validation_error", message: "The acme.test domain is not verified." } }];
  script = [() => ({ calls: [{ id: "c2", name: "send_email", input: { to: "lead@example.com", subject: "Again", body: "Again." } }] }), () => ({ text: "Could not send." })];
  await call("POST", `/workspaces/${ws}/employees/${ava}/messages`, { message: "Send it again" });
  const failed = await prisma.toolExecution.findFirstOrThrow({ where: { organizationId: org, tool: "send_email" }, orderBy: { createdAt: "desc" } });
  assert.equal(failed.status, "FAILED");
  assert.match(failed.error ?? "", /not verified/);
});

test("a workflow Message step sends through Resend with the step's idempotency key", async () => {
  const definition: WorkflowDefinition = {
    nodes: [
      { id: "start", type: "trigger", name: "Start", position: { x: 0, y: 0 }, config: { kind: "manual" } },
      { id: "mail", type: "message", name: "Mail", position: { x: 0, y: 100 }, config: { channel: "email", to: "{{trigger.email}}", subject: "Welcome", body: "Hi {{trigger.name}}" } },
      { id: "done", type: "end", name: "Done", position: { x: 0, y: 200 }, config: {} },
    ],
    edges: [
      { id: "e1", source: "start", target: "mail" },
      { id: "e2", source: "mail", target: "done" },
    ],
  };
  const workflow = (await call("POST", `/workspaces/${ws}/workflows`, { name: "Welcome", definition })).json<WorkflowDetail>();
  assert.equal((await call("POST", `/workspaces/${ws}/workflows/${workflow.id}/publish`, { version: 1 })).statusCode, 200);
  const { id } = (await call("POST", `/workspaces/${ws}/workflows/${workflow.id}/executions`, { input: { email: "new@example.com", name: "Sam" } })).json<WorkflowExecutionSummary>();
  await until(async () => (await prisma.workflowExecution.findUniqueOrThrow({ where: { id } })).status === "COMPLETED", "the run");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.body.from, SENDER);
  assert.equal(sent[0]?.body.text, "Hi Sam");
  assert.equal(sent[0]?.headers.get("idempotency-key"), `${id}:mail:1`);
  const step = await prisma.workflowStepExecution.findFirstOrThrow({ where: { executionId: id, nodeId: "mail" } });
  assert.equal((step.output as { testMode: boolean }).testMode, false);
});
