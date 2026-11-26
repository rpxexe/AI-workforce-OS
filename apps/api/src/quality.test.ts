// Needs the database from .env to be running (pnpm infra:up && pnpm db:migrate).
// Phase 11: AI quality control. The graders on their own, evaluator versioning, a conversation graded in the
// background with links to its employee version and model, the automatic sweep, failures and the overview,
// and regression datasets replayed against an employee version.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, beforeEach, test } from "node:test";
import type { AIProvider, CompletionRequest } from "@workforce/ai-provider";
import { prisma } from "@workforce/database";
import { deterministic, GRADER_PROMPT, parseGrade, queueDueEvaluations, rules, runEvaluation, type GradeInput } from "@workforce/evaluation-worker";
import { EXTRACTION_PROMPT } from "@workforce/memory";
import {
  defaultEmployeeConfig,
  type ChatStreamEvent,
  type DatasetDetail,
  type EmployeeDetail,
  type EvalCaseInfo,
  type EvalRunDetail,
  type EvaluationRecord,
  type EvaluatorInfo,
  type EvaluatorVersionInfo,
  type InboxResponse,
  type QualityOverview,
  type Workspace,
} from "@workforce/shared";
import { buildApp } from "./app.ts";
import { adminOf, deleteOrgs, headerAuth, memberOf, newOrg } from "./testing.ts";

const orgA = newOrg();
const orgB = newOrg();
let app: Awaited<ReturnType<typeof buildApp>>;
let ws: string;
let wsB: string;
let ava: string;

// ---- Fake model: chat replies from a script, grader answers by dimension ----

let replies: (string | Error)[] = [];
let grades: Record<string, string> = {};
let graderRequests: CompletionRequest[] = [];
let chatRequests: CompletionRequest[] = [];
const model: AIProvider = {
  name: "fake",
  model: "fake-1",
  async *stream(req) {
    let text: string;
    if (req.system.startsWith(EXTRACTION_PROMPT)) text = '{"memories":[]}';
    else if (req.system.startsWith(GRADER_PROMPT)) {
      graderRequests.push(req);
      const dimension = /Dimension: (.+)/.exec(req.system)?.[1] ?? "";
      text = grades[dimension] ?? '{"score": 90, "reason": "Fine.", "findings": []}';
    } else {
      chatRequests.push(req);
      const next = replies.shift() ?? "OK.";
      if (next instanceof Error) throw next;
      text = next;
    }
    yield { type: "text", text };
    yield { type: "done", inputTokens: 3, outputTokens: 2 };
  },
};

// ---- Helpers ----

type Headers = Record<string, string>;
const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object, headers: Headers = adminOf(orgA)) =>
  app.inject({ method, url, headers, payload });
const deps = { provider: () => model, embedder: () => { throw new Error("no embedder"); }, timeoutMs: 5000 };

/** One test-chat message; returns the conversation id. */
const say = async (message: string, conversationId?: string) => {
  const res = await call("POST", `/workspaces/${ws}/employees/${ava}/messages`, { message, conversationId });
  assert.equal(res.statusCode, 200, res.payload);
  const last = res.payload
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice(6)) as ChatStreamEvent)
    .at(-1);
  assert.ok(last?.type === "done", res.payload);
  return last.conversation.id;
};

