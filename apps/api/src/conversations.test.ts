// Needs the database from .env to be running (pnpm infra:up && pnpm db:migrate).
// The model is faked: these tests cover the runtime, storage and authorization, not a vendor.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { AIProviderError, type AIProvider, type CompletionRequest } from "@workforce/ai-provider";
import { prisma } from "@workforce/database";
import {
  defaultEmployeeConfig,
  type ApiError,
  type ChatStreamEvent,
  type ConversationDetail,
  type ConversationSummary,
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
let employeeId: string;

/** What the fake model does next, and what it was last asked. */
let behave: "reply" | "fail" | "hang" = "reply";
let requests: CompletionRequest[] = [];
const fake: AIProvider = {
  name: "fake",
  model: "fake-1",
  async *stream(request) {
    requests.push(request);
    if (behave === "fail") throw new AIProviderError("rate_limit", "slow down");
    if (behave === "hang")
      await new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    yield { type: "text", text: "Hello " };
    yield { type: "text", text: `(${request.messages.length})` };
    yield { type: "done", inputTokens: 12, outputTokens: 3 };
  },
};

type Headers = Record<string, string>;
const employeePath = (ws = wsA, id = employeeId) => `/workspaces/${ws}/employees/${id}`;
const get = (url: string, headers: Headers) => app.inject({ method: "GET", url, headers });
const send = async (headers: Headers, payload: object, path = employeePath()) => {
  const res = await app.inject({ method: "POST", url: `${path}/messages`, headers, payload });
  const events = res.payload
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.replace(/^data: /, "")) as ChatStreamEvent);
  return { res, events, last: events.at(-1) };
};
const saved = () => prisma.conversationMessage.count({ where: { conversation: { organizationId: orgA } } });

before(async () => {
  app = await buildApp({ authenticate: headerAuth, provider: fake, aiTimeoutMs: 200, logger: false });
  const defaultOf = async (org: string) => {
    const [first] = (await get("/workspaces", adminOf(org))).json<Workspace[]>();
    assert.ok(first);
    return first.id;
  };
  wsA = await defaultOf(orgA);
  wsB = await defaultOf(orgB);
  const created = await app.inject({
    method: "POST",
    url: `/workspaces/${wsA}/employees`,
    headers: adminOf(orgA),
    payload: { ...defaultEmployeeConfig(), name: "Ava", role: "Support agent", systemInstructions: "Be brief." },
  });
  employeeId = created.json<EmployeeDetail>().id;
});
beforeEach(() => {
  behave = "reply";
  requests = [];
});
after(async () => {
  await deleteOrgs(orgA, orgB);
  await app.close();
});

test("a turn streams the reply, saves both messages with usage, and later turns carry the history", async () => {
  const first = await send(adminOf(orgA), { message: "  Hi there  " });
  assert.equal(first.res.statusCode, 200);
  assert.match(String(first.res.headers["content-type"]), /text\/event-stream/);
  assert.deepEqual(first.events.slice(0, 2), [
    { type: "text", text: "Hello " },
    { type: "text", text: "(1)" },
  ]);
  assert.ok(first.last?.type === "done");
  const [user, assistant] = first.last.messages;
  assert.deepEqual([user.role, user.content], ["USER", "Hi there"]);
  assert.deepEqual(
    [assistant.role, assistant.content, assistant.employeeVersion, assistant.model, assistant.inputTokens, assistant.outputTokens],
    ["ASSISTANT", "Hello (1)", 1, "fake-1", 12, 3],
  );
  assert.equal(first.last.conversation.title, "Hi there");

  // The model is told who it is from the employee's configuration.
  assert.match(requests[0]?.system ?? "", /You are Ava.*Support agent/s);
  assert.match(requests[0]?.system ?? "", /Be brief\./);

  const conversationId = first.last.conversation.id;
  const second = await send(adminOf(orgA), { conversationId, message: "And again" });
  assert.ok(second.last?.type === "done");
  assert.equal(second.last.conversation.id, conversationId);
  assert.deepEqual(requests[1]?.messages, [
    { role: "user", content: "Hi there" },
    { role: "assistant", content: "Hello (1)" },
    { role: "user", content: "And again" },
  ]);

  const detail = (await get(`${employeePath()}/conversations/${conversationId}`, memberOf(orgA))).json<ConversationDetail>();
  assert.deepEqual(
    detail.messages.map((m) => [m.role, m.content]),
    [
      ["USER", "Hi there"],
      ["ASSISTANT", "Hello (1)"],
      ["USER", "And again"],
      ["ASSISTANT", "Hello (3)"],
    ],
  );
  const list = (await get(`${employeePath()}/conversations`, memberOf(orgA))).json<ConversationSummary[]>();
  assert.deepEqual(
    list.map((c) => c.id),
    [conversationId],
  );
});

