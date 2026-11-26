// Needs the database from .env to be running (pnpm infra:up && pnpm db:migrate).
// Phase 10: human handoff. Every trigger, the AI staying silent while people have a conversation,
// agents replying on the customer's channel (test chat, web chat, WhatsApp through a fake Graph API),
// the full context reaching the AI when it is handed back, the Copilot, and handoff analytics.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, beforeEach, test } from "node:test";
import { asksForHuman, ruleMatches, startHandoff, toNumber } from "@workforce/agent-runtime";
import type { AIProvider, CompletionRequest, ToolCall } from "@workforce/ai-provider";
import { metaSignature, metaWhatsApp } from "@workforce/channels";
import { prisma } from "@workforce/database";
import { EXTRACTION_PROMPT, factWrites, identifyCustomer, memoryService } from "@workforce/memory";
import {
  defaultEmployeeConfig,
  type ChatStreamEvent,
  type CopilotSuggestion,
  type EmployeeChannelInfo,
  type EmployeeDetail,
  type DashboardSummary,
  type HandoffAnalytics,
  type InboxConversation,
  type InboxResponse,
  type Workspace,
} from "@workforce/shared";
import { buildApp } from "./app.ts";
import { stats } from "./inbox.ts";
import { adminOf, deleteOrgs, headerAuth, memberOf, newOrg } from "./testing.ts";

const APP_SECRET = "meta-app-secret";
const PNID = `3${Date.now()}`;
const WA_ID = "15559870000";
const orgA = newOrg();
const orgB = newOrg();
let app: Awaited<ReturnType<typeof buildApp>>;
let ws: string;
let wsB: string;
let ava: string;
let web: EmployeeChannelInfo;

// ---- Fakes ----

type Step = (req: CompletionRequest) => { text?: string; calls?: ToolCall[]; fail?: boolean };
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
    const { text = "OK.", calls, fail } = step(req);
    if (fail) throw new Error("model down");
    if (text) yield { type: "text", text };
    yield { type: "done", inputTokens: 1, outputTokens: 1, ...(calls && { toolCalls: calls }) };
  },
};
const memory = memoryService(model, 5000);

let sent: { to: string; text: string }[] = [];
const whatsapp = metaWhatsApp({
  accessToken: "wa-token",
  appSecret: APP_SECRET,
  verifyToken: "verify",
  graphUrl: "https://graph.test",
  retry: { attempts: 1, backoffMs: 1 },
  fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { status?: string; to?: string; text?: { body: string } };
    if (body.status !== "read") sent.push({ to: body.to ?? "", text: body.text?.body ?? "" });
    return new Response(JSON.stringify({ success: true, messages: [{ id: `wamid.out-${Date.now()}-${sent.length}` }] }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch,
});

// ---- Helpers ----

type Headers = Record<string, string>;
const call = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: object, headers: Headers = adminOf(orgA)) =>
  app.inject({ method, url, headers, payload });
const parse = (payload: string) =>
  payload
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice(6)) as ChatStreamEvent);

/** One test-chat message; returns the stream's last event. */
const say = async (message: string, conversationId?: string) => {
  const res = await call("POST", `/workspaces/${ws}/employees/${ava}/messages`, { message, conversationId });
  assert.equal(res.statusCode, 200, res.payload);
  const last = parse(res.payload).at(-1);
  assert.ok(last);
  return last;
};
const conv = (id: string) => `/workspaces/${ws}/conversations/${id}`;
const act = (id: string, body: object, headers = memberOf(orgA)) => call("PATCH", conv(id), body, headers);
const reply = (id: string, body: object, headers = memberOf(orgA)) => call("POST", `${conv(id)}/messages`, body, headers);
const detail = async (id: string) => (await call("GET", conv(id), undefined, memberOf(orgA))).json<InboxConversation>();
const inbox = async (view: string) => (await call("GET", `/workspaces/${ws}/inbox?view=${view}`, undefined, memberOf(orgA))).json<InboxResponse>();

const until = async (ok: () => Promise<boolean>, what: string) => {
  const end = Date.now() + 4000;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(15);
  }
};

