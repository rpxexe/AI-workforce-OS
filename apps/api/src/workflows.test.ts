// Needs the database from .env to be running (pnpm infra:up && pnpm db:migrate).
// The model, the phone line and the network are faked; the runner, the database and every
// node's real code are not. Runs execute in the background exactly as in production.
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, beforeEach, test } from "node:test";
import type { AIProvider } from "@workforce/ai-provider";
import { prisma } from "@workforce/database";
import {
  blankWorkflow,
  defaultEmployeeConfig,
  leadFollowUpWorkflow,
  validateWorkflow,
  type ApiError,
  type EmployeeDetail,
  type WorkflowDefinition,
  type WorkflowDependencies,
  type WorkflowDetail,
  type WorkflowExecutionDetail,
  type WorkflowExecutionSummary,
  type WorkflowSummary,
  type Workspace,
} from "@workforce/shared";
import type { STTProvider } from "@workforce/stt";
import type { TelephonyProvider } from "@workforce/telephony";
import { localTime } from "@workforce/tools";
import type { TTSProvider } from "@workforce/tts";
import { buildApp } from "./app.ts";
import { adminOf, deleteOrgs, headerAuth, memberOf, newOrg } from "./testing.ts";

const TZ = "Asia/Kolkata";
const orgA = newOrg();
const orgB = newOrg();
let app: Awaited<ReturnType<typeof buildApp>>;
let ws: string;
let wsB: string;
let ava: string; // published, has a phone number and the calendar tool

/** The model: yes/no questions get `answer`; everything else (employee turns, memory) gets "OK". */
let answer = "YES";
const questions: string[] = [];
const fake: AIProvider = {
  name: "fake",
  model: "fake-1",
  async *stream(request) {
    const question = request.system.startsWith("You decide one yes/no");
    if (question) questions.push(JSON.stringify(request.messages.at(-1)));
    yield { type: "text", text: question ? answer : "OK, noted." };
    yield { type: "done", inputTokens: 1, outputTokens: 1 };
  },
};

/** The phone line: places calls and nothing else. Tests end calls by writing what the call session would. */
const placed: { to: string; from: string }[] = [];
const telephony = {
  name: "fake",
  async placeCall({ to, from }: { to: string; from: string }) {
    placed.push({ to, from });
    return { providerCallId: `CA${randomInt(1e9)}` };
  },
} as unknown as TelephonyProvider;

/** The network HTTP Request and Webhook nodes reach. */
let respond: () => Response = () => Response.json({ ok: true });
const fetched: { url: string; init?: RequestInit }[] = [];
const fakeFetch: typeof fetch = async (url, init) => {
  fetched.push({ url: String(url), init });
  return respond();
};

type Headers = Record<string, string>;
const admin = adminOf(orgA);
const inject = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown, headers: Headers = admin) =>
  app.inject({ method, url, headers, ...(payload !== undefined && { payload: payload as object }) });

const createWorkflow = async (definition: WorkflowDefinition, name = "Flow") => {
  const res = await inject("POST", `/workspaces/${ws}/workflows`, { name, definition });
  assert.equal(res.statusCode, 201, res.payload);
  return res.json<WorkflowDetail>();
};
const publish = async (id: string, version = 1) => {
  const res = await inject("POST", `/workspaces/${ws}/workflows/${id}/publish`, { version });
  assert.equal(res.statusCode, 200, res.payload);
  return res.json<WorkflowDetail>();
};
const run = async (id: string, input: object = {}) => {
  const res = await inject("POST", `/workspaces/${ws}/workflows/${id}/executions`, { input });
  assert.equal(res.statusCode, 202, res.payload);
  return res.json<WorkflowExecutionSummary>();
};
const execution = async (id: string) =>
  (await inject("GET", `/workspaces/${ws}/workflow-executions/${id}`)).json<WorkflowExecutionDetail>();