test("test chat uses the latest version, published or not", async () => {
  const edited = await app.inject({
    method: "PUT",
    url: employeePath(),
    headers: adminOf(orgA),
    payload: { ...defaultEmployeeConfig(), name: "Ava", role: "Billing specialist" },
  });
  assert.equal(edited.statusCode, 200);
  const { last } = await send(adminOf(orgA), { message: "Hi" });
  assert.ok(last?.type === "done");
  assert.equal(last.messages[1].employeeVersion, 2);
  assert.match(requests[0]?.system ?? "", /Billing specialist/);
});

test("a provider failure or a timeout ends the stream with an error and saves nothing", async () => {
  const before = await saved();

  behave = "fail";
  const failed = await send(adminOf(orgA), { message: "Hi" });
  assert.equal(failed.res.statusCode, 200);
  assert.ok(failed.last?.type === "error");
  assert.match(failed.last.error, /rate limiting/);
  // The vendor's own message stays in the server log.
  assert.doesNotMatch(failed.res.payload, /slow down/);

  behave = "hang";
  const timedOut = await send(adminOf(orgA), { message: "Hi" });
  assert.ok(timedOut.last?.type === "error");
  assert.match(timedOut.last.error, /took too long/);

  assert.equal(await saved(), before);
});

test("validation and state: empty messages, unknown conversations and archived employees are refused", async () => {
  const empty = await send(adminOf(orgA), { message: "   " });
  assert.equal(empty.res.statusCode, 400);
  assert.equal(empty.res.json<ApiError>().issues?.[0]?.path, "message");

  assert.equal((await send(adminOf(orgA), { conversationId: "nope", message: "Hi" })).res.statusCode, 404);

  const status = (s: string) =>
    app.inject({ method: "PATCH", url: `${employeePath()}/status`, headers: adminOf(orgA), payload: { status: s } });
  await status("ARCHIVED");
  assert.equal((await send(adminOf(orgA), { message: "Hi" })).res.statusCode, 409);
  await status("PAUSED");
  assert.equal(requests.length, 0);
});

test("authorization and isolation: members read, admins chat, other tenants see nothing", async () => {
  const { last } = await send(adminOf(orgA), { message: "Private" });
  assert.ok(last?.type === "done");
  const conversation = `${employeePath()}/conversations/${last.conversation.id}`;
  requests = [];

  assert.equal((await send({}, { message: "Hi" })).res.statusCode, 401);
  assert.equal((await send(memberOf(orgA), { message: "Hi" })).res.statusCode, 403);
  assert.equal((await get(conversation, memberOf(orgA))).statusCode, 200);

  // Another organization, using its own workspace or ours, finds nothing.
  for (const ws of [wsA, wsB]) {
    const path = employeePath(ws);
    assert.equal((await send(adminOf(orgB), { message: "Hi" }, path)).res.statusCode, 404);
    assert.equal((await get(`${path}/conversations/${last.conversation.id}`, adminOf(orgB))).statusCode, 404);
  }
  assert.equal((await get(`${employeePath(wsA)}/conversations`, adminOf(orgB))).statusCode, 404);
  assert.deepEqual((await get(`${employeePath(wsB)}/conversations`, adminOf(orgB))).json(), []);
  assert.equal(requests.length, 0);
});
