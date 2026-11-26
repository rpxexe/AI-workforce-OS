// Needs the database from .env to be running (pnpm infra:up && pnpm db:migrate).
// The queued (Inngest) path of every background job, without Inngest: the app is built with a fake
// queue that records events, and each Inngest function's handler is run as Inngest would run it,
// with step tools that record sleeps. The in-process path is what every other test file uses.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import { EMBEDDING_DIMENSIONS, type AIProvider, type EmbeddingProvider } from "@workforce/ai-provider";
import { metaSignature, metaWhatsApp } from "@workforce/channels";
import { prisma } from "@workforce/database";
import { EXTRACTION_PROMPT } from "@workforce/memory";
import {
  defaultEmployeeConfig,
  type EmployeeDetail,
  type KnowledgeSource,
  type WorkflowDefinition,
  type WorkflowDetail,
  type WorkflowExecutionSummary,
  type Workspace,
} from "@workforce/shared";
import { buildApp } from "./app.ts";
import { quietInsights } from "./inbox.ts";
import type { JobDefinitions, JobEvents, JobName, Schedule, Steps } from "./jobs.ts";
import { adminOf, deleteOrgs, headerAuth, newOrg } from "./testing.ts";

const org = newOrg();
const PNID = `9${Date.now()}`;
const SECRET = "meta-secret";
const QUESTION = "My name is Priya and my budget is 9000.";
let app: Awaited<ReturnType<typeof buildApp>>;
let ws: string;
let ava: string;