/** Waits for the background runner to bring the run to one of `statuses`. */
const settle = async (id: string, statuses: string[] = ["COMPLETED", "FAILED"], at?: string) => {
  for (let i = 0; i < 200; i++) {
    const e = await execution(id);
    if (statuses.includes(e.status) && (at === undefined || e.currentNodeId === at)) return e;
    await sleep(25);
  }
  assert.fail(`run ${id} did not reach ${statuses.join("/")}: ${JSON.stringify(await execution(id))}`);
};

/** A straight line: trigger -> the given nodes -> end. */
const line = (...nodes: { id: string; type: string; config: Record<string, unknown> }[]): WorkflowDefinition => {
  const all = [{ id: "start", type: "trigger", config: { kind: "manual" } }, ...nodes, { id: "done", type: "end", config: {} }];
  return {
    nodes: all.map((n, i) => ({ ...n, type: n.type as WorkflowDefinition["nodes"][number]["type"], name: n.id, position: { x: 0, y: i * 100 } })),
    edges: all.slice(1).map((n, i) => ({ id: `e${i}`, source: all[i]?.id ?? "", target: n.id })),
  };
};

/** What the call session and the status webhook write when a call ends. */
const endCall = async (callId: string, lines: [string, string][]) =>
  prisma.call.update({
    where: { id: callId },
    data: {
      status: "COMPLETED",
      endedAt: new Date(),
      durationSec: 42,
      transcript: {
        create: lines.map(([speaker, text], i) => ({ speaker: speaker === "c" ? "CUSTOMER" : "EMPLOYEE", text, offsetMs: i * 1000 })),
      },
    },
  });

const tomorrow = () => localTime(new Date(Date.now() + 24 * 3600_000), TZ).slice(0, 10);

before(async () => {
  app = await buildApp({
    authenticate: headerAuth,
    provider: fake,
    toolFetch: fakeFetch,
    logger: false,
    voice: {
      telephony: [telephony],
      stt: {} as STTProvider,
      tts: {} as TTSProvider,
      publicUrl: "https://voice.example.com",
      secret: "test-secret",
      limits: { idleMs: 60_000, maxCallMs: 600_000 },
    },
    workflows: { intervalMs: 20, callPollMs: 50 },
  });
  const workspaceOf = async (org: string) => (await inject("GET", "/workspaces", undefined, adminOf(org))).json<Workspace[]>()[0]?.id ?? "";
  ws = await workspaceOf(orgA);
  wsB = await workspaceOf(orgB);
  const res = await inject("POST", `/workspaces/${ws}/employees`, { ...defaultEmployeeConfig(TZ), name: "Ava", role: "Sales assistant" });
  ava = res.json<EmployeeDetail>().id;
  assert.equal((await inject("POST", `/workspaces/${ws}/employees/${ava}/publish`, { version: 1 })).statusCode, 200);
  const grant = await inject("PUT", `/workspaces/${ws}/employees/${ava}/tools`, { tools: [{ name: "calendar_book_meeting" }] });
  assert.equal(grant.statusCode, 200, grant.payload);
  await prisma.phoneNumber.create({
    data: {
      organizationId: orgA,
      workspaceId: ws,
      employeeId: ava,
      number: `+1555${randomInt(1e6, 1e7)}`,
      provider: "fake",
      providerNumberId: "PN1",
      greeting: "Hi",
      createdBy: "user_admin",
    },
  });
});
beforeEach(() => {
  answer = "YES";
  questions.length = 0;
  placed.length = 0;
  fetched.length = 0;
  respond = () => Response.json({ ok: true });
});
after(async () => {
  await deleteOrgs(orgA, orgB);
  await app.close();
});

