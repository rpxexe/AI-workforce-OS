// Needs the database from .env to be running (pnpm infra:up && pnpm db:migrate).
// The model is faked: these tests cover what memory stores, recalls and isolates, not how well a
// real model extracts (live.test.ts does that).
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { AIProviderError, type AIProvider, type CompletionRequest } from "@workforce/ai-provider";
import { prisma } from "@workforce/database";
import { EXTRACTION_PROMPT, memoryService, parseExtraction } from "@workforce/memory";
import {
  defaultEmployeeConfig,
  type ChatStreamEvent,
  type ConversationDetail,
  type CustomerDetail,
  type CustomerPage,
  type EmployeeDetail,
  type Workspace,
} from "@workforce/shared";
import { buildApp } from "./app.ts";
import { adminOf, deleteOrgs, headerAuth, memberOf, newOrg } from "./testing.ts";

const orgA = newOrg();
const orgB = newOrg();
let app: Awaited<ReturnType<typeof buildApp>>;
let wsA: string;
let wsB: string;
let employeeA: string;
let employeeB: string;

/** What the fake extractor answers next; replies get a fixed text. */
let extraction: string | "fail" = '{"memories":[]}';
let replies: CompletionRequest[] = [];
let extractions: CompletionRequest[] = [];
const fake: AIProvider = {
  name: "fake",
  model: "fake-1",
  async *stream(request) {
    if (request.system.startsWith(EXTRACTION_PROMPT)) {
      extractions.push(request);
      if (extraction === "fail") throw new AIProviderError("unavailable", "down");
      yield { type: "text", text: extraction };
    } else {
      replies.push(request);
      yield { type: "text", text: "Happy to help." };
    }
    yield { type: "done", inputTokens: 1, outputTokens: 1 };
  },
};

/** Memory updates run after the reply; tests wait for them through this. */
let pending: Promise<unknown>[] = [];
const settled = () => Promise.allSettled(pending);