before(async () => {
  app = await buildApp({ authenticate: headerAuth, provider: model, memory: () => memory, logger: false, whatsapp: [whatsapp] });
  await app.ready();
  const workspaceOf = async (org: string) => (await call("GET", "/workspaces", undefined, adminOf(org))).json<Workspace[]>()[0]?.id ?? "";
  ws = await workspaceOf(orgA);
  wsB = await workspaceOf(orgB);
  const config = defaultEmployeeConfig("UTC");
  const created = await call("POST", `/workspaces/${ws}/employees`, {
    ...config,
    name: "Ava",
    role: "Support agent",
    escalation: {
      ...config.escalation,
      enabled: true,
      contactEmail: "team@example.test",
      onToolFailure: true,
      afterFailedAttempts: 2,
      highValueKey: "budget",
      highValueMinimum: 50000,
      rules: [{ field: "message", key: "", operator: "contains", value: "refund" }],
    },
  });
  assert.equal(created.statusCode, 201, created.payload);
  ava = created.json<EmployeeDetail>().id;
  assert.equal((await call("POST", `/workspaces/${ws}/employees/${ava}/publish`, { version: 1 })).statusCode, 200);
  const grant = await call("PUT", `/workspaces/${ws}/employees/${ava}/tools`, { tools: [{ name: "http_request", config: { allowedHosts: ["api.example.com"] } }] });
  assert.equal(grant.statusCode, 200, grant.payload);
  web = (await call("PUT", `/workspaces/${ws}/employees/${ava}/channels/web_chat`, { config: {} })).json<EmployeeChannelInfo>();
  assert.equal((await call("PUT", `/workspaces/${ws}/employees/${ava}/channels/whatsapp`, { config: { phoneNumberId: PNID } })).statusCode, 200);
});
beforeEach(() => {
  script = [];
  requests = [];
  sent = [];
});
after(async () => {
  await app.close();
  await deleteOrgs(orgA, orgB);
});

test("trigger helpers: explicit requests, numbers, conditions, duration stats", () => {
  for (const yes of ["Can I talk to a human?", "please connect me with a real person", "Agent please", "I want to speak to someone"]) assert.ok(asksForHuman(yes), yes);
  for (const no of ["What is the price?", "Is the agent plan available?", "Book a meeting for two people"]) assert.ok(!asksForHuman(no), no);
  assert.equal(toNumber("$50,000"), 50000);
  assert.ok(Number.isNaN(toNumber("about fifty")));
  const facts = new Map([["plan", "Enterprise"], ["budget", "75k"]]);
  assert.ok(ruleMatches({ field: "memory", key: "plan", operator: "equals", value: "enterprise" }, "", facts));
  assert.ok(ruleMatches({ field: "message", key: "", operator: "contains", value: "REFUND" }, "I want a refund", facts));
  assert.ok(!ruleMatches({ field: "memory", key: "missing", operator: "contains", value: "x" }, "", facts));
  assert.deepEqual(stats([]), { count: 0, average: null, median: null, p90: null });
  assert.deepEqual(stats([10, 20, 30, 40, 1000]), { count: 5, average: 220, median: 30, p90: 1000 });
});

