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
  type ConversationSummaryPage,
  type EmployeeDetail,
  type MessagePage,
  type NewMessages,
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
  const list = (await get(`${employeePath()}/conversations`, memberOf(orgA))).json<ConversationSummaryPage>();
  assert.deepEqual(
    [list.data.map((c) => c.id), list.nextCursor],
    [[conversationId], null],
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
  assert.deepEqual((await get(`${employeePath(wsB)}/conversations`, adminOf(orgB))).json(), { data: [], nextCursor: null });
  assert.equal(requests.length, 0);
});

test("test chats page by cursor, newest activity first, and a cursor only works for its own list", async () => {
  const created = await app.inject({
    method: "POST",
    url: `/workspaces/${wsA}/employees`,
    headers: adminOf(orgA),
    payload: { ...defaultEmployeeConfig(), name: "Bea", role: "Pager" },
  });
  const bea = created.json<EmployeeDetail>().id;
  const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 12, minutes));
  // Two chats share a timestamp: the id breaks the tie, so neither is skipped or repeated across pages.
  for (const [title, minutes, channel] of [["a", 1, "test"], ["b", 2, "test"], ["c", 2, "test"], ["d", 3, "test"], ["e", 4, "test"], ["replay", 5, "evaluation"]] as const)
    await prisma.conversation.create({ data: { organizationId: orgA, workspaceId: wsA, employeeId: bea, channel, title, createdBy: "user_admin", updatedAt: at(minutes) } });
  const expected = await prisma.conversation.findMany({
    where: { employeeId: bea, channel: "test" },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });

  const path = `${employeePath(wsA, bea)}/conversations`;
  const seen: string[] = [];
  const cursors: (string | null)[] = [];
  let cursor: string | null = null;
  do {
    const res = await get(`${path}?limit=2${cursor ? `&cursor=${cursor}` : ""}`, memberOf(orgA));
    assert.equal(res.statusCode, 200, res.payload);
    const page = res.json<ConversationSummaryPage>();
    seen.push(...page.data.map((c) => c.id));
    cursor = page.nextCursor;
    cursors.push(cursor);
  } while (cursor);
  // Five chats, two a page; the evaluation replay is left out.
  assert.deepEqual(seen, expected.map((c) => c.id));
  assert.equal(cursors.length, 3);

  const first = cursors[0]!;
  assert.equal((await get(`${path}?cursor=not-a-cursor`, memberOf(orgA))).statusCode, 400);
  // Another employee's list is another list.
  assert.equal((await get(`${employeePath()}/conversations?cursor=${first}`, memberOf(orgA))).statusCode, 400);
  // Another organization finds nothing, cursor or not.
  assert.equal((await get(`${employeePath(wsA, bea)}/conversations?cursor=${first}`, adminOf(orgB))).statusCode, 404);
  assert.deepEqual((await get(`${employeePath(wsB, bea)}/conversations`, adminOf(orgB))).json(), { data: [], nextCursor: null });
});

test("a long test chat: the newest 100 messages, earlier pages by cursor, polling with ?after=, scoped to the employee", async () => {
  const conversation = await prisma.conversation.create({ data: { organizationId: orgA, workspaceId: wsA, employeeId, channel: "test", title: "Long", createdBy: "user_admin" } });
  const start = Date.UTC(2026, 0, 3);
  const add = (from: number, count: number) =>
    prisma.conversationMessage.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        organizationId: orgA,
        workspaceId: wsA,
        conversationId: conversation.id,
        role: (from + i) % 2 ? ("ASSISTANT" as const) : ("USER" as const),
        content: `m${from + i}`,
        createdAt: new Date(start + (from + i) * 1000),
      })),
    });
  await add(0, 104);
  const ids = async () =>
    (await prisma.conversationMessage.findMany({ where: { conversationId: conversation.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } })).map((m) => m.id);
  const path = `${employeePath()}/conversations/${conversation.id}`;

  const detail = (await get(path, memberOf(orgA))).json<ConversationDetail>();
  const all = await ids();
  assert.deepEqual(detail.messages.map((m) => m.id), all.slice(4));
  assert.ok(detail.olderCursor);
  const older = (await get(`${path}/messages?cursor=${detail.olderCursor}`, memberOf(orgA))).json<MessagePage>();
  assert.deepEqual([older.data.map((m) => m.id), older.nextCursor], [all.slice(0, 4), null]);

  // Polling: only what is new since the newest message shown.
  await add(104, 3);
  const polled = (await get(`${path}?after=${detail.newestCursor}`, memberOf(orgA))).json<ConversationDetail>();
  assert.deepEqual([polled.messages.map((m) => m.id), polled.caughtUp, polled.olderCursor], [(await ids()).slice(104), true, null]);
  const none = (await get(`${path}/messages/new?after=${polled.newestCursor}`, memberOf(orgA))).json<NewMessages>();
  assert.deepEqual(none, { data: [], cursor: polled.newestCursor, more: false });

  assert.equal((await get(`${path}/messages?cursor=garbage`, memberOf(orgA))).statusCode, 400);
  assert.equal((await get(`${path}?after=garbage`, memberOf(orgA))).statusCode, 400);
  // Another employee's path, or another organization: not found.
  const bea = (
    await app.inject({ method: "POST", url: `/workspaces/${wsA}/employees`, headers: adminOf(orgA), payload: { ...defaultEmployeeConfig(), name: "Cleo", role: "Other" } })
  ).json<EmployeeDetail>().id;
  assert.equal((await get(`${employeePath(wsA, bea)}/conversations/${conversation.id}/messages?cursor=${detail.olderCursor}`, memberOf(orgA))).statusCode, 404);
  assert.equal((await get(`${path}/messages/new?after=${detail.newestCursor}`, adminOf(orgB))).statusCode, 404);
  assert.equal((await get(`${employeePath(wsB)}/conversations/${conversation.id}/messages`, adminOf(orgB))).statusCode, 404);
});
