// Needs the database from .env to be running (pnpm infra:up && pnpm db:migrate).
// Live notifications: what the dashboard's event stream is told about handoffs, customers writing while
// people have a conversation, and assignments; the unanswered-handoff reminder job; agent presence for the widget.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { AIProvider } from "@workforce/ai-provider";
import { EXTRACTION_PROMPT, memoryService } from "@workforce/memory";
import { defaultEmployeeConfig, type ChatStreamEvent, type EmployeeDetail, type LiveEvent, type Workspace } from "@workforce/shared";
import { buildApp } from "./app.ts";
import type { JobDefinitions, JobEvents, JobName } from "./jobs.ts";
import { agentPresence, liveBus } from "./live.ts";
import { adminOf, deleteOrgs, headerAuth, memberOf, newOrg } from "./testing.ts";

const org = newOrg();
const other = newOrg();
let app: Awaited<ReturnType<typeof buildApp>>;
let ws: string;
let ava: string;

const model: AIProvider = {
  name: "fake",
  model: "fake-1",
  async *stream(req) {
    yield { type: "text", text: req.system.startsWith(EXTRACTION_PROMPT) ? '{"memories":[]}' : "OK." };
    yield { type: "done", inputTokens: 1, outputTokens: 1 };
  },
};

const bus = liveBus();
let events: LiveEvent[] = [];
let definitions: JobDefinitions | undefined;
let queued: { name: JobName; data: unknown }[] = [];

const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: object, headers = adminOf(org)) => app.inject({ method, url, headers, payload });
const say = async (message: string, conversationId?: string) => {
  const res = await call("POST", `/workspaces/${ws}/employees/${ava}/messages`, { message, conversationId });
  assert.equal(res.statusCode, 200, res.payload);
  const frames = res.payload.split("\n\n").filter((f) => f.startsWith("data: "));
  return JSON.parse(frames.at(-1)!.slice(6)) as ChatStreamEvent;
};
const conv = (id: string) => `/workspaces/${ws}/conversations/${id}`;
const steps = { run: <T>(_id: string, fn: () => Promise<T>) => fn(), sleepUntil: async () => {} };

before(async () => {
  app = await buildApp({
    authenticate: headerAuth,
    provider: model,
    memory: () => memoryService(model, 5000),
    logger: false,
    live: bus,
    // Captures the job definitions and what was queued, instead of running anything.
    jobs: (defs) => {
      definitions = defs;
      return { backend: "inline", send: async (name, data) => void queued.push({ name, data }) };
    },
  });
  await app.ready();
  ws = (await call("GET", "/workspaces")).json<Workspace[]>()[0]?.id ?? "";
  bus.subscribe(ws, (e) => events.push(e));
  const config = defaultEmployeeConfig("UTC");
  const created = await call("POST", `/workspaces/${ws}/employees`, {
    ...config,
    name: "Ava",
    role: "Support agent",
    escalation: { ...config.escalation, enabled: true, contactEmail: "team@example.test", reminderMinutes: 5 },
  });
  assert.equal(created.statusCode, 201, created.payload);
  ava = created.json<EmployeeDetail>().id;
  assert.equal((await call("POST", `/workspaces/${ws}/employees/${ava}/publish`, { version: 1 })).statusCode, 200);
});
beforeEach(() => {
  events = [];
  queued = [];
});
after(async () => {
  await app.close();
  await deleteOrgs(org, other);
});

test("a handoff, customers writing while people have it, and assignments reach the live stream", async () => {
  const first = await say("Can I talk to a human please?");
  assert.ok(first.type === "done" && first.handoff);
  const id = first.conversation.id;
  assert.deepEqual(events[0], {
    type: "handoff",
    conversationId: id,
    employeeName: "Ava",
    reason: `Customer asked for a person. ${first.handoff.reason}`,
    reminder: false,
    waitingMinutes: 0,
  });

  // The reminder is queued for the employee's reminder time.
  const reminder = queued.find((q) => q.name === "handoff/reminder.due")?.data as JobEvents["handoff/reminder.due"] | undefined;
  assert.ok(reminder);
  assert.deepEqual([reminder.conversationId, reminder.minutes, reminder.handoffId], [id, 5, first.handoff.id]);
  const due = new Date(reminder.dueAt).getTime() - Date.now();
  assert.ok(due > 4 * 60_000 && due <= 5 * 60_000, `due in ${due} ms`);

  // Still in the queue: the reminder job re-alerts.
  events = [];
  await definitions!["handoff/reminder.due"].handler(reminder, steps);
  assert.deepEqual(
    events.map((e) => e.type === "handoff" && [e.reminder, e.waitingMinutes]),
    [[true, 5]],
  );

  // Waiting in the queue: a customer message is announced to everyone (no assignee).
  events = [];
  assert.equal((await say("Hello? Anyone there?", id)).type, "held");
  assert.deepEqual(events, [{ type: "customer_message", conversationId: id, assignedTo: null, preview: "Hello? Anyone there?" }]);

  // Taken over: counts change, and later messages name the assignee.
  events = [];
  assert.equal((await call("PATCH", conv(id), { action: "take_over" }, memberOf(org))).statusCode, 200);
  assert.deepEqual(events, [{ type: "inbox_changed" }]);
  events = [];
  await say("Thanks!", id);
  assert.deepEqual(events.map((e) => e.type === "customer_message" && e.assignedTo), ["user_member"]);

  // Once someone has taken it, the reminder stays quiet.
  events = [];
  await definitions!["handoff/reminder.due"].handler(reminder, steps);
  assert.deepEqual(events, []);

  // Assigning to someone else tells them; assigning to yourself does not.
  events = [];
  assert.equal((await call("PATCH", conv(id), { action: "assign", userId: "user_other" }, memberOf(org))).statusCode, 200);
  assert.deepEqual(events.at(-1), { type: "assigned", conversationId: id, assignedTo: "user_other", by: "user_member" });
  events = [];
  assert.equal((await call("PATCH", conv(id), { action: "assign", userId: "user_member" }, memberOf(org))).statusCode, 200);
  assert.deepEqual(events, [{ type: "inbox_changed" }]);
});

test("the event stream and typing are for members of the workspace only", async () => {
  assert.equal((await call("GET", `/workspaces/${ws}/events`, undefined, adminOf(other))).statusCode, 404);
  const first = await say("Can I talk to a human please?");
  assert.ok(first.type === "done");
  const typing = (headers = memberOf(org)) => call("POST", `${conv(first.conversation.id)}/typing`, { name: "Sam" }, headers);
  assert.equal((await typing()).statusCode, 204);
  assert.equal((await typing(adminOf(other))).statusCode, 404);
});

test("presence: a typing ping shows the name and typing for a few seconds; replies keep the name", () => {
  const presence = agentPresence();
  assert.equal(presence.of("c1"), null);
  presence.touch("c1", "Sam", true);
  assert.deepEqual(presence.of("c1"), { name: "Sam", typing: true });
  presence.touch("c1", "", false);
  assert.deepEqual(presence.of("c1"), { name: "Sam", typing: false });
  presence.forget("c1");
  assert.equal(presence.of("c1"), null);
});