test("a customer asking for a person is handed off without calling the model; the AI stays silent until handed back", async () => {
  const first = await say("Hi, can I talk to a human please?");
  assert.ok(first.type === "done");
  assert.deepEqual([first.handoff?.trigger, first.conversation.status], ["customer_request", "WAITING_FOR_HUMAN"]);
  assert.match(first.messages[1].content, /member of our team/);
  assert.equal(requests.length, 0);
  const id = first.conversation.id;

  // In the unassigned queue.
  const queue = await inbox("queue");
  const item = queue.items.find((i) => i.id === id);
  assert.ok(item);
  assert.deepEqual([item.status, item.assignedTo, item.handoff?.trigger, item.employee.name], ["WAITING_FOR_HUMAN", null, "customer_request", "Ava"]);
  assert.ok(queue.counts.queue >= 1);

  // While waiting, messages are kept and not answered.
  const held = await say("Hello? Anyone there?", id);
  assert.equal(held.type, "held");
  assert.equal(requests.length, 0);

  // A member (agents need not be admins) takes it over and answers.
  const taken = await act(id, { action: "take_over" });
  assert.equal(taken.statusCode, 200, taken.payload);
  assert.deepEqual([taken.json<InboxConversation>().status, taken.json<InboxConversation>().assignedTo], ["HUMAN_ACTIVE", "user_member"]);
  assert.equal((await inbox("mine")).items[0]?.id, id);
  const answered = await reply(id, { text: "Hi, I'm Sam from the team. The Pro plan costs $49 a month." });
  assert.equal(answered.statusCode, 200, answered.payload);
  const after = answered.json<InboxConversation>();
  const agentMessage = after.messages.at(-1);
  assert.deepEqual([agentMessage?.role, agentMessage?.authorId], ["AGENT", "user_member"]);
  const handoff = after.handoffs.at(-1);
  assert.ok(handoff?.acceptedAt && handoff.firstResponseAt && !handoff.endedAt);

  assert.equal((await say("Great, and the yearly price?", id)).type, "held");
  assert.equal(requests.length, 0);

  // Handed back: the AI answers again, with the whole conversation, the agent's words included.
  const back = await act(id, { action: "return_to_ai" });
  assert.equal(back.json<InboxConversation>().status, "AI_ACTIVE");
  assert.equal(back.json<InboxConversation>().handoffs.at(-1)?.outcome, "returned_to_ai");
  script = [() => ({ text: "The yearly price is $490." })];
  const resumed = await say("So, yearly?", id);
  assert.ok(resumed.type === "done" && !resumed.handoff);
  const sentToModel = requests[0]!;
  assert.match(sentToModel.system, /handled by a human colleague/);
  const turns = sentToModel.messages.map((m) => [m.role, "content" in m ? m.content : ""]);
  // Roles alternate: messages kept while people had the conversation are joined.
  assert.deepEqual(turns, [
    ["user", "Hi, can I talk to a human please?"],
    ["assistant", first.messages[1].content],
    ["user", "Hello? Anyone there?"],
    ["assistant", "Hi, I'm Sam from the team. The Pro plan costs $49 a month."],
    ["user", "Great, and the yearly price?\n\nSo, yearly?"],
  ]);

  // Resolve, then the customer writes again: reopened, and the AI answers.
  assert.equal((await act(id, { action: "resolve" })).json<InboxConversation>().status, "RESOLVED");
  const reopened = await say("One more question", id);
  assert.ok(reopened.type === "done");
  assert.equal(reopened.conversation.status, "REOPENED");
  assert.equal((await act(id, { action: "reopen" })).statusCode, 409);
});

test("the model hands off on low confidence and policy risk through the transfer tool", async () => {
  script = [() => ({ text: "", calls: [{ id: "t1", name: "transfer_to_human", input: { reason: "low_confidence", note: "Asks about a custom SLA" } }] })];
  const low = await say("What SLA do you offer for on-prem installs?");
  assert.ok(low.type === "done");
  assert.deepEqual([low.handoff?.trigger, low.handoff?.reason], ["low_confidence", "Asks about a custom SLA"]);
  // The tool is offered with instructions; registry tools still are too.
  assert.deepEqual(requests[0]?.tools?.map((t) => t.name).sort(), ["http_request", "transfer_to_human"]);
  assert.match(requests[0]?.system ?? "", /low_confidence: you cannot answer reliably/);

  script = [() => ({ text: "Let me get a colleague.", calls: [{ id: "t2", name: "transfer_to_human", input: { reason: "policy_risk", note: "Threatens legal action" } }] })];
  const risk = await say("I'll sue you unless you pay me back");
  assert.ok(risk.type === "done");
  assert.equal(risk.handoff?.trigger, "policy_risk");
  assert.match(risk.messages[1].content, /^Let me get a colleague\.\n\n.*member of our team/s);
});