test("the example: new lead -> AI call -> interested? -> calendar -> confirmation -> end", async () => {
  const created = await createWorkflow(leadFollowUpWorkflow(ava), "New lead follow-up");
  assert.deepEqual(created.issues, []);
  await publish(created.id);
  assert.ok(created.hookUrl?.includes(`/hooks/workflows/${created.id}/`));

  // A lead form posts to the webhook trigger.
  const date = tomorrow();
  const lead = { name: "Rahul", phone: "+14155550123", email: "rahul@example.com", preferredDate: date, preferredTime: "15:00" };
  const hook = await app.inject({ method: "POST", url: new URL(created.hookUrl ?? "").pathname, payload: lead });
  assert.equal(hook.statusCode, 202, hook.payload);
  const { executionId } = hook.json<{ executionId: string }>();

  // The employee calls the lead; the run waits for the call to end.
  const calling = await settle(executionId, ["WAITING"], "ai_call");
  assert.equal(placed[0]?.to, "+14155550123");
  const call = await prisma.call.findFirstOrThrow({ where: { organizationId: orgA, to: "+14155550123" }, orderBy: { createdAt: "desc" } });
  assert.equal(call.greeting, "Hi Rahul, this is Ava. You asked us about a demo. Is now a good time?");
  assert.equal(call.createdBy, null);
  assert.equal(calling.steps.find((s) => s.nodeId === "ai_call")?.status, "WAITING");
  await endCall(call.id, [
    ["e", "Hi Rahul, this is Ava. Is now a good time?"],
    ["c", "Yes, I'd love a demo tomorrow at 3."],
  ]);

  const done = await settle(executionId);
  assert.equal(done.status, "COMPLETED", done.error ?? "");
  assert.deepEqual(
    done.steps.map((s) => [s.nodeId, s.status]),
    ["new_lead", "ai_call", "interested", "calendar", "confirmation", "end"].map((id) => [id, "SUCCEEDED"]),
  );
  // The model judged interest from the transcript.
  assert.match(questions[0] ?? "", /did the customer say they are interested/);
  assert.match(questions[0] ?? "", /I'd love a demo tomorrow at 3/);
  // The meeting is in the calendar at the time the lead asked for, in the employee's time zone.
  const event = await prisma.calendarEvent.findFirstOrThrow({ where: { workspaceId: ws, attendeeEmail: "rahul@example.com" } });
  assert.equal(localTime(event.startsAt, TZ), `${date} 15:00`);
  assert.equal(event.title, "Demo with Rahul");
  // Through the tool system: audited like any tool call.
  const audit = await prisma.toolExecution.findFirstOrThrow({ where: { conversationId: executionId } });
  assert.equal(audit.status, "SUCCEEDED");
  // The confirmation used the calendar step's output.
  const confirmation = done.steps.find((s) => s.nodeId === "confirmation")?.output as { to: string; body: string };
  assert.equal(confirmation.to, "rahul@example.com");
  assert.match(confirmation.body, new RegExp(`booked for ${date} 15:00 \\(${TZ}\\)`));
});

test("the example takes the no path when the lead is not interested", async () => {
  answer = "NO, they declined.";
  const { id } = await createWorkflow(leadFollowUpWorkflow(ava));
  await publish(id);
  const started = await run(id, { name: "Priya", phone: "+14155550199", email: "priya@example.com" });
  await settle(started.id, ["WAITING"], "ai_call");
  const call = await prisma.call.findFirstOrThrow({ where: { organizationId: orgA, to: "+14155550199" } });
  await endCall(call.id, [["c", "No thanks, not interested."]]);
  const done = await settle(started.id);
  assert.equal(done.status, "COMPLETED");
  assert.deepEqual(done.steps.map((s) => s.nodeId), ["new_lead", "ai_call", "interested", "not_interested"]);
  assert.equal(await prisma.calendarEvent.count({ where: { attendeeEmail: "priya@example.com" } }), 0);
});

test("validation: what blocks publishing, shown per node", () => {
  const base = leadFollowUpWorkflow(ava);
  const issues = (d: WorkflowDefinition) => validateWorkflow(d).map((i) => i.message);
  assert.deepEqual(issues(base), []);
  // Condition without its "no" path, and the node behind it now unreachable.
  const noPath = { ...base, edges: base.edges.filter((e) => e.branch !== "no") };
  assert.ok(issues(noPath).includes('Interested?: connect the "no" path'));
  assert.ok(issues(noPath).includes("Not interested: not reachable from the trigger"));
  // A loop.
  const loop = { ...base, edges: [...base.edges.filter((e) => e.id !== "e6"), { id: "back", source: "confirmation", target: "ai_call" }] };
  assert.ok(issues(loop).includes("The workflow loops back on itself; loops are not supported"));
  // Settings incomplete, two triggers.
  const broken = {
    ...base,
    nodes: [
      ...base.nodes.map((n) => (n.id === "ai_call" ? { ...n, config: { ...n.config, employeeId: "" } } : n)),
      { id: "second", type: "trigger" as const, name: "Second", position: { x: 0, y: 0 }, config: {} },
    ],
  };
  assert.ok(issues(broken).includes("AI Call: Choose an employee"));
  assert.ok(issues(broken).includes("A workflow needs exactly one trigger"));
  assert.ok(issues(blankWorkflow()).length === 0);
});

test("publishing refuses invalid versions and unknown employees or tools; validate shows the same", async () => {
  const unknown = leadFollowUpWorkflow("no-such-employee");
  const { id, issues } = await createWorkflow(unknown);
  assert.ok(issues.some((i) => i.nodeId === "ai_call" && /does not exist/.test(i.message)));
  const res = await inject("POST", `/workspaces/${ws}/workflows/${id}/publish`, { version: 1 });
  assert.equal(res.statusCode, 400);
  assert.ok(res.json<ApiError>().issues?.some((i) => i.path === "calendar"));
  // A tool the employee was not granted.
  const ungranted = line({ id: "mail", type: "tool", config: { employeeId: ava, tool: "send_email", input: {} } });
  const checked = await inject("POST", `/workspaces/${ws}/workflows/validate`, { definition: ungranted }, memberOf(orgA));
  assert.deepEqual(checked.json(), { issues: [{ nodeId: "mail", message: "mail: grant send_email to this employee first" }] });
  // Unpublished workflows do not run.
  assert.equal((await inject("POST", `/workspaces/${ws}/workflows/${id}/executions`, {})).statusCode, 409);
});

test("versions: saving appends, runs use the published version until another is published", async () => {
  const v1 = line({ id: "check", type: "condition", config: { mode: "compare", left: "{{trigger.plan}}", operator: "equals", right: "enterprise" } });
  // Close the condition's paths: yes -> done, no -> done.
  v1.edges = [
    { id: "a", source: "start", target: "check" },
    { id: "b", source: "check", target: "done", branch: "yes" },
    { id: "c", source: "check", target: "done", branch: "no" },
  ];
  const { id } = await createWorkflow(v1);
  await publish(id);
  const v2 = line({ id: "pause_a_bit", type: "wait", config: { amount: 1, unit: "seconds" } });
  const saved = await inject("PUT", `/workspaces/${ws}/workflows/${id}`, { name: "Renamed", definition: v2 });
  assert.equal(saved.statusCode, 200, saved.payload);
  const detail = saved.json<WorkflowDetail>();
  assert.deepEqual([detail.latestVersion, detail.publishedVersion, detail.name], [2, 1, "Renamed"]);
  assert.equal((await inject("GET", `/workspaces/${ws}/workflows/${id}?version=1`)).json<WorkflowDetail>().definition.nodes[1]?.id, "check");

  const first = await settle((await run(id, { plan: "Enterprise" })).id);
  assert.deepEqual([first.version, first.steps[1]?.output], [1, { result: true }]);

  await publish(id, 2);
  // Wait: holds the run for its time, then continues.
  const second = await run(id);
  const waiting = await settle(second.id, ["WAITING"], "pause_a_bit");
  assert.ok(waiting.runAt && new Date(waiting.runAt).getTime() > Date.now());
  const done = await settle(second.id);
  assert.deepEqual([done.version, done.status], [2, "COMPLETED"]);
});

test("a failed step fails the run; retry runs it again from that step", async () => {
  const { id } = await createWorkflow(
    line(
      { id: "crm", type: "crm_update", config: { customer: "{{trigger.email}}", fields: [{ key: "Name", value: "{{trigger.name}}" }, { key: "stage", value: "qualified" }] } },
      { id: "notify", type: "http_request", config: { method: "POST", url: "https://api.example.com/leads", body: '{"stage":"{{steps.crm.updated.stage}}"}' } },
    ),
  );
  await publish(id);
  respond = () => new Response("down", { status: 503 });
  const failed = await settle((await run(id, { email: "mia@example.com", name: "Mia" })).id);
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.error, "notify: The server answered 503");
  assert.equal(fetched[0]?.init?.body, '{"stage":"qualified"}');
  // The CRM update happened once and stays.
  const customer = await prisma.customer.findFirstOrThrow({ where: { workspaceId: ws, externalId: "mia@example.com" }, include: { profile: true, memories: true } });
  assert.equal(customer.profile?.name, "Mia");
  assert.ok(customer.memories.some((m) => m.key === "stage" && m.value === "qualified" && m.category === "lead"));

  respond = () => Response.json({ received: true });
  const retried = await inject("POST", `/workspaces/${ws}/workflow-executions/${failed.id}/retry`);
  assert.equal(retried.statusCode, 200, retried.payload);
  const done = await settle(failed.id);
  assert.equal(done.status, "COMPLETED");
  assert.deepEqual(
    done.steps.map((s) => [s.nodeId, s.attempt, s.status]),
    [["start", 1, "SUCCEEDED"], ["crm", 1, "SUCCEEDED"], ["notify", 1, "FAILED"], ["notify", 2, "SUCCEEDED"], ["done", 1, "SUCCEEDED"]],
  );
  assert.deepEqual(done.steps[3]?.output, { status: 200, body: { received: true } });
  // Only failed runs can be retried.
  assert.equal((await inject("POST", `/workspaces/${ws}/workflow-executions/${failed.id}/retry`)).statusCode, 409);
});