type Headers = Record<string, string>;
const get = (url: string, headers: Headers) => app.inject({ method: "GET", url, headers });
const send = async (org: string, ws: string, employee: string, payload: object) => {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${ws}/employees/${employee}/messages`,
    headers: adminOf(org),
    payload,
  });
  const last = res.payload
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.replace(/^data: /, "")) as ChatStreamEvent)
    .at(-1);
  assert.ok(last?.type === "done", `the turn failed: ${res.payload}`);
  await settled();
  return last;
};
const customers = async (org: string, ws: string) => (await get(`/workspaces/${ws}/customers`, memberOf(org))).json<CustomerPage>().data;
const detail = async (org: string, ws: string, id: string) =>
  (await get(`/workspaces/${ws}/customers/${id}`, memberOf(org))).json<CustomerDetail>();
const factsOf = (d: CustomerDetail) => Object.fromEntries(d.memories.map((m) => [m.key, m.value]));

const RAHUL = "My name is Rahul. I am interested in the enterprise plan and my budget is around 50,000.";
const RAHUL_EXTRACTION = JSON.stringify({
  memories: [
    { category: "identity", key: "name", value: "Rahul" },
    { category: "lead", key: "interest", value: "enterprise" },
    { category: "lead", key: "budget", value: 50000 },
  ],
  summary: "Rahul asked about the enterprise plan, budget about 50000.",
});

before(async () => {
  app = await buildApp({
    authenticate: headerAuth,
    provider: fake,
    logger: false,
    memory: (provider, timeoutMs) => {
      const real = memoryService(provider, timeoutMs);
      return {
        ...real,
        remember: (input) => {
          const result = real.remember(input);
          pending.push(result);
          return result;
        },
      };
    },
  });
  const setup = async (org: string) => {
    const [ws] = (await get("/workspaces", adminOf(org))).json<Workspace[]>();
    assert.ok(ws);
    const employee = await app.inject({
      method: "POST",
      url: `/workspaces/${ws.id}/employees`,
      headers: adminOf(org),
      payload: { ...defaultEmployeeConfig(), name: "Ava", role: "Sales assistant" },
    });
    return [ws.id, employee.json<EmployeeDetail>().id] as const;
  };
  [wsA, employeeA] = await setup(orgA);
  [wsB, employeeB] = await setup(orgB);
});
beforeEach(() => {
  extraction = '{"memories":[]}';
  replies = [];
  extractions = [];
  pending = [];
});
after(async () => {
  await deleteOrgs(orgA, orgB);
  await app.close();
});

test("validation keeps stable, well-formed facts and drops the rest", () => {
  const { facts, summary } = parseExtraction(
    "```json\n" +
      JSON.stringify({
        memories: [
          { category: "identity", key: "Name", value: "Rahul" },
          { category: "lead", key: "Budget", value: 50000 },
          { category: "follow_up", key: "Follow-up date", value: "next Tuesday" },
          { category: "mood", key: "mood", value: "happy" }, // not a category
          { category: "fact", key: "password", value: "hunter2" }, // a secret
          { category: "fact", key: "payment", value: "card 4111 1111 1111 1111" }, // a card number
          { category: "identity", key: "phone", value: "+91 98765 43210" }, // a phone, not a card
          { category: "fact", key: "notes", value: "x".repeat(201) }, // too long
          { category: "fact", key: "", value: "empty key" },
          { category: "fact", key: "said", value: "" },
          { category: "fact", key: "object", value: { nested: true } },
          { category: "lead", key: "budget", value: "60000" }, // same key again: the later one wins
        ],
        summary: "  Asked about plans.  ",
      }) +
      "\n```",
  );
  assert.deepEqual(facts, [
    { category: "identity", key: "name", value: "Rahul" },
    { category: "lead", key: "budget", value: "60000" },
    { category: "follow_up", key: "follow_up_date", value: "next Tuesday" },
    { category: "identity", key: "phone", value: "+91 98765 43210" },
  ]);
  assert.equal(summary, "Asked about plans.");
  assert.deepEqual(parseExtraction("Sorry, I can't help with that."), { facts: [], summary: null });
  assert.deepEqual(parseExtraction('{"memories": "name=Rahul"}'), { facts: [], summary: null });
});

test("memory persists across conversations and is given to the employee", async () => {
  extraction = RAHUL_EXTRACTION;
  const first = await send(orgA, wsA, employeeA, { customer: "rahul@example.com", message: RAHUL });

  // A new customer: the employee is told it knows nothing yet, and the extractor saw the exchange.
  assert.match(replies[0]?.system ?? "", /not met this customer before/);
  assert.match(JSON.stringify(extractions[0]?.messages[0]), /Customer: My name is Rahul.*Assistant: Happy to help\./s);

  const [customer] = await customers(orgA, wsA);
  assert.ok(customer);
  assert.deepEqual([customer.externalId, customer.name], ["rahul@example.com", "Rahul"]);
  const stored = await detail(orgA, wsA, customer.id);
  assert.deepEqual(factsOf(stored), { name: "Rahul", interest: "enterprise", budget: "50000" });
  assert.equal(stored.conversations[0]?.id, first.conversation.id);
  assert.match(stored.conversations[0]?.summary ?? "", /enterprise plan/);
  // The conversation knows its customer.
  const opened = (
    await get(`/workspaces/${wsA}/employees/${employeeA}/conversations/${first.conversation.id}`, memberOf(orgA))
  ).json<ConversationDetail>();
  assert.equal(opened.customer, "rahul@example.com");

  // Days later, a new conversation with the same customer: memory is retrieved into the prompt.
  extraction = JSON.stringify({ memories: [{ category: "lead", key: "budget", value: "75000" }], summary: "Raised budget." });
  const second = await send(orgA, wsA, employeeA, { customer: "rahul@example.com", message: "Hi again" });
  const system = replies.at(-1)?.system ?? "";
  assert.match(system, /What you remember about this customer/);
  assert.match(system, /- name: Rahul/);
  assert.match(system, /- interest: enterprise/);
  assert.match(system, /- budget: 50000/);
  assert.match(system, /Earlier conversations, on any channel:\n- \d{4}-\d{2}-\d{2}, test chat: Rahul asked about the enterprise plan/);

  // Learning a key again replaces it; a later turn in the same conversation keeps its customer.
  assert.equal(factsOf(await detail(orgA, wsA, customer.id)).budget, "75000");
  await send(orgA, wsA, employeeA, { conversationId: second.conversation.id, message: "Thanks" });
  assert.match(replies.at(-1)?.system ?? "", /- budget: 75000/);
  // Its own summary is not repeated as an "earlier conversation".
  assert.doesNotMatch(replies.at(-1)?.system ?? "", /Raised budget/);
  assert.equal(await prisma.customer.count({ where: { organizationId: orgA } }), 1);
  assert.equal(await prisma.customerMemory.count({ where: { customerId: customer.id } }), 3);
});

