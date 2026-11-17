// Needs the database from .env to be running (pnpm infra:up && pnpm db:migrate).
// The model and the network are faked: these tests cover the tool system, not a vendor.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { AIProvider, CompletionRequest, ToolCall } from "@workforce/ai-provider";
import { prisma } from "@workforce/database";
import {
  defaultEmployeeConfig,
  type ChatStreamEvent,
  type EmployeeDetail,
  type ToolExecutionRecord,
  type Workspace,
} from "@workforce/shared";
import {
  createToolExecutor,
  createToolRegistry,
  defineTool,
  isPrivateAddress,
  localTime,
  safeFetch,
  ToolError,
  toolRegistry,
  zonedTime,
  type ToolScope,
} from "@workforce/tools";
import { z } from "zod";
import { buildApp } from "./app.ts";
import { adminOf, deleteOrgs, headerAuth, memberOf, newOrg } from "./testing.ts";

const TZ = "Asia/Kolkata";
const orgA = newOrg();
const orgB = newOrg();
let app: Awaited<ReturnType<typeof buildApp>>;
let wsA: string;
let wsB: string;
let ava: string; // has tools
let bob: string; // has none

/** The fake model plays one step per request from this script, then says "OK". */
type Step = (request: CompletionRequest) => { text?: string; calls?: ToolCall[] };
let script: Step[] = [];
let requests: CompletionRequest[] = [];
const fake: AIProvider = {
  name: "fake",
  model: "fake-1",
  async *stream(request) {
    requests.push(request);
    const step: Step = script.shift() ?? (() => ({ text: "OK" }));
    const { text, calls } = step(request);
    if (text) yield { type: "text", text };
    yield { type: "done", inputTokens: 1, outputTokens: 1, ...(calls && { toolCalls: calls }) };
  },
};

/** The fake network tools reach. */
let fetched: { url: string; init?: RequestInit }[] = [];
let respond: () => Response | Promise<Response> = () => new Response("{}", { status: 200 });
const fakeFetch: typeof fetch = async (url, init) => {
  fetched.push({ url: String(url), init });
  return respond();
};

type Headers = Record<string, string>;
const get = (url: string, headers: Headers) => app.inject({ method: "GET", url, headers });
const grant = (employee: string, tools: object[], headers = adminOf(orgA)) =>
  app.inject({ method: "PUT", url: `/workspaces/${wsA}/employees/${employee}/tools`, headers, payload: { tools } });