test("a failed tool and repeated failures hand off", async () => {
  script = [
    () => ({ text: "", calls: [{ id: "h1", name: "http_request", input: { method: "GET", url: "https://other.example.com/orders/1" } }] }),
    () => ({ text: "Sorry, I could not look up your order." }),
  ];
  const tool = await say("Where is order 1?");
  assert.ok(tool.type === "done");
  assert.deepEqual([tool.handoff?.trigger, tool.handoff?.reason], ["tool_failure", "The http_request tool failed"]);
  assert.match(tool.messages[1].content, /^Sorry, I could not look up your order\.\n\n/);
  assert.equal(tool.messages[1].tools[0]?.status, "FAILED");

  // Two failed replies in a row in the same conversation (the limit is 2).
  const start = await say("Hello");
  assert.ok(start.type === "done");
  const id = start.conversation.id;
  script = [() => ({ fail: true })];
  const once = await say("Are you there?", id);
  assert.equal(once.type, "error");
  script = [() => ({ fail: true })];
  const twice = await say("Hello??", id);
  assert.ok(twice.type === "done");
  assert.equal(twice.handoff?.trigger, "repeated_failure");
  assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id } })).status, "WAITING_FOR_HUMAN");
});

test("high-value customers and configured conditions hand off once per conversation", async () => {
  const customerId = await identifyCustomer({ organizationId: orgA, workspaceId: ws }, "vip@example.test");
  await prisma.$transaction(factWrites(customerId, [{ category: "lead", key: "budget", value: "$80,000" }], null));
  const res = await call("POST", `/workspaces/${ws}/employees/${ava}/messages`, { message: "Hi there", customer: "vip@example.test" });
  const vip = parse(res.payload).at(-1);
  assert.ok(vip?.type === "done");
  assert.deepEqual([vip.handoff?.trigger, vip.handoff?.reason], ["high_value_customer", "budget is $80,000"]);
  assert.equal(requests.length, 0);
  // Handed back on purpose: the same customer is not handed off again in this conversation.
  await act(vip.conversation.id, { action: "return_to_ai" });
  const again = await say("Thanks", vip.conversation.id);
  assert.ok(again.type === "done" && !again.handoff);

  const refund = await say("I would like a refund for last month");
  assert.ok(refund.type === "done");
  assert.deepEqual([refund.handoff?.trigger, refund.handoff?.reason], ["workflow_condition", 'Condition: message contains "refund"']);

  // A workflow step hands a conversation over the same way, and only once.
  const plain = await say("Hello from a workflow");
  assert.ok(plain.type === "done");
  const target = { id: plain.conversation.id, organizationId: orgA, workspaceId: ws };
  assert.ok(await startHandoff(target, { trigger: "workflow_condition", reason: "Workflow: call back" }));
  assert.equal(await startHandoff(target, { trigger: "workflow_condition", reason: "Workflow: call back" }), null);
});

test("web chat: the visitor waits for a person, receives the agent's messages, and the AI returns after resolution", async () => {
  const chat = (path: string, payload: object, headers: Headers = {}) =>
    app.inject({ method: "POST", url: `/chat/${web.address}/${path}`, headers: { "content-type": "application/json", ...headers }, payload });
  const session = (await chat("session", {})).json<{ token: string; status: string; visitorId: string }>();
  const auth = { authorization: `Bearer ${session.token}` };
  assert.equal(session.status, "AI_ACTIVE");

  const asked = parse((await chat("messages", { message: "I need to speak to a person" }, auth)).payload).at(-1);
  assert.ok(asked?.type === "done" && asked.handoff);
  const id = asked.conversation.id;
  const since = asked.messages[1].createdAt;

  const held = parse((await chat("messages", { message: "My order number is 5521" }, auth)).payload);
  assert.deepEqual(held.map((e) => e.type), ["held"]);
  const inbound = await prisma.channelMessage.findFirst({ where: { conversationId: id, direction: "INBOUND", text: "My order number is 5521" } });
  assert.equal(inbound?.status, "HELD");

  // Resuming the widget shows the conversation is with people.
  assert.equal((await chat("session", { visitorId: session.visitorId })).json<{ status: string }>().status, "WAITING_FOR_HUMAN");

  const sent = await reply(id, { text: "Hi, Sam here. Order 5521 ships tomorrow." });
  assert.equal(sent.statusCode, 200, sent.payload);
  const poll = await app.inject({ method: "GET", url: `/chat/${web.address}/messages?after=${encodeURIComponent(since)}`, headers: auth });
  assert.equal(poll.statusCode, 200, poll.payload);
  const polled = poll.json<{ status: string; messages: { role: string; content: string }[] }>();
  assert.equal(polled.status, "HUMAN_ACTIVE");
  assert.deepEqual(polled.messages.map((m) => [m.role, m.content]), [["AGENT", "Hi, Sam here. Order 5521 ships tomorrow."]]);
  const outbound = await prisma.channelMessage.findFirst({ where: { conversationId: id, direction: "OUTBOUND", text: { startsWith: "Hi, Sam here" } } });
  assert.equal(outbound?.status, "SENT");
  // Forged sessions read nothing.
  assert.equal((await app.inject({ method: "GET", url: `/chat/${web.address}/messages?after=${encodeURIComponent(since)}`, headers: { authorization: "Bearer x.y" } })).statusCode, 401);

  assert.equal((await act(id, { action: "resolve" })).statusCode, 200);
  script = [() => ({ text: "Anything else I can help with?" })];
  const back = parse((await chat("messages", { message: "Thanks!" }, auth)).payload).at(-1);
  assert.ok(back?.type === "done");
  assert.equal(back.conversation.status, "REOPENED");
});