test("pause holds runs and refuses new ones; resume releases them", async () => {
  const { id } = await createWorkflow(line({ id: "hold", type: "wait", config: { amount: 1, unit: "seconds" } }));
  await publish(id);
  const started = await run(id);
  await settle(started.id, ["WAITING"], "hold");
  assert.equal((await inject("PATCH", `/workspaces/${ws}/workflows/${id}/status`, { status: "PAUSED" })).statusCode, 200);
  assert.equal((await inject("POST", `/workspaces/${ws}/workflows/${id}/executions`, {})).statusCode, 409);
  await sleep(1300);
  // Its time has come, but the workflow is paused: it stays where it was.
  assert.equal((await execution(started.id)).status, "WAITING");
  await inject("PATCH", `/workspaces/${ws}/workflows/${id}/status`, { status: "ACTIVE" });
  assert.equal((await settle(started.id)).status, "COMPLETED");
});

test("an AI employee step and a human handoff that waits for a person", async () => {
  const { id } = await createWorkflow(
    line(
      { id: "ask", type: "ai_employee", config: { employeeId: ava, message: "Summarise the lead {{trigger.name}}", customer: "{{trigger.email}}" } },
      { id: "review", type: "human_handoff", config: { note: "Check {{trigger.name}}: {{steps.ask.reply}}" } },
    ),
  );
  await publish(id);
  const started = await run(id, { name: "Leo", email: "leo@example.com" });
  const waiting = await settle(started.id, ["WAITING"], "review");
  assert.equal(waiting.runAt, null);
  const reply = waiting.steps.find((s) => s.nodeId === "ask")?.output as { reply: string; conversationId: string };
  assert.equal(reply.reply, "OK, noted.");
  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: reply.conversationId }, include: { customer: { include: { customer: true } } } });
  assert.deepEqual([conversation.channel, conversation.customer?.customer.externalId], ["workflow", "leo@example.com"]);
  assert.deepEqual(waiting.steps.find((s) => s.nodeId === "review")?.input, { note: "Check Leo: OK, noted." });

  assert.equal((await inject("POST", `/workspaces/${ws}/workflow-executions/${started.id}/resume`, undefined, memberOf(orgA))).statusCode, 403);
  assert.equal((await inject("POST", `/workspaces/${ws}/workflow-executions/${started.id}/resume`)).statusCode, 200);
  const done = await settle(started.id);
  assert.equal(done.status, "COMPLETED");
  assert.equal((done.steps.find((s) => s.nodeId === "review")?.output as { resumedBy: string }).resumedBy, "user_admin");
});