test("memory is isolated by organization", async () => {
  extraction = RAHUL_EXTRACTION;
  await send(orgA, wsA, employeeA, { customer: "same@example.com", message: RAHUL });
  const [inA] = (await customers(orgA, wsA)).filter((c) => c.externalId === "same@example.com");
  assert.ok(inA);

  // The same identifier in another organization is a different customer with no memory.
  extraction = '{"memories":[]}';
  await send(orgB, wsB, employeeB, { customer: "same@example.com", message: "Hello" });
  assert.match(replies.at(-1)?.system ?? "", /not met this customer before/);
  assert.doesNotMatch(replies.at(-1)?.system ?? "", /Rahul/);

  const inB = await customers(orgB, wsB);
  assert.equal(inB.length, 1);
  assert.notEqual(inB[0]?.id, inA.id);
  assert.deepEqual((await detail(orgB, wsB, inB[0]?.id ?? "")).memories, []);
  // Another organization cannot read the customer, even through its own workspace.
  assert.equal((await get(`/workspaces/${wsB}/customers/${inA.id}`, memberOf(orgB))).statusCode, 404);
  assert.equal((await get(`/workspaces/${wsA}/customers/${inA.id}`, memberOf(orgB))).statusCode, 404);
  // And the service itself refuses to recall or write across organizations.
  const memory = memoryService(fake, 1000);
  const wrongScope = { organizationId: orgB, workspaceId: wsB, customerId: inA.id };
  assert.deepEqual(await memory.recall(wrongScope), { facts: [], previous: [] });
  await assert.rejects(memory.remember({ ...wrongScope, conversationId: "x", customerMessage: RAHUL, reply: "ok" }));
});

test("small talk, unusable extractions and failures store nothing, and the turn still succeeds", async () => {
  // The extractor finds nothing worth keeping: messages are not stored as memory.
  await send(orgA, wsA, employeeA, { customer: "visitor-1", message: "Hi! Nice weather today, isn't it?" });
  // The extractor returns prose instead of JSON.
  extraction = "The customer said hello.";
  await send(orgA, wsA, employeeA, { customer: "visitor-1", message: "Just browsing." });
  // The extractor proposes only things validation rejects.
  extraction = JSON.stringify({
    memories: [
      { category: "small_talk", key: "weather", value: "nice" },
      { category: "fact", key: "otp", value: "123456" },
    ],
  });
  await send(orgA, wsA, employeeA, { customer: "visitor-1", message: "My code is 123456" });
  // The extractor fails outright.
  extraction = "fail";
  await send(orgA, wsA, employeeA, { customer: "visitor-1", message: "Bye" });
  assert.equal(extractions.length, 4);

  const visitor = await prisma.customer.findFirstOrThrow({ where: { organizationId: orgA, externalId: "visitor-1" } });
  assert.equal(await prisma.customerMemory.count({ where: { customerId: visitor.id } }), 0);
});

test("without a customer, nothing is recalled or extracted", async () => {
  await send(orgA, wsA, employeeA, { message: RAHUL });
  assert.equal(extractions.length, 0);
  assert.match(replies[0]?.system ?? "", /no memory of other conversations/);
});