test("WhatsApp: messages to a conversation with people are kept, not answered; the agent's reply goes out on WhatsApp", async () => {
  let count = 0;
  const waSend = async (text: string) => {
    const wamid = `wamid.h-${Date.now()}-${++count}`;
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "W", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "1", phone_number_id: PNID }, contacts: [{ wa_id: WA_ID }], messages: [{ from: WA_ID, id: wamid, timestamp: "1", type: "text", text: { body: text } }] } }] }],
    });
    const res = await app.inject({ method: "POST", url: "/channels/whatsapp/meta/webhook", headers: { "content-type": "application/json", "x-hub-signature-256": metaSignature(APP_SECRET, raw) }, payload: raw });
    assert.equal(res.statusCode, 200);
    await until(async () => {
      const row = await prisma.channelMessage.findFirst({ where: { providerMessageId: wamid } });
      return row !== null && row.status !== "RECEIVED";
    }, "the message to settle");
    return (await prisma.channelMessage.findFirstOrThrow({ where: { providerMessageId: wamid } }))!;
  };

  const first = await waSend("Talk to an agent");
  assert.equal(first.status, "ANSWERED");
  assert.match(sent.at(-1)?.text ?? "", /member of our team/);
  const id = first.conversationId!;
  sent = [];
  const held = await waSend("It's about my invoice");
  assert.deepEqual([held.status, held.conversationId], ["HELD", id]);
  assert.equal(sent.length, 0);
  assert.equal(requests.length, 0);

  const answered = await reply(id, { text: "Hi, this is Sam. Which invoice number?" });
  assert.equal(answered.statusCode, 200, answered.payload);
  assert.deepEqual(sent, [{ to: WA_ID, text: "Hi, this is Sam. Which invoice number?" }]);
});