test("roles, isolation and the webhook token", async () => {
  const { id, hookUrl } = await createWorkflow(blankWorkflow());
  // Members read, admins write; members do not see the webhook secret.
  assert.equal((await inject("POST", `/workspaces/${ws}/workflows`, { name: "x" }, memberOf(orgA))).statusCode, 403);
  assert.equal((await inject("GET", `/workspaces/${ws}/workflows/${id}`, undefined, memberOf(orgA))).json<WorkflowDetail>().hookUrl, null);
  assert.equal((await inject("POST", `/workspaces/${ws}/workflows/${id}/executions`, {}, memberOf(orgA))).statusCode, 403);
  // Another organization sees nothing.
  assert.equal((await inject("GET", `/workspaces/${ws}/workflows/${id}`, undefined, adminOf(orgB))).statusCode, 404);
  assert.equal((await inject("GET", `/workspaces/${wsB}/workflows/${id}`, undefined, adminOf(orgB))).statusCode, 404);
  assert.deepEqual((await inject("GET", `/workspaces/${wsB}/workflows`, undefined, adminOf(orgB))).json(), []);
  // A wrong token is a 404; a manual-trigger workflow cannot be started by webhook.
  const path = new URL(hookUrl ?? "").pathname;
  assert.equal((await app.inject({ method: "POST", url: `${path}x`, payload: {} })).statusCode, 404);
  await publish(id);
  assert.equal((await app.inject({ method: "POST", url: path, payload: {} })).statusCode, 409);
});