const send = async (employee: string, message: string) => {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${wsA}/employees/${employee}/messages`,
    headers: adminOf(orgA),
    payload: { message },
  });
  const last = res.payload
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.replace(/^data: /, "")) as ChatStreamEvent)
    .at(-1);
  assert.ok(last?.type === "done", `the turn failed: ${res.payload}`);
  return last;
};
const call = (name: string, input: unknown, id = "call_1"): ToolCall => ({ id, name, input });
const tomorrow = () => localTime(new Date(Date.now() + 24 * 3600_000), TZ).slice(0, 10);
const scope = (employeeId = ava): ToolScope => ({
  organizationId: orgA,
  workspaceId: wsA,
  employeeId,
  conversationId: "conversation-test",
  timezone: TZ,
});
const executor = createToolExecutor(toolRegistry, { fetch: fakeFetch });
const signal = () => AbortSignal.timeout(10_000);

before(async () => {
  app = await buildApp({ authenticate: headerAuth, provider: fake, toolFetch: fakeFetch, logger: false });
  const workspaceOf = async (org: string) => (await get("/workspaces", adminOf(org))).json<Workspace[]>()[0]?.id ?? "";
  wsA = await workspaceOf(orgA);
  wsB = await workspaceOf(orgB);
  const create = async (name: string) =>
    (
      await app.inject({
        method: "POST",
        url: `/workspaces/${wsA}/employees`,
        headers: adminOf(orgA),
        payload: { ...defaultEmployeeConfig(TZ), name, role: "Sales assistant" },
      })
    ).json<EmployeeDetail>().id;
  ava = await create("Ava");
  bob = await create("Bob");
  const res = await grant(ava, [
    { name: "calendar_book_meeting" },
    { name: "send_email" },
    { name: "http_request", config: { allowedHosts: ["api.example.com"] } },
    { name: "send_webhook", config: { url: "https://hooks.example.com/in" } },
  ]);
  assert.equal(res.statusCode, 200, res.payload);
});
beforeEach(() => {
  script = [];
  requests = [];
  fetched = [];
  respond = () => new Response("{}", { status: 200 });
});
after(async () => {
  await deleteOrgs(orgA, orgB);
  await app.close();
});

test('"Book me a meeting tomorrow at 3 PM": select the calendar tool, validate, execute, answer from the result', async () => {
  const date = tomorrow();
  script = [
    // The model understands the request and picks the calendar tool from what it was offered.
    (req) => {
      assert.ok(req.tools?.some((t) => t.name === "calendar_book_meeting"));
      assert.match(req.system, new RegExp(`It is now \\w+, \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} \\(${TZ}\\)`));
      return {
        text: "Let me book that for you.",
        calls: [call("calendar_book_meeting", { title: "Meeting with customer", date, time: "15:00" })],
      };
    },
    // It reads the result and tells the customer.
    (req) => {
      const result = req.messages.at(-1);
      assert.ok(result?.role === "tool");
      const booked = JSON.parse(result.results[0]?.content ?? "{}") as { status: string; start: string };
      return { text: `Done: your meeting is ${booked.status} for ${booked.start}.` };
    },
  ];
  const done = await send(ava, "Book me a meeting tomorrow at 3 PM.");
  const reply = done.messages[1];

  assert.equal(reply.content, `Let me book that for you.\n\nDone: your meeting is booked for ${date} 15:00.`);
  assert.equal(reply.tools.length, 1);
  assert.deepEqual([reply.tools[0]?.tool, reply.tools[0]?.status], ["calendar_book_meeting", "SUCCEEDED"]);
  // The second request replayed the tool call and its result.
  assert.deepEqual(requests[1]?.messages.at(-2), {
    role: "assistant",
    content: "Let me book that for you.",
    toolCalls: [call("calendar_book_meeting", { title: "Meeting with customer", date, time: "15:00" })],
    raw: undefined,
  });

  // The meeting is in the calendar at 15:00 in the employee's time zone, linked to the conversation.
  const event = await prisma.calendarEvent.findFirstOrThrow({ where: { organizationId: orgA } });
  assert.equal(event.startsAt.toISOString(), zonedTime(date, "15:00", TZ)?.toISOString());
  assert.equal(event.endsAt.getTime() - event.startsAt.getTime(), 30 * 60_000);
  assert.equal(event.conversationId, done.conversation.id);

  // And the audit log has the call, readable by members.
  const [audit] = (await get(`/workspaces/${wsA}/tool-executions?conversationId=${done.conversation.id}`, memberOf(orgA))).json<
    ToolExecutionRecord[]
  >();
  assert.equal(audit?.id, reply.tools[0]?.executionId);
  assert.deepEqual([audit?.tool, audit?.status, audit?.attempts, audit?.employeeId], ["calendar_book_meeting", "SUCCEEDED", 1, ava]);
  assert.deepEqual(audit?.input, { title: "Meeting with customer", date, time: "15:00" });
  assert.equal((audit?.output as { status: string }).status, "booked");
});

test("invalid arguments are refused with the reason, and the model can correct them", async () => {
  const date = tomorrow();
  script = [
    () => ({ calls: [call("calendar_book_meeting", { title: "Demo", date, time: "4 PM" })] }),
    (req) => {
      const result = req.messages.at(-1);
      assert.ok(result?.role === "tool" && result.results[0]?.isError);
      assert.match(result.results[0]?.content ?? "", /Invalid input, nothing was done\. time: Use HH:MM/);
      return { calls: [call("calendar_book_meeting", { title: "Demo", date, time: "16:00" }, "call_2")] };
    },
    () => ({ text: "Booked for 4 PM." }),
  ];
  const done = await send(ava, "Can we do 4 PM tomorrow?");
  assert.deepEqual(
    done.messages[1].tools.map((t) => t.status),
    ["INVALID", "SUCCEEDED"],
  );
  assert.equal(await prisma.calendarEvent.count({ where: { organizationId: orgA } }), 2);
});

test("a taken slot is reported as a conflict, not booked twice", async () => {
  const outcome = await executor.execute(
    call("calendar_book_meeting", { title: "Again", date: tomorrow(), time: "15:15" }),
    scope(),
    signal(),
  );
  assert.equal(outcome.status, "SUCCEEDED");
  const body = JSON.parse(outcome.result.content) as { status: string; busy: { start: string }[] };
  assert.equal(body.status, "conflict");
  assert.equal(body.busy[0]?.start, `${tomorrow()} 15:00`);
  assert.equal(await prisma.calendarEvent.count({ where: { organizationId: orgA } }), 2);
});

test("permission: tools are only offered and only run when granted", async () => {
  // Bob has no tools: none are offered, and the prompt says he cannot act.
  script = [
    (req) => {
      assert.equal(req.tools, undefined);
      assert.match(req.system, /You have no tools/);
      // A model that asks anyway is ignored: calls for tools that were not offered never run.
      return { text: "I can't book meetings.", calls: [call("calendar_book_meeting", { title: "X", date: tomorrow(), time: "18:00" })] };
    },
  ];
  await send(bob, "Book me a meeting tomorrow at 6 PM.");
  assert.equal(await prisma.toolExecution.count({ where: { employeeId: bob } }), 0);

  // And the executor refuses on its own, whatever the runtime does.

  const denied = await executor.execute(call("calendar_book_meeting", { title: "X", date: tomorrow(), time: "18:00" }), scope(bob), signal());
  assert.equal(denied.status, "DENIED");
  assert.match(denied.result.content, /not permitted/);
  const unknown = await executor.execute(call("run_shell", { command: "rm -rf /" }), scope(), signal());
  assert.equal(unknown.status, "DENIED");

  // A grant made before the tool needed more permissions does not cover the new ones.
  await prisma.toolPermission.update({
    where: { employeeId_tool: { employeeId: ava, tool: "send_email" } },
    data: { permissions: [] },
  });
  const stale = await executor.execute(call("send_email", { to: "a@example.com", subject: "Hi", body: "Hi" }), scope(), signal());
  assert.equal(stale.status, "DENIED");
  await prisma.toolPermission.update({
    where: { employeeId_tool: { employeeId: ava, tool: "send_email" } },
    data: { permissions: ["email:send"] },
  });

  // Another organization's scope finds no grant.
  const otherOrg = await executor.execute(call("send_email", { to: "a@example.com", subject: "Hi", body: "Hi" }), { ...scope(), organizationId: orgB }, signal());
  assert.equal(otherOrg.status, "DENIED");
  assert.equal(await prisma.calendarEvent.count({ where: { employeeId: bob } }), 0);
});

test("email runs in test mode and is kept in the audit log", async () => {
  const outcome = await executor.execute(
    call("send_email", { to: "rahul@example.com", subject: "Your meeting", body: "See you tomorrow at 3 PM." }),
    scope(),
    signal(),
  );
  assert.equal(outcome.status, "SUCCEEDED");
  assert.deepEqual(JSON.parse(outcome.result.content), { status: "sent", messageId: outcome.executionId, testMode: true });
  const row = await prisma.toolExecution.findUniqueOrThrow({ where: { id: outcome.executionId } });
  assert.equal((row.input as { to: string }).to, "rahul@example.com");
});

test("http_request reaches approved hosts only, and retries GET but not POST", async () => {
  respond = () => Response.json({ plan: "enterprise" });
  const ok = await executor.execute(call("http_request", { method: "GET", url: "https://api.example.com/plans/1" }), scope(), signal());
  assert.equal(ok.status, "SUCCEEDED");
  assert.deepEqual(JSON.parse(ok.result.content), { status: 200, contentType: "application/json", body: '{"plan":"enterprise"}', truncated: false });

  for (const url of ["https://evil.example.org/x", "http://api.example.com/x", "https://api.example.com.evil.org/x"]) {
    const refused = await executor.execute(call("http_request", { method: "GET", url }), scope(), signal());
    assert.equal(refused.status, "FAILED", url);
  }
  assert.equal(fetched.length, 1, "refused hosts are never contacted");

  let tries = 0;
  respond = () => (++tries === 1 ? new Response("busy", { status: 503 }) : Response.json({ ok: true }));
  const retried = await executor.execute(call("http_request", { method: "GET", url: "https://api.example.com/x" }), scope(), signal());
  assert.equal(retried.status, "SUCCEEDED");
  assert.equal((await prisma.toolExecution.findUniqueOrThrow({ where: { id: retried.executionId } })).attempts, 2);

  tries = 0;
  const post = await executor.execute(
    call("http_request", { method: "POST", url: "https://api.example.com/leads", body: { name: "Rahul" } }),
    scope(),
    signal(),
  );
  assert.equal(post.status, "FAILED");
  assert.equal((await prisma.toolExecution.findUniqueOrThrow({ where: { id: post.executionId } })).attempts, 1);
});

test("send_webhook posts to the admin's URL with a stable idempotency key across retries", async () => {
  let tries = 0;
  respond = () => new Response(null, { status: ++tries === 1 ? 500 : 204 });
  // A url in the model's input is ignored: only the granted URL is used.
  const outcome = await executor.execute(
    call("send_webhook", { event: "lead.qualified", data: { budget: 50000 }, url: "https://attacker.example/x" }),
    scope(),
    signal(),
  );
  assert.equal(outcome.status, "SUCCEEDED");
  assert.deepEqual(
    fetched.map((f) => f.url),
    ["https://hooks.example.com/in", "https://hooks.example.com/in"],
  );
  const keys = fetched.map((f) => new Headers(f.init?.headers).get("idempotency-key"));
  assert.deepEqual(keys, [outcome.executionId, outcome.executionId]);
  const body = JSON.parse(String(fetched[0]?.init?.body)) as { event: string; data: unknown; employeeId: string };
  assert.deepEqual([body.event, body.data, body.employeeId], ["lead.qualified", { budget: 50000 }, ava]);
});

test("timeouts and unexpected failures end as FAILED with a safe message", async () => {
  const errors: unknown[] = [];
  const slow = defineTool({
    name: "send_email", // borrows a granted name and its permissions
    title: "Slow",
    description: "Never answers in time",
    input: z.object({}),
    output: z.object({}),
    config: z.object({}),
    permissions: ["email:send"],
    timeoutMs: 50,
    retry: { attempts: 3, backoffMs: 0 },
    execute: () => new Promise<never>(() => {}),
  });
  const broken = { ...slow, name: "calendar_book_meeting" as const, permissions: ["calendar:write"], execute: () => Promise.reject(new Error("db password in here")) };
  const test = createToolExecutor(createToolRegistry([slow, broken]), { fetch: fakeFetch, onError: (err) => errors.push(err) });

  const started = Date.now();
  const timedOut = await test.execute(call("send_email", {}), scope(), signal());
  assert.equal(timedOut.status, "FAILED");
  assert.match(timedOut.result.content, /timed out after 0\.05 seconds/);
  assert.ok(Date.now() - started < 2000);
  // Not retried: the first try may still have acted.
  assert.equal((await prisma.toolExecution.findUniqueOrThrow({ where: { id: timedOut.executionId } })).attempts, 1);

  const failed = await test.execute(call("calendar_book_meeting", {}), scope(), signal());
  assert.equal(failed.status, "FAILED");
  assert.doesNotMatch(failed.result.content, /password/);
  assert.equal(errors.length, 1);
});

test("the network guard refuses private and non-https addresses before connecting", async () => {
  for (const url of [
    "http://example.com",
    "https://127.0.0.1/",
    "https://localhost/",
    "https://[::1]/",
    "https://10.1.2.3/",
    "https://169.254.169.254/latest/meta-data",
    "https://user:pass@example.com/",
  ])
    await assert.rejects(safeFetch(url), ToolError, url);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("::ffff:192.168.1.1"), true);
});

test("local times convert in the employee's time zone, and impossible ones are rejected", () => {
  assert.equal(zonedTime("2026-11-18", "15:00", "Asia/Kolkata")?.toISOString(), "2026-11-18T09:30:00.000Z");
  assert.equal(zonedTime("2026-07-01", "09:00", "America/New_York")?.toISOString(), "2026-07-01T13:00:00.000Z");
  assert.equal(zonedTime("2026-03-08", "02:30", "America/New_York"), null); // skipped by daylight saving
  assert.equal(zonedTime("2026-02-30", "10:00", "UTC"), null);
});

test("grants: admins only, settings validated, other organizations see nothing", async () => {
  assert.equal((await grant(bob, [{ name: "send_email" }], memberOf(orgA))).statusCode, 403);
  const bad = await grant(bob, [
    { name: "http_request", config: { allowedHosts: ["127.0.0.1"] } },
    { name: "send_webhook", config: { url: "http://hooks.example.com" } },
  ]);
  assert.equal(bad.statusCode, 400);
  assert.match(bad.payload, /tools\.0\.config\.allowedHosts\.0/);
  assert.equal((await grant(bob, [{ name: "run_shell" }])).statusCode, 400);
  assert.equal((await grant(bob, [{ name: "send_email" }, { name: "send_email" }])).statusCode, 400);

  const tools = (await get(`/workspaces/${wsA}/employees/${ava}/tools`, memberOf(orgA))).json<{ name: string; permissions: string[] }[]>();
  assert.deepEqual(
    tools.map((t) => t.name),
    ["calendar_book_meeting", "send_email", "http_request", "send_webhook"],
  );
  assert.deepEqual(tools[0]?.permissions, ["calendar:write"]);

  assert.equal((await get(`/workspaces/${wsA}/employees/${ava}/tools`, memberOf(orgB))).statusCode, 404);
  assert.equal((await get(`/workspaces/${wsB}/employees/${ava}/tools`, memberOf(orgB))).statusCode, 404);
  assert.deepEqual((await get(`/workspaces/${wsB}/tool-executions`, memberOf(orgB))).json(), []);
  assert.equal((await get(`/workspaces/${wsA}/tool-executions`, memberOf(orgB))).statusCode, 404);
  assert.equal((await get(`/workspaces/${wsA}/tools`, memberOf(orgA))).json<unknown[]>().length, 4);
});