test("Copilot: a suggestion with summary, memory and next action, logged apart from messages, and its use recorded", async () => {
  const res = await call("POST", `/workspaces/${ws}/employees/${ava}/messages`, { message: "Can I speak to a human about my plan?", customer: "copilot@example.test" });
  const done = parse(res.payload).at(-1);
  assert.ok(done?.type === "done");
  const id = done.conversation.id;
  const customerId = await identifyCustomer({ organizationId: orgA, workspaceId: ws }, "copilot@example.test");
  await prisma.$transaction(factWrites(customerId, [{ category: "preference", key: "plan", value: "Pro" }], null));

  script = [
    (req) => {
      assert.match(req.system, /copilot for a human support agent/);
      assert.match(req.system, /- plan: Pro/);
      assert.match("content" in req.messages[0]! ? req.messages[0].content : "", /Customer: Can I speak to a human/);
      return { text: '```json\n{"summary":"Pro customer wants a person to discuss the plan.","reply":"Hi! Happy to help with your Pro plan.","nextAction":"Ask what they want to change.","citations":[]}\n```' };
    },
  ];
  const made = await call("POST", `${conv(id)}/copilot`, {}, memberOf(orgA));
  assert.equal(made.statusCode, 200, made.payload);
  const suggestion = made.json<CopilotSuggestion>();
  assert.deepEqual([suggestion.summary, suggestion.reply, suggestion.nextAction], [
    "Pro customer wants a person to discuss the plan.",
    "Hi! Happy to help with your Pro plan.",
    "Ask what they want to change.",
  ]);
  assert.deepEqual(suggestion.memory, [{ key: "plan", value: "Pro" }]);
  assert.deepEqual(suggestion.citations, []);
  // Not a message of the conversation.
  assert.equal((await detail(id)).messages.length, 2);

  const used = await reply(id, { text: "Hi! Happy to help with your Pro plan.", suggestionId: suggestion.id });
  assert.equal(used.statusCode, 200, used.payload);
  const after = used.json<InboxConversation>();
  assert.equal(after.suggestions[0]?.usedInMessageId, after.messages.at(-1)?.id);
  assert.equal((await prisma.copilotSuggestion.findUniqueOrThrow({ where: { id: suggestion.id } })).edited, false);
});

test("assignment, isolation and channels an agent cannot write on", async () => {
  const done = await say("Talk to a person");
  assert.ok(done.type === "done");
  const id = done.conversation.id;
  // Assigned to a teammate: out of the queue, in their "mine".
  const assigned = await act(id, { action: "assign", userId: "user_admin" });
  assert.equal(assigned.json<InboxConversation>().assignedTo, "user_admin");
  assert.ok(!(await inbox("queue")).items.some((i) => i.id === id));
  const theirs = (await call("GET", `/workspaces/${ws}/inbox?view=mine`, undefined, adminOf(orgA))).json<InboxResponse>();
  assert.ok(theirs.items.some((i) => i.id === id));
  // Unassigned: back in the queue, waiting.
  const unassigned = await act(id, { action: "assign", userId: null });
  assert.deepEqual([unassigned.json<InboxConversation>().status, unassigned.json<InboxConversation>().assignedTo], ["WAITING_FOR_HUMAN", null]);
  assert.equal((await act(id, { action: "reopen" })).statusCode, 409);
  assert.equal((await act(id, { action: "fly" })).statusCode, 400);

  // Another organization sees nothing.
  assert.equal((await call("GET", conv(id), undefined, memberOf(orgB))).statusCode, 404);
  assert.equal((await call("GET", `/workspaces/${wsB}/conversations/${id}`, undefined, memberOf(orgB))).statusCode, 404);
  assert.equal((await call("PATCH", `/workspaces/${wsB}/conversations/${id}`, { action: "take_over" }, memberOf(orgB))).statusCode, 404);
  assert.equal((await call("GET", conv(id), undefined, {})).statusCode, 401);

  // Calls are not continued by text.
  const voice = await prisma.conversation.create({ data: { organizationId: orgA, workspaceId: ws, employeeId: ava, channel: "voice", title: "Call", createdBy: "voice" } });
  assert.equal((await detail(voice.id)).canReply, false);
  const refused = await reply(voice.id, { text: "Hello" });
  assert.equal(refused.statusCode, 409);
  assert.match(refused.json<{ error: string }>().error, /Call the customer back/);
});