test("validation: references to other steps, and yes/no paths only out of conditions", () => {
  const issues = (d: WorkflowDefinition) => validateWorkflow(d).map((i) => i.message);
  const refs = line({
    id: "note",
    type: "message",
    config: { channel: "email", to: "{{steps.nope.email}}", subject: "{{steps.note.subject}}", body: "{{ lead.name }} {{trigger.name}}" },
  });
  assert.deepEqual(issues(refs), [
    'note: {{steps.nope.email}} refers to a step "nope" that does not exist',
    "note: {{steps.note.subject}} refers to this step itself",
    "note: {{ lead.name }} is not a valid reference; use {{trigger.field}} or {{steps.<step id>.field}}",
  ]);
  // The confirmation reached from the "no" path too: the booking does not always run before it.
  const base = leadFollowUpWorkflow(ava);
  const merged = { ...base, edges: base.edges.map((e) => (e.branch === "no" ? { ...e, target: "confirmation" } : e)) };
  assert.ok(issues(merged).includes('Send Confirmation: {{steps.calendar.start}} uses "Calendar Tool", which does not always run before this step'));
  const branched = line({ id: "x", type: "wait", config: { amount: 1, unit: "seconds" } });
  branched.edges[0] = { ...branched.edges[0]!, branch: "yes" };
  assert.ok(issues(branched).includes('start: only a condition has "yes" and "no" paths'));
});