const model: AIProvider = {
  name: "fake",
  model: "fake-1",
  async *stream(req) {
    yield {
      type: "text",
      text: req.system.startsWith(EXTRACTION_PROMPT)
        ? JSON.stringify({ memories: [{ category: "identity", key: "name", value: "Priya" }], summary: "Priya shared her budget." })
        : "Noted.",
    };
    yield { type: "done", inputTokens: 1, outputTokens: 1 };
  },
};
const embedder: EmbeddingProvider = {
  name: "fake",
  model: "fake-embed-1",
  embed: async (texts) => texts.map(() => new Array<number>(EMBEDDING_DIMENSIONS).fill(0.01)),
};
let waSent = 0;
const whatsapp = metaWhatsApp({
  accessToken: "t",
  appSecret: SECRET,
  verifyToken: "v",
  graphUrl: "https://graph.test",
  fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { status?: string };
    if (body.status !== "read") waSent++;
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out-${Date.now()}-${waSent}` }], success: true }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch,
});

// The fake queue: what was sent, and the job definitions Inngest would serve.
let sent: { name: JobName; data: unknown }[] = [];
let definitions: JobDefinitions;
let schedules: Schedule[];
const jobsOf = <K extends JobName>(name: K) => sent.filter((s) => s.name === name).map((s) => s.data as JobEvents[K]);
/** Runs a job's handler like Inngest: step results pass through JSON, and sleeps are recorded (and waited, briefly). */
const runJob = async <K extends JobName>(name: K, data: JobEvents[K]) => {
  const slept: string[] = [];
  const steps: Steps = {
    run: async (_id, fn) => JSON.parse(JSON.stringify((await fn()) ?? null)),
    sleepUntil: async (_id, at) => {
      slept.push(String(at));
      await sleep(Math.max(0, new Date(at).getTime() - Date.now()));
    },
  };
  await (definitions[name].handler as (d: JobEvents[K], s: Steps) => Promise<unknown>)(data, steps);
  return slept;
};

const call = (method: "GET" | "POST" | "PUT", url: string, payload?: object) => app.inject({ method, url, headers: adminOf(org), payload });

before(async () => {
  app = await buildApp({
    authenticate: headerAuth,
    provider: model,
    embedder,
    logger: false,
    whatsapp: [whatsapp],
    jobs: (d, s) => {
      definitions = d;
      schedules = s;
      return {
        backend: "inngest",
        async send(name, data) {
          sent.push({ name, data });
        },
      };
    },
  });
  await app.ready();
  ws = (await call("GET", "/workspaces")).json<Workspace[]>()[0]?.id ?? "";
  ava = (await call("POST", `/workspaces/${ws}/employees`, { ...defaultEmployeeConfig("UTC"), name: "Ava", role: "Sales" })).json<EmployeeDetail>().id;
  assert.equal((await call("POST", `/workspaces/${ws}/employees/${ava}/publish`, { version: 1 })).statusCode, 200);
});
after(async () => {
  await app.close();
  await deleteOrgs(org);
});

test("the queue serves one function per job, the workflow sweep, the evaluation and insights sweeps, the improvement analysis and the usage meter", () => {
  assert.deepEqual(Object.keys(definitions).sort(), [
    "channel/message.received",
    "evaluation/dataset.run",
    "evaluation/requested",
    "handoff/reminder.due",
    "improvement/analyze",
    "insights/analyze",
    "knowledge/document.uploaded",
    "memory/exchange.saved",
    "workflow/run.due",
  ]);
  assert.equal(definitions["channel/message.received"].orderedBy, "queueKey");
  assert.deepEqual(schedules.map((s) => [s.id, s.cron]), [
    ["workflow-sweep", "* * * * *"],
    ["evaluation-sweep", "*/5 * * * *"],
    ["insights-sweep", "*/5 * * * *"],
    ["improvement-analysis", "0 6 * * *"],
    ["usage-meter", "*/5 * * * *"],
    ["webhook-sweep", "* * * * *"],
  ]);
});

test("workflows: a run becomes a job, sleeps through its wait in the queue, and a duplicate job does nothing", async () => {
  const definition: WorkflowDefinition = {
    nodes: [
      { id: "start", type: "trigger", name: "Start", position: { x: 0, y: 0 }, config: { kind: "manual" } },
      { id: "hold", type: "wait", name: "Hold", position: { x: 0, y: 100 }, config: { amount: 1, unit: "seconds" } },
      { id: "done", type: "end", name: "Done", position: { x: 0, y: 200 }, config: {} },
    ],
    edges: [
      { id: "e1", source: "start", target: "hold" },
      { id: "e2", source: "hold", target: "done" },
    ],
  };
  const created = await call("POST", `/workspaces/${ws}/workflows`, { name: "Queued", definition });
  assert.equal(created.statusCode, 201, created.payload);
  const workflow = created.json<WorkflowDetail>();
  assert.equal((await call("POST", `/workspaces/${ws}/workflows/${workflow.id}/publish`, { version: 1 })).statusCode, 200);
  sent = [];
  const started = await call("POST", `/workspaces/${ws}/workflows/${workflow.id}/executions`, { input: {} });
  assert.equal(started.statusCode, 202, started.payload);
  const { id } = started.json<WorkflowExecutionSummary>();
  assert.deepEqual(jobsOf("workflow/run.due"), [{ executionId: id }]);

  // No runner in this process: nothing happens until the job runs.
  await sleep(300);
  assert.equal((await prisma.workflowExecution.findUniqueOrThrow({ where: { id } })).status, "QUEUED");

  // The sweep finds it too (a lost event would be recovered this way).
  sent = [];
  await schedules[0]?.handler({ run: (_id, fn) => fn(), sleepUntil: async () => {} });
  assert.ok(jobsOf("workflow/run.due").some((d) => d.executionId === id));

  const slept = await runJob("workflow/run.due", { executionId: id });
  assert.equal(slept.length, 1, "one sleep, for the Wait step");
  const done = await prisma.workflowExecution.findUniqueOrThrow({ where: { id }, include: { steps: true } });
  assert.equal(done.status, "COMPLETED");
  assert.equal(done.steps.length, 3);

  assert.deepEqual(await runJob("workflow/run.due", { executionId: id }), []);
  assert.equal((await prisma.workflowStepExecution.count({ where: { executionId: id } })), 3, "no step ran twice");
});

test("documents: an upload is queued and processed by the job", async () => {
  const source = (await call("POST", `/workspaces/${ws}/knowledge/sources`, { name: "Docs" })).json<KnowledgeSource>();
  sent = [];
  const upload = await app.inject({
    method: "POST",
    url: `/workspaces/${ws}/knowledge/sources/${source.id}/documents?name=faq.txt`,
    headers: { ...adminOf(org), "content-type": "application/octet-stream" },
    payload: Buffer.from("We ship to Canada within five days."),
  });
  assert.equal(upload.statusCode, 201, upload.payload);
  const [job] = jobsOf("knowledge/document.uploaded");
  assert.ok(job);
  await sleep(200);
  assert.equal((await prisma.knowledgeDocument.findUniqueOrThrow({ where: { id: job.documentId } })).status, "PENDING");
  await runJob("knowledge/document.uploaded", job);
  const doc = await prisma.knowledgeDocument.findUniqueOrThrow({ where: { id: job.documentId } });
  assert.equal(doc.status, "READY");
  assert.equal(doc.chunkCount, 1);
});

test("memory: learning from an exchange is a job that carries ids, not the conversation", async () => {
  sent = [];
  const res = await call("POST", `/workspaces/${ws}/employees/${ava}/messages`, { message: QUESTION, customer: "priya@example.com" });
  assert.equal(res.statusCode, 200);
  await until(() => jobsOf("memory/exchange.saved").length === 1);
  const [job] = jobsOf("memory/exchange.saved");
  assert.ok(job?.replyId && job.conversationId && job.customerId);
  assert.ok(!JSON.stringify(job).includes("Priya"), "no customer text in the event");
  assert.equal(await prisma.customerMemory.count({ where: { customerId: job.customerId } }), 0);
  await runJob("memory/exchange.saved", job);
  const fact = await prisma.customerMemory.findFirstOrThrow({ where: { customerId: job.customerId, key: "name" } });
  assert.equal(fact.value, "Priya");
});

test("insights: a quiet conversation is analyzed by its job, which carries ids only", async () => {
  const conversation = await prisma.conversation.create({
    data: {
      organizationId: org,
      workspaceId: ws,
      employeeId: ava,
      createdBy: "test",
      channel: "web_chat",
      title: "Refund",
      messages: { create: [{ organizationId: org, workspaceId: ws, role: "USER", content: "mujhe refund chahiye, bahut ghatiya service" }] },
    },
  });
  const quiet = () => quietInsights({ idleMs: 10 * 60_000, organizationId: org });
  assert.ok(!(await quiet()).some((r) => r.conversationId === conversation.id), "not while the conversation is active");
  await prisma.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date(Date.now() - 20 * 60_000) } });
  const job = (await quiet()).find((r) => r.conversationId === conversation.id);
  assert.deepEqual(job, { conversationId: conversation.id, organizationId: org, workspaceId: ws });
  await runJob("insights/analyze", job);
  const insight = await prisma.conversationInsight.findUniqueOrThrow({ where: { conversationId: conversation.id } });
  assert.equal(insight.sentiment, "negative");
  assert.equal(insight.workspaceId, ws);
  assert.ok(!(await quiet()).some((r) => r.conversationId === conversation.id), "analyzed once per conversation state");
});

test("channels: a WhatsApp message is answered by its job, once", async () => {
  assert.equal((await call("PUT", `/workspaces/${ws}/employees/${ava}/channels/whatsapp`, { config: { phoneNumberId: PNID } })).statusCode, 200);
  sent = [];
  const raw = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: PNID },
              messages: [{ from: "15550001234", id: `wamid.job-${Date.now()}`, timestamp: "1", type: "text", text: { body: "Is it in stock?" } }],
            },
          },
        ],
      },
    ],
  });
  const hook = await app.inject({
    method: "POST",
    url: "/channels/whatsapp/meta/webhook",
    headers: { "content-type": "application/json", "x-hub-signature-256": metaSignature(SECRET, raw) },
    payload: raw,
  });
  assert.equal(hook.statusCode, 200);
  await until(() => jobsOf("channel/message.received").length === 1);
  const [job] = jobsOf("channel/message.received");
  assert.ok(job);
  assert.ok(job.queueKey.endsWith(":+15550001234"), "ordered per channel and customer");
  assert.ok(!JSON.stringify(job).includes("stock"), "no customer text in the event");
  assert.equal((await prisma.channelMessage.findUniqueOrThrow({ where: { id: job.messageId } })).status, "RECEIVED");
  assert.equal(waSent, 0);

  await runJob("channel/message.received", job);
  assert.equal((await prisma.channelMessage.findUniqueOrThrow({ where: { id: job.messageId } })).status, "ANSWERED");
  assert.equal(waSent, 1);
  await runJob("channel/message.received", job); // delivered twice
  assert.equal(waSent, 1);
});

test("with Inngest itself, /api/inngest serves the fifteen functions (nine jobs, six schedules)", async () => {
  // Dev mode needs no keys and no network to describe itself.
  process.env.INNGEST_DEV = "1";
  const real = await buildApp({ authenticate: headerAuth, provider: model, embedder, logger: false, whatsapp: [], jobs: "inngest" });
  try {
    const res = await real.inject({ method: "GET", url: "/api/inngest" });
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json<{ function_count?: number; mode?: string }>();
    assert.equal(body.function_count, 15);
    assert.equal(body.mode, "dev");
  } finally {
    delete process.env.INNGEST_DEV;
    await real.close();
  }
});

async function until(ok: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("Timed out");
    await sleep(10);
  }
}