const until = async <T>(get: () => Promise<T>, ok: (v: T) => boolean, what: string) => {
  const end = Date.now() + 8000;
  for (;;) {
    const value = await get();
    if (ok(value)) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(value).slice(0, 500)}`);
    await sleep(25);
  }
};

const evaluationsOf = async (conversationId: string) =>
  (await call("GET", `/workspaces/${ws}/conversations/${conversationId}/evaluations`, undefined, memberOf(orgA))).json<EvaluationRecord[]>();
const result = (e: EvaluationRecord, dimension: string) => {
  const r = e.results.find((x) => x.dimension === dimension);
  assert.ok(r, `no ${dimension} result`);
  return r;
};

before(async () => {
  app = await buildApp({ authenticate: headerAuth, provider: model, logger: false });
  await app.ready();
  const workspaceOf = async (org: string) => (await call("GET", "/workspaces", undefined, adminOf(org))).json<Workspace[]>()[0]?.id ?? "";
  ws = await workspaceOf(orgA);
  wsB = await workspaceOf(orgB);
  const config = defaultEmployeeConfig("UTC");
  const created = await call("POST", `/workspaces/${ws}/employees`, { ...config, name: "Ava", role: "Sales assistant", escalation: { ...config.escalation, enabled: true, contactEmail: "team@example.test" } });
  assert.equal(created.statusCode, 201, created.payload);
  ava = created.json<EmployeeDetail>().id;
  assert.equal((await call("POST", `/workspaces/${ws}/employees/${ava}/publish`, { version: 1 })).statusCode, 200);
});
beforeEach(() => {
  replies = [];
  grades = {};
  graderRequests = [];
  chatRequests = [];
});
after(async () => {
  await app.close();
  await deleteOrgs(orgA, orgB);
});

test("graders: the LLM grade parser, phrase rules and deterministic checks", () => {
  assert.deepEqual(parseGrade('Sure: {"score": 82.4, "reason": "Good.", "findings": [{"message": "Slightly long", "quote": "x"}, {"nope": 1}]}'), {
    status: "scored",
    score: 82,
    reason: "Good.",
    findings: [{ message: "Slightly long", quote: "x" }],
  });
  assert.equal(parseGrade('{"score": null, "reason": "No facts stated"}').status, "skipped");
  assert.equal(parseGrade('{"score": 140}').status, "error");
  assert.equal(parseGrade("I think it was fine").status, "error");

  const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, s));
  const base: GradeInput = {
    messages: [],
    handoffs: [],
    toolExecutions: [],
    employee: null,
    excerpts: [],
    expectations: "",
    now: at(59),
    provider: () => model,
    timeoutMs: 1000,
  };
  const msg = (role: "USER" | "ASSISTANT", content: string, s: number, latencyMs: number | null = null) => ({ role, content, createdAt: at(s), latencyMs, sources: [], tools: [] });

  // Whole words, any case; a phrase inside another word does not count; regex characters are literal.
  const policy = {
    target: "assistant" as const,
    rules: [
      { label: "No guarantees", match: "forbid" as const, phrases: ["guaranteed", "100% sure"] },
      { label: "Says thanks", match: "require" as const, phrases: ["thank you"] },
    ],
  };
  const clean = rules(policy, { ...base, messages: [msg("ASSISTANT", "Delivery is unguaranteed. Thank you!", 1)] });
  assert.deepEqual([clean.score, clean.findings], [100, []]);
  const broken = rules(policy, { ...base, messages: [msg("ASSISTANT", "It is GUARANTEED, I'm 100% sure.", 1)] });
  assert.equal(broken.score, 0);
  assert.deepEqual(broken.findings.map((f) => f.message), ['No guarantees: "GUARANTEED"', 'Says thanks: none of the messages said "thank you"']);
  assert.equal(rules(policy, base).status, "skipped");

  const tools = deterministic({ check: "tool_success", maxReplyMs: 1, maxWaitMinutes: 1 }, {
    ...base,
    toolExecutions: [{ tool: "calendar_book_meeting", status: "SUCCEEDED", error: null }, { tool: "send_email", status: "INVALID", error: "to: invalid email" }],
  });
  assert.deepEqual([tools.score, tools.findings[0]?.message], [50, "send_email: invalid (to: invalid email)"]);
  assert.equal(deterministic({ check: "tool_success", maxReplyMs: 1, maxWaitMinutes: 1 }, base).status, "skipped");

  const latency = deterministic({ check: "reply_latency", maxReplyMs: 2000, maxWaitMinutes: 1 }, {
    ...base,
    messages: [msg("ASSISTANT", "fast", 1, 900), msg("ASSISTANT", "slow", 2, 4500)],
  });
  assert.deepEqual([latency.score, latency.findings[0]?.message], [50, "A reply took 4.5 s"]);

  // A request for a person with no handoff fails; one handed off and picked up within the limit passes.
  const escalation = { check: "escalation_handling" as const, maxReplyMs: 1, maxWaitMinutes: 1 };
  const ignored = deterministic(escalation, { ...base, messages: [msg("USER", "Can I talk to a human?", 1), msg("ASSISTANT", "I can help!", 2)] });
  assert.deepEqual([ignored.score, ignored.findings[0]?.message], [0, "The customer asked for a person and was not handed off"]);
  const handled = deterministic(escalation, {
    ...base,
    messages: [msg("USER", "Can I talk to a human?", 1)],
    handoffs: [{ trigger: "customer_request", requestedAt: at(2), acceptedAt: at(30), endedAt: null }],
  });
  assert.equal(handled.score, 100);
  const slow = deterministic(escalation, { ...base, now: new Date(at(0).getTime() + 5 * 60_000), handoffs: [{ trigger: "policy_risk", requestedAt: at(0), acceptedAt: null, endedAt: null }] });
  assert.equal(slow.score, 0);
  assert.equal(deterministic(escalation, base).status, "skipped");
});

test("evaluators: built-in defaults, versioning on save, enable switch, validation, roles and isolation", async () => {
  // Two first visits at once must not fail (createMany skipDuplicates).
  const [a, b] = await Promise.all([
    call("GET", `/workspaces/${ws}/evaluators`, undefined, memberOf(orgA)),
    call("GET", `/workspaces/${ws}/evaluators`, undefined, memberOf(orgA)),
  ]);
  assert.equal(a.statusCode, 200, a.payload);
  assert.equal(b.statusCode, 200, b.payload);
  const list = (await call("GET", `/workspaces/${ws}/evaluators`)).json<EvaluatorInfo[]>();
  assert.deepEqual(list.map((e) => e.key).sort(), ["correctness", "escalation", "grounding", "policy", "resolution", "satisfaction", "tone", "tool_use"]);
  assert.ok(list.every((e) => e.enabled && e.current.number === 1));

  const custom = {
    name: "Mentions the trial",
    dimension: "resolution",
    kind: "rule",
    passScore: 100,
    config: { target: "assistant", rules: [{ label: "Offers the trial", match: "require", phrases: ["free trial"] }] },
  };
  assert.equal((await call("POST", `/workspaces/${ws}/evaluators`, custom, memberOf(orgA))).statusCode, 403);
  const bad = await call("POST", `/workspaces/${ws}/evaluators`, { ...custom, kind: "llm", config: { rubric: "short" } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json<{ issues: { path: string }[] }>().issues[0]?.path, "config.rubric");
  const created = await call("POST", `/workspaces/${ws}/evaluators`, custom);
  assert.equal(created.statusCode, 201, created.payload);
  const { id } = created.json<{ id: string }>();

  const saved = await call("PUT", `/workspaces/${ws}/evaluators/${id}`, { ...custom, passScore: 50 });
  assert.equal(saved.statusCode, 200, saved.payload);
  assert.equal(saved.json<EvaluatorVersionInfo>().number, 2);
  const detail = (await call("GET", `/workspaces/${ws}/evaluators/${id}`, undefined, memberOf(orgA))).json<{ current: EvaluatorVersionInfo; versions: EvaluatorVersionInfo[] }>();
  assert.deepEqual([detail.current.number, detail.current.passScore, detail.versions.map((v) => v.passScore)], [2, 50, [50, 100]]);

  assert.equal((await call("PATCH", `/workspaces/${ws}/evaluators/${id}`, { enabled: false })).statusCode, 200);
  assert.equal((await call("GET", `/workspaces/${ws}/evaluators`)).json<EvaluatorInfo[]>().find((e) => e.id === id)?.enabled, false);

  // Other organizations see nothing.
  assert.equal((await call("GET", `/workspaces/${ws}/evaluators/${id}`, undefined, adminOf(orgB))).statusCode, 404);
  assert.equal((await call("GET", `/workspaces/${wsB}/evaluators/${id}`, undefined, adminOf(orgB))).statusCode, 404);
  assert.equal((await call("PUT", `/workspaces/${wsB}/evaluators/${id}`, custom, adminOf(orgB))).statusCode, 404);
});

test("a conversation is graded in the background with links to its employee version and model; failures carry the evidence", async () => {
  replies = ["Our enterprise plan is $499 a month. I guarantee you will love it."];
  grades = { Tone: '{"score": 40, "reason": "Pushy.", "findings": [{"message": "Overpromises", "quote": "I guarantee you will love it."}]}' };
  const id = await say("How much is the enterprise plan?");
  // The customer's turn never waits for grading: nothing has been graded yet.
  assert.equal(graderRequests.length, 0);

  assert.equal((await call("POST", `/workspaces/${ws}/conversations/${id}/evaluations`, {}, memberOf(orgA))).statusCode, 403);
  const queued = await call("POST", `/workspaces/${ws}/conversations/${id}/evaluations`, {});
  assert.equal(queued.statusCode, 202, queued.payload);
  assert.equal(queued.json<EvaluationRecord>().status, "PENDING");

  const [done] = await until(() => evaluationsOf(id), (list) => list[0]?.status === "COMPLETED", "the evaluation");
  assert.ok(done);
  assert.deepEqual([done.employee.name, done.employeeVersion, done.provider, done.model, done.workflow, done.trigger], ["Ava", 1, "fake", "fake-1", null, "manual"]);
  // 8 built-in evaluators; the custom one from the previous test is turned off.
  assert.equal(done.results.length, 8);
  assert.deepEqual([result(done, "policy").passed, result(done, "policy").findings[0]?.message], [false, 'No guarantees: "I guarantee"']);
  assert.match(result(done, "policy").findings[0]?.quote ?? "", /I guarantee you will love it/);
  assert.deepEqual([result(done, "tone").score, result(done, "tone").passed, result(done, "tone").findings[0]?.quote], [40, false, "I guarantee you will love it."]);
  assert.deepEqual([result(done, "correctness").score, result(done, "correctness").passed], [90, true]);
  assert.equal(result(done, "tool_use").status, "skipped");
  assert.equal(result(done, "escalation").status, "skipped");
  assert.equal(result(done, "satisfaction").passed, true);
  assert.deepEqual([done.failures, done.passed], [2, false]);
  // Average of the scored results: four LLM graders (90, 90, 40, 90), policy 50, satisfaction 100.
  assert.equal(done.score, Math.round(((90 + 90 + 40 + 90 + 50 + 100) / 6) * 10) / 10);

  // Each LLM grader read the rubric, the employee's configuration and the transcript.
  assert.equal(graderRequests.length, 4);
  const tone = graderRequests.find((r) => r.system.includes("Dimension: Tone"));
  assert.match(tone?.system ?? "", /Role: Sales assistant/);
  assert.match(JSON.stringify(tone?.messages[0]).replaceAll("\\n", "\n"),/\[1\] Customer: How much is the enterprise plan\?\n\n\[2\] AI employee: Our enterprise plan is \$499/);

  // Failures list and filters.
  const failures = (await call("GET", `/workspaces/${ws}/evaluations?failed=true`, undefined, memberOf(orgA))).json<EvaluationRecord[]>();
  assert.ok(failures.some((e) => e.id === done.id));
  assert.equal((await call("GET", `/workspaces/${ws}/evaluations?dimension=tone&failed=true`)).json<EvaluationRecord[]>().length, 1);
  assert.equal((await call("GET", `/workspaces/${ws}/evaluations?dimension=grounding&failed=true`)).json<EvaluationRecord[]>().length, 0);
  assert.equal((await call("GET", `/workspaces/${ws}/conversations/${id}/evaluations`, undefined, adminOf(orgB))).statusCode, 404);
  assert.equal((await call("POST", `/workspaces/${wsB}/conversations/${id}/evaluations`, {}, adminOf(orgB))).statusCode, 404);

  // The overview.
  const overview = (await call("GET", `/workspaces/${ws}/quality?days=7`, undefined, memberOf(orgA))).json<QualityOverview>();
  assert.equal(overview.judged === 0 ? null : overview.passing / overview.judged, overview.passRate, "exact counts match the rate");
  assert.equal(overview.evaluations, 1);
  assert.equal(overview.failures, 2);
  assert.equal(overview.passRate, 0);
  assert.equal(overview.trend.length, 7);
  assert.equal(overview.trend.at(-1)?.evaluations, 1);
  assert.equal(overview.byDimension.find((d) => d.dimension === "tone")?.averageScore, 40);
  assert.deepEqual(overview.byEmployee.map((e) => [e.name, e.dimensions.policy]), [["Ava", 50]]);
  assert.deepEqual(overview.byVersion.map((v) => [v.name, v.version, v.evaluations]), [["Ava", 1, 1]]);
  assert.deepEqual(overview.topFailures.map((f) => f.name).sort(), ["Policy rules", "Tone"]);
  const evaluators = (await call("GET", `/workspaces/${ws}/evaluators`)).json<EvaluatorInfo[]>();
  assert.deepEqual(evaluators.find((e) => e.key === "tone")?.recent, { results: 1, passed: 0, averageScore: 40 });
});

test("the sweep grades conversations once they go quiet, and again only after they change", async () => {
  replies = ["Happy to help.", "You are welcome."];
  const id = await say("Hi there");
  // Not quiet long enough.
  assert.deepEqual(await queueDueEvaluations({ idleMs: 60_000, organizationId: orgA }), []);
  const first = await queueDueEvaluations({ idleMs: 0, organizationId: orgA });
  assert.equal(first.length, 1);
  assert.equal(await runEvaluation(first[0] ?? "", deps), true);
  assert.equal(await runEvaluation(first[0] ?? "", deps), false); // a duplicate job does nothing
  assert.deepEqual(await queueDueEvaluations({ idleMs: 0, organizationId: orgA }), []);

  await say("Thanks!", id);
  const second = await queueDueEvaluations({ idleMs: 0, organizationId: orgA });
  assert.equal(second.length, 1);
  await runEvaluation(second[0] ?? "", deps);
  const list = await evaluationsOf(id);
  assert.deepEqual(list.map((e) => [e.trigger, e.status, e.messageCount]), [["auto", "COMPLETED", 4], ["auto", "COMPLETED", 2]]);
});

test("an evaluation links the workflow version that started the conversation", async () => {
  const id = await say("Lead from the website");
  const workflow = await prisma.workflow.create({ data: { organizationId: orgA, workspaceId: ws, name: "Lead follow-up", hookToken: "t", createdBy: "user_admin" } });
  const version = await prisma.workflowVersion.create({ data: { workflowId: workflow.id, number: 3, definition: {}, createdBy: "user_admin" } });
  const execution = await prisma.workflowExecution.create({
    data: { organizationId: orgA, workspaceId: ws, workflowId: workflow.id, versionId: version.id, status: "COMPLETED", input: {}, startedBy: "webhook" },
  });
  await prisma.workflowStepExecution.create({
    data: { executionId: execution.id, nodeId: "ask", nodeType: "ai_employee", attempt: 1, status: "SUCCEEDED", output: { reply: "OK.", conversationId: id } },
  });
  const [evaluationId] = await queueDueEvaluations({ idleMs: 0, organizationId: orgA }).then((ids) => ids.filter(Boolean));
  assert.ok(evaluationId);
  const [record] = await evaluationsOf(id);
  assert.deepEqual(record?.workflow, { id: workflow.id, name: "Lead follow-up", version: 3 });
});

test("regression datasets:cases from a real conversation and by hand, replayed against a version without tools, kept out of the inbox", async () => {
  replies = ["We open at 9 am."];
  const source = await say("When do you open?");
  assert.equal((await call("POST", `/workspaces/${ws}/datasets`, { name: "Smoke" }, memberOf(orgA))).statusCode, 403);
  const created = await call("POST", `/workspaces/${ws}/datasets`, { name: "Smoke", description: "Basics" });
  assert.equal(created.statusCode, 201, created.payload);
  assert.equal((await call("POST", `/workspaces/${ws}/datasets`, { name: "Smoke" })).statusCode, 409);
  const { id } = created.json<{ id: string }>();
  const path = `/workspaces/${ws}/datasets/${id}`;

  assert.equal((await call("POST", `${path}/runs`, { employeeId: ava })).statusCode, 400); // no cases yet
  const copied = await call("POST", `${path}/cases`, { name: "Opening hours", conversationId: source, expectations: "Says 9 am." });
  assert.equal(copied.statusCode, 201, copied.payload);
  assert.deepEqual(copied.json<EvalCaseInfo>().messages, [
    { role: "customer", content: "When do you open?" },
    { role: "employee", content: "We open at 9 am." },
  ]);
  assert.equal((await call("POST", `${path}/cases`, { name: "Bad", messages: [{ role: "employee", content: "Hi" }] })).statusCode, 400);
  assert.equal((await call("POST", `${path}/cases`, { name: "Both", conversationId: source, messages: [{ role: "customer", content: "Hi" }] })).statusCode, 400);
  const synthetic = await call("POST", `${path}/cases`, {
    name: "Angry refund",
    messages: [{ role: "customer", content: "This is useless." }, { role: "customer", content: "I want my money back" }],
  });
  assert.equal(synthetic.statusCode, 201, synthetic.payload);

  replies = ["We open at 9 am.", "Sorry to hear that.", new Error("model down")];
  const started = await call("POST", `${path}/runs`, { employeeId: ava, version: 1 });
  assert.equal(started.statusCode, 202, started.payload);
  const runId = started.json<{ id: string }>().id;
  const run = await until(
    async () => (await call("GET", `/workspaces/${ws}/eval-runs/${runId}`, undefined, memberOf(orgA))).json<EvalRunDetail>(),
    (r) => r.status === "COMPLETED",
    "the run",
  );
  assert.deepEqual([run.employeeVersion, run.total, run.evaluations.length], [1, 2, 2]);
  const [hours, angry] = run.evaluations;
  assert.deepEqual([hours?.trigger, hours?.status, hours?.messageCount], ["dataset", "COMPLETED", 2]);
  // The expectations reach the LLM graders.
  assert.ok(graderRequests.some((r) => r.system.includes("What a good answer does in this test case: Says 9 am.")));
  // The second turn of the angry case failed: the case fails with why.
  assert.deepEqual([angry?.status, angry?.error], ["FAILED", "The replay failed: Something went wrong while answering. Try again."]);
  assert.deepEqual([run.passed, run.failed, run.score], [1, 1, hours?.score]);
  // The replay was offered no registry tools.
  assert.ok(chatRequests.every((r) => (r.tools ?? []).every((t) => t.name === "transfer_to_human")));

  // Replays stay out of the inbox, the employee's test chats and the overview.
  const inbox = (await call("GET", `/workspaces/${ws}/inbox?view=all`, undefined, memberOf(orgA))).json<InboxResponse>();
  assert.ok(!inbox.items.some((c) => c.id === hours?.conversationId));
  const chats = (await call("GET", `/workspaces/${ws}/employees/${ava}/conversations`)).json<{ id: string }[]>();
  assert.ok(!chats.some((c) => c.id === hours?.conversationId));
  assert.ok(!(await call("GET", `/workspaces/${ws}/evaluations`)).json<EvaluationRecord[]>().some((e) => e.trigger === "dataset"));
  assert.deepEqual(await queueDueEvaluations({ idleMs: 0, organizationId: orgA }).then((ids) => ids.length), 1); // only the source conversation, not the replays
  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: hours?.conversationId ?? "" } });
  assert.equal(conversation.channel, "evaluation");

  const detail = (await call("GET", path, undefined, memberOf(orgA))).json<DatasetDetail>();
  assert.deepEqual([detail.cases, detail.runs.length, detail.lastRun?.id], [2, 1, runId]);
  assert.equal((await call("GET", path, undefined, adminOf(orgB))).statusCode, 404);
  assert.equal((await call("DELETE", `${path}/cases/${copied.json<EvalCaseInfo>().id}`)).statusCode, 204);
  assert.equal((await call("DELETE", path)).statusCode, 204);
  assert.equal((await call("GET", `/workspaces/${ws}/eval-runs/${runId}`)).statusCode, 404);
});