test("delete checks what depends on the workflow and asks before stopping runs; restore; duplicate", async () => {
  const { id } = await createWorkflow(line({ id: "ask", type: "human_handoff", config: { note: "Check the lead" } }), "Handoff flow");
  await publish(id);
  const started = await run(id);
  await settle(started.id, ["WAITING"], "ask");

  const deps = await inject("GET", `/workspaces/${ws}/workflows/${id}/dependencies`);
  assert.deepEqual(deps.json<WorkflowDependencies>(), { activeRuns: 1, webhookTrigger: false });
  assert.equal((await inject("DELETE", `/workspaces/${ws}/workflows/${id}`, undefined, memberOf(orgA))).statusCode, 403);
  const refused = await inject("DELETE", `/workspaces/${ws}/workflows/${id}`);
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json<ApiError>().error, "1 run is still in progress. Deleting the workflow stops them.");
  assert.equal((await inject("DELETE", `/workspaces/${ws}/workflows/${id}?stopRuns=true`)).statusCode, 204);

  const stopped = await execution(started.id);
  assert.deepEqual([stopped.status, stopped.error], ["FAILED", "Stopped: the workflow was deleted"]);
  assert.equal((await inject("GET", `/workspaces/${ws}/workflows/${id}`)).statusCode, 404);
  assert.ok(!(await inject("GET", `/workspaces/${ws}/workflows`)).json<WorkflowSummary[]>().some((w) => w.id === id));
  const deleted = (await inject("GET", `/workspaces/${ws}/workflows?deleted=true`)).json<WorkflowSummary[]>().find((w) => w.id === id);
  assert.ok(deleted?.deletedAt);
  assert.equal((await inject("POST", `/workspaces/${ws}/workflows/${id}/executions`, { input: {} })).statusCode, 404);
  assert.equal((await inject("POST", `/workspaces/${ws}/workflow-executions/${started.id}/retry`)).statusCode, 409);

  // Restored paused; once resumed, the stopped run can be retried and finishes.
  const restored = await inject("POST", `/workspaces/${ws}/workflows/${id}/restore`);
  assert.equal(restored.json<WorkflowDetail>().status, "PAUSED");
  assert.equal((await inject("PATCH", `/workspaces/${ws}/workflows/${id}/status`, { status: "ACTIVE" })).statusCode, 200);
  assert.equal((await inject("POST", `/workspaces/${ws}/workflow-executions/${started.id}/retry`)).statusCode, 200);
  await settle(started.id, ["WAITING"], "ask");
  assert.equal((await inject("POST", `/workspaces/${ws}/workflow-executions/${started.id}/resume`)).statusCode, 200);
  assert.equal((await settle(started.id)).status, "COMPLETED");

  // Duplicate: a new draft from the chosen version, with its own hook URL.
  const original = (await inject("GET", `/workspaces/${ws}/workflows/${id}`)).json<WorkflowDetail>();
  const copyRes = await inject("POST", `/workspaces/${ws}/workflows/${id}/duplicate`, { version: 1 });
  assert.equal(copyRes.statusCode, 201, copyRes.payload);
  const copy = copyRes.json<WorkflowDetail>();
  assert.deepEqual([copy.name, copy.status, copy.latestVersion, copy.publishedVersion], ["Copy of Handoff flow", "DRAFT", 1, null]);
  assert.deepEqual(copy.definition, original.definition);
  assert.notEqual(copy.hookUrl, original.hookUrl);

  // A published webhook trigger is a dependency; once deleted its hook URL is gone.
  const hooked = line();
  hooked.nodes[0]!.config = { kind: "webhook" };
  const webhookFlow = await createWorkflow(hooked);
  await publish(webhookFlow.id);
  const hookDeps = await inject("GET", `/workspaces/${ws}/workflows/${webhookFlow.id}/dependencies`);
  assert.deepEqual(hookDeps.json<WorkflowDependencies>(), { activeRuns: 0, webhookTrigger: true });
  assert.equal((await inject("DELETE", `/workspaces/${ws}/workflows/${webhookFlow.id}`)).statusCode, 204);
  const hook = await app.inject({ method: "POST", url: new URL(webhookFlow.hookUrl ?? "").pathname, payload: {} });
  assert.equal(hook.statusCode, 404);
});