test("handoff analytics: counts by trigger, outcomes, response times, Copilot use", async () => {
  const res = await call("GET", `/workspaces/${ws}/handoffs/analytics?days=7`, undefined, memberOf(orgA));
  assert.equal(res.statusCode, 200, res.payload);
  const a = res.json<HandoffAnalytics>();
  const by = Object.fromEntries(a.byTrigger.map((t) => [t.trigger, t.count]));
  for (const trigger of ["customer_request", "low_confidence", "policy_risk", "tool_failure", "repeated_failure", "high_value_customer", "workflow_condition"])
    assert.ok((by[trigger] ?? 0) >= 1, trigger);
  assert.equal(a.handoffs, a.byTrigger.reduce((s, t) => s + t.count, 0));
  assert.ok(a.outcomes.resolved >= 1 && a.outcomes.returnedToAi >= 1 && a.outcomes.open >= 1);
  assert.ok(a.timeToFirstResponse.count >= 3 && a.timeToAccept.count >= 3);
  assert.ok(a.replyTime.ai.count >= 1 && a.replyTime.human.count >= 3);
  assert.ok(a.byAgent.some((x) => x.agentId === "user_member" && x.firstResponse.count >= 1));
  assert.deepEqual(a.suggestions, { total: 1, used: 1 });
  assert.ok(a.handoffRate !== null && a.handoffRate > 0 && a.handoffRate <= 1);
  assert.ok(a.daily.length >= 7 && a.daily.length <= 8);
  assert.equal(a.daily.reduce((s, d) => s + d.handoffs, 0), a.handoffs);
  assert.equal(a.weekly.length, 1);
  assert.equal(a.weekly[0]!.active > 0 ? a.weekly[0]!.handedOff / a.weekly[0]!.active : null, a.handoffRate, "a 7-day week counts each conversation once");
  assert.ok(a.daily.some((d) => d.active > 0 && d.handedOff > 0 && d.handedOff <= d.handoffs));
  assert.equal(a.replyBands.ai.length, 4);
  assert.equal(a.replyBands.ai.reduce((s, n) => s + n, 0), a.replyTime.ai.count, "every AI reply lands in one band");
  assert.equal(a.replyBands.human.reduce((s, n) => s + n, 0), a.replyTime.human.count, "every human reply lands in one band");
  assert.ok("ai" in a.previousReplyMedian && "human" in a.previousReplyMedian);
  assert.ok(a.previousHandoffRate === null || (a.previousHandoffRate >= 0 && a.previousHandoffRate <= 1));
  assert.equal((await call("GET", `/workspaces/${ws}/handoffs/analytics`, undefined, memberOf(orgB))).statusCode, 404);
});

test("dashboard: one summary that agrees with the full analytics, scoped to the workspace", async () => {
  const res = await call("GET", `/workspaces/${ws}/dashboard`, undefined, memberOf(orgA));
  assert.equal(res.statusCode, 200, res.payload);
  const d = res.json<DashboardSummary>();
  const full = (await call("GET", `/workspaces/${ws}/handoffs/analytics?days=7`, undefined, memberOf(orgA))).json<HandoffAnalytics>();
  assert.equal(d.handoffs, full.handoffs);
  assert.deepEqual(d.open, full.open);
  assert.equal(d.handoffRate, full.handoffRate);
  assert.ok(d.employees.list.every((e) => e.status !== "ARCHIVED"));
  assert.ok(d.billing.workspaceUsd <= d.billing.organizationUsd + 1e-9);
  assert.equal((await call("GET", `/workspaces/${ws}/dashboard`, undefined, memberOf(orgB))).statusCode, 404);
  // Thresholds: defaults first, admins change them, members cannot, other organizations get 404.
  assert.deepEqual(d.attention, { handoffRateRise: 5, qualityScoreBelow: 70, limitUsedPercent: 80 });
  const next = { handoffRateRise: 10, qualityScoreBelow: 60, limitUsedPercent: 90 };
  assert.equal((await call("PUT", `/workspaces/${ws}/attention`, next, memberOf(orgA))).statusCode, 403);
  assert.equal((await call("PUT", `/workspaces/${ws}/attention`, next, adminOf(orgB))).statusCode, 404);
  assert.equal((await call("PUT", `/workspaces/${ws}/attention`, { ...next, limitUsedPercent: 10 }, adminOf(orgA))).statusCode, 400);
  assert.equal((await call("PUT", `/workspaces/${ws}/attention`, next, adminOf(orgA))).statusCode, 200);
  assert.deepEqual((await call("GET", `/workspaces/${ws}/dashboard`, undefined, memberOf(orgA))).json<DashboardSummary>().attention, next);
  assert.deepEqual((await call("GET", `/workspaces/${ws}/attention`, undefined, memberOf(orgA))).json(), next);
  assert.equal((await call("GET", `/workspaces/${ws}/attention`, undefined, memberOf(orgB))).statusCode, 404);
});