/** A run whose runner died in the middle of `nodeId`: RUNNING, lock expired, step attempt 1 RUNNING. */
const crashedAt = async (workflowId: string, nodeId: string, nodeType: string) => {
  const workflow = await prisma.workflow.findUniqueOrThrow({ where: { id: workflowId } });
  const execution = await prisma.workflowExecution.create({
    data: {
      organizationId: orgA,
      workspaceId: ws,
      workflowId,
      versionId: workflow.publishedVersionId ?? "",
      input: { email: "lee@example.com", name: "Lee", phone: "+14155550177" },
      status: "RUNNING",
      currentNodeId: nodeId,
      lockedUntil: new Date(Date.now() - 1000),
      startedBy: "user_admin",
      steps: { create: { nodeId, nodeType, attempt: 1, status: "RUNNING" } },
    },
  });
  return { executionId: execution.id, key: `${execution.id}:${nodeId}:1` };
};

test("idempotency: a step run again after its runner died does not repeat its effect", async () => {
  // Tool: the booking was made and audited before the crash; the re-run reuses it, no second booking.
  const book = await createWorkflow(
    line({
      id: "book",
      type: "tool",
      config: { employeeId: ava, tool: "calendar_book_meeting", input: { title: "Demo", date: tomorrow(), time: "11:00", attendeeEmail: "lee@example.com" } },
    }),
  );
  await publish(book.id);
  const tool = await crashedAt(book.id, "book", "tool");
  await prisma.toolExecution.create({
    data: {
      id: `wf:${tool.key}`,
      organizationId: orgA,
      workspaceId: ws,
      employeeId: ava,
      conversationId: tool.executionId,
      tool: "calendar_book_meeting",
      status: "SUCCEEDED",
      input: {},
      output: { status: "booked", eventId: "evt_1" },
      attempts: 1,
      durationMs: 5,
    },
  });
  const booked = await settle(tool.executionId);
  assert.equal(booked.status, "COMPLETED", booked.error ?? "");
  assert.deepEqual(booked.steps.find((s) => s.nodeId === "book")?.output, { status: "booked", eventId: "evt_1" });
  assert.equal(await prisma.calendarEvent.count({ where: { workspaceId: ws, attendeeEmail: "lee@example.com" } }), 0);

  // HTTP Request: sent again with the same idempotency key, so the server can drop the repeat.
  const notify = await createWorkflow(line({ id: "notify", type: "http_request", config: { method: "POST", url: "https://api.example.com/x", body: "{}" } }));
  await publish(notify.id);
  const http = await crashedAt(notify.id, "notify", "http_request");
  assert.equal((await settle(http.executionId)).status, "COMPLETED");
  assert.equal(new Headers(fetched[0]?.init?.headers).get("idempotency-key"), http.key);

  // Voice Call: the call was placed before the crash; the re-run follows it instead of dialing again.
  const calls = await createWorkflow(line({ id: "dial", type: "voice_call", config: { employeeId: ava, to: "{{trigger.phone}}", greeting: "" } }));
  await publish(calls.id);
  const voice = await crashedAt(calls.id, "dial", "voice_call");
  const call = await prisma.call.create({
    data: {
      organizationId: orgA,
      workspaceId: ws,
      employeeId: ava,
      employeeVersion: 1,
      direction: "OUTBOUND",
      status: "IN_PROGRESS",
      from: "+15550000000",
      to: "+14155550177",
      greeting: "Hi",
      providerCallId: `CA${randomInt(1e9)}`,
      idempotencyKey: voice.key,
    },
  });
  await settle(voice.executionId, ["WAITING"], "dial");
  assert.equal(placed.length, 0);
  await endCall(call.id, [["c", "Hello"]]);
  const called = await settle(voice.executionId);
  assert.equal((called.steps.find((s) => s.nodeId === "dial")?.output as { callId: string }).callId, call.id);

  // AI Employee: a turn cannot be deduplicated, so an interrupted one fails for a person to check.
  const turn = await createWorkflow(line({ id: "reply", type: "ai_employee", config: { employeeId: ava, message: "Hello", customer: "" } }));
  await publish(turn.id);
  const ai = await crashedAt(turn.id, "reply", "ai_employee");
  const failed = await settle(ai.executionId);
  assert.equal(failed.status, "FAILED");
  assert.match(failed.error ?? "", /interrupted while the employee was answering/);
});
