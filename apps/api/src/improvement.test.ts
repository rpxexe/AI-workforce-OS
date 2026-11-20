// Needs the database from .env to be running (pnpm infra:up && pnpm db:migrate).
// Phase 12: controlled continuous improvement. A failure pattern becomes a suggestion (the employee is not
// touched), a person creates the proposed version and tests it against the regression suite, approves it,
// rolls it out to a share of customers with the KPI compared, promotes it, and rolls back.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import { rolloutBucket, servedVersion } from "@workforce/agent-runtime";
import type { AIProvider, CompletionRequest } from "@workforce/ai-provider";
import { prisma } from "@workforce/database";
import { compareKpi, GRADER_PROMPT, IMPROVE_PROMPT, parseProposal } from "@workforce/evaluation-worker";
import { EXTRACTION_PROMPT } from "@workforce/memory";
import {
  defaultEmployeeConfig,
  type ChatStreamEvent,
  type EmployeeDetail,
  type EmployeeReleases,
  type EvaluationRecord,
  type ImprovementDetail,
  type ImprovementSummary,
  type RolloutInfo,
  type Workspace,
} from "@workforce/shared";
import { buildApp } from "./app.ts";
import { liveEmployee } from "./channels/service.ts";
import { adminOf, deleteOrgs, headerAuth, memberOf, newOrg } from "./testing.ts";

const orgA = newOrg();
const orgB = newOrg();
let app: Awaited<ReturnType<typeof buildApp>>;
let ws: string;
let wsB: string;
let ava: string;

const BASE_INSTRUCTIONS = "Answer briefly.";
const FIX = "Always greet the customer warmly.";

// ---- Fake model: replies "OK.", the tone grader fails unless the instructions contain the fix, proposals from a script ----

let proposal = "";
const improveRequests: CompletionRequest[] = [];
const model: AIProvider = {
  name: "fake",
  model: "fake-1",
  async *stream(req) {
    let text = "OK.";
    if (req.system.startsWith(EXTRACTION_PROMPT)) text = '{"memories":[]}';
    else if (req.system === IMPROVE_PROMPT) {
      improveRequests.push(req);
      text = proposal;
    } else if (req.system.startsWith(GRADER_PROMPT)) {
      const tone = /Dimension: Tone/.test(req.system);
      text =
        tone && !req.system.includes(FIX)
          ? '{"score": 30, "reason": "Cold and abrupt.", "findings": [{"message": "No greeting", "quote": "OK."}]}'
          : '{"score": 95, "reason": "Fine.", "findings": []}';
    }
    yield { type: "text", text };
    yield { type: "done", inputTokens: 3, outputTokens: 2 };
  },
};

type Headers = Record<string, string>;
const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object, headers: Headers = adminOf(orgA)) =>
  app.inject({ method, url, headers, payload });

const until = async <T>(get: () => Promise<T>, ok: (v: T) => boolean, what: string) => {
  const end = Date.now() + 10_000;
  for (;;) {
    const value = await get();
    if (ok(value)) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(value).slice(0, 500)}`);
    await sleep(25);
  }
};

const say = async (message: string) => {
  const res = await call("POST", `/workspaces/${ws}/employees/${ava}/messages`, { message });
  assert.equal(res.statusCode, 200, res.payload);
  const last = res.payload
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice(6)) as ChatStreamEvent)
    .at(-1);
  assert.ok(last?.type === "done", res.payload);
  return last.conversation.id;
};

/** A test chat graded with "Evaluate now"; returns the finished evaluation. */
const gradedConversation = async (message: string) => {
  const conversationId = await say(message);
  assert.equal((await call("POST", `/workspaces/${ws}/conversations/${conversationId}/evaluations`)).statusCode, 202);
  const list = await until(
    async () => (await call("GET", `/workspaces/${ws}/conversations/${conversationId}/evaluations`)).json<EvaluationRecord[]>(),
    (l) => l[0]?.status === "COMPLETED",
    "the evaluation",
  );
  return list[0];
};

const suggestions = async () => (await call("GET", `/workspaces/${ws}/improvements`, undefined, memberOf(orgA))).json<ImprovementSummary[]>();
const detailOf = async (id: string) => (await call("GET", `/workspaces/${ws}/improvements/${id}`, undefined, memberOf(orgA))).json<ImprovementDetail>();
const employee = async () => (await call("GET", `/workspaces/${ws}/employees/${ava}`)).json<EmployeeDetail>();
const releases = async () => (await call("GET", `/workspaces/${ws}/employees/${ava}/releases`, undefined, memberOf(orgA))).json<EmployeeReleases>();
/** A customer key that falls inside (or outside) a rollout's share. */
const keyFor = (rolloutId: string, inside: boolean, percent: number) => {
  for (let i = 0; ; i++) if (rolloutBucket(rolloutId, `+1555000${i}`) < percent === inside) return `+1555000${i}`;
};

before(async () => {
  app = await buildApp({ authenticate: headerAuth, provider: model, logger: false });
  await app.ready();
  const workspaceOf = async (org: string) => (await call("GET", "/workspaces", undefined, adminOf(org))).json<Workspace[]>()[0]?.id ?? "";
  ws = await workspaceOf(orgA);
  wsB = await workspaceOf(orgB);
  const created = await call("POST", `/workspaces/${ws}/employees`, {
    ...defaultEmployeeConfig("UTC"),
    name: "Ava",
    role: "Support assistant",
    systemInstructions: BASE_INSTRUCTIONS,
    goals: ["Help customers"],
  });
  assert.equal(created.statusCode, 201, created.payload);
  ava = created.json<EmployeeDetail>().id;
  assert.equal((await call("POST", `/workspaces/${ws}/employees/${ava}/publish`, { version: 1 })).statusCode, 200);
});
after(async () => {
  await app.close();
  await deleteOrgs(orgA, orgB);
});

// ---- Pure parts ----

test("a proposal keeps only the instruction fields, and must be valid and different", () => {
  const base = { ...defaultEmployeeConfig("UTC"), name: "Ava", role: "Support", systemInstructions: "Be brief." };
  const ok = parseProposal(
    `Here: {"title": "Greet", "summary": "Adds a greeting.", "systemInstructions": "Be brief. Greet first.", "name": "Hacked", "goals": ["Help"]}`,
    base,
  );
  assert.ok("change" in ok);
  assert.deepEqual(ok.change.fields, { systemInstructions: "Be brief. Greet first.", goals: ["Help"] });
  assert.equal(ok.title, "Greet");
  assert.ok("skipped" in parseProposal('{"title": "Same", "systemInstructions": "Be brief."}', base), "no real change");
  assert.ok("skipped" in parseProposal('{"title": null, "summary": "Missing knowledge, not instructions."}', base));
  assert.ok("skipped" in parseProposal("not json", base));
  assert.ok("skipped" in parseProposal(`{"title": "Long", "systemInstructions": "${"x".repeat(20_001)}"}`, base), "invalid configuration");
});

test("KPI comparison: a verdict only with enough samples and a difference beyond chance", () => {
  const few = compareKpi("score", { version: 1, values: [50, 60] }, { version: 2, values: [90, 95] });
  assert.equal(few.verdict, "not_enough_data");
  assert.equal(few.difference, 37.5);
  const ten = (v: number[]) => Array.from({ length: 12 }, (_, i) => v[i % v.length] ?? 0);
  assert.equal(compareKpi("score", { version: 1, values: ten([40, 50, 45]) }, { version: 2, values: ten([85, 90, 95]) }).verdict, "improved");
  assert.equal(compareKpi("pass_rate", { version: 1, values: ten([100, 0]) }, { version: 2, values: ten([0, 100]) }).verdict, "no_difference");
  assert.equal(compareKpi("tone", { version: 1, values: ten([100]) }, { version: 2, values: ten([0]) }).verdict, "worse");
});

test("rollout buckets are stable, and raising the share keeps everyone already on the candidate", () => {
  const keys = Array.from({ length: 2000 }, (_, i) => `customer-${i}`);
  const at = (p: number) => new Set(keys.filter((k) => servedVersion("v1", { id: "r1", percent: p, candidateVersion: "v2" }, k) === "v2"));
  const ten = at(10);
  const fifty = at(50);
  assert.ok([...ten].every((k) => fifty.has(k)));
  assert.ok(fifty.size > 850 && fifty.size < 1150, `about half: ${fifty.size}`);
  assert.equal(at(100).size, 2000);
  assert.equal(servedVersion("v1", { id: "r1", percent: 100, candidateVersion: "v2" }, undefined), "v1", "no customer: the published version");
  assert.equal(rolloutBucket("r1", "x"), rolloutBucket("r1", "x"));
});

// ---- The pipeline ----

test("failure pattern -> suggestion -> tested version -> approval -> rollout with KPI -> promote -> rollback", async () => {
  // Three conversations on the live version fail the tone check.
  for (const message of ["Hi, where is my order?", "Can I change my address?", "Do you ship to Canada?"]) {
    const evaluation = await gradedConversation(message);
    assert.equal(evaluation?.results.find((r) => r.dimension === "tone")?.passed, false);
  }

  // Analysis: members cannot start it; it writes a suggestion and leaves the employee alone.
  assert.equal((await call("POST", `/workspaces/${ws}/improvements/analyze`, undefined, memberOf(orgA))).statusCode, 403);
  proposal = JSON.stringify({
    title: "Greet customers warmly",
    summary: "The replies were curt; the instructions now ask for a warm greeting.",
    systemInstructions: `${BASE_INSTRUCTIONS}\n${FIX}`,
    escalation: { enabled: true },
  });
  assert.equal((await call("POST", `/workspaces/${ws}/improvements/analyze`)).statusCode, 202);
  const [summary] = await until(suggestions, (l) => l.length > 0, "a suggestion");
  assert.ok(summary);
  assert.equal(summary.stage, "proposed");
  assert.equal(summary.dimension, "tone");
  assert.equal(summary.baseVersion, 1);
  assert.equal(summary.proposedVersion, null);
  assert.equal((await employee()).versions.length, 1, "no version is created by the analysis");
  const first = improveRequests[0]?.messages[0];
  const asked = first && "content" in first ? String(first.content) : "";
  assert.match(asked, /Answer briefly\./);
  assert.match(asked, /failed 3 of 3/);
  assert.match(asked, /No greeting \(quote: "OK\."\)/);

  let detail = await detailOf(summary.id);
  assert.equal(detail.evidence.failures, 3);
  assert.equal(detail.evidence.examples.length, 3);
  assert.equal(detail.evidence.examples[0]?.findings[0]?.quote, "OK.");
  assert.deepEqual(detail.change.fields, { systemInstructions: `${BASE_INSTRUCTIONS}\n${FIX}` }, "escalation is not improvable");
  assert.equal(detail.proposed.systemInstructions, `${BASE_INSTRUCTIONS}\n${FIX}`);
  assert.equal(detail.base.systemInstructions, BASE_INSTRUCTIONS);
  assert.equal(detail.kpi, "tone");

  // The same pattern is not suggested twice.
  const asksBefore = improveRequests.length;
  assert.equal((await call("POST", `/workspaces/${ws}/improvements/analyze`)).statusCode, 202);
  await sleep(300);
  assert.equal((await suggestions()).length, 1);
  assert.equal(improveRequests.length, asksBefore);

  // Nothing is approved without tests.
  const decide = (decision: string, headers?: Headers) => call("POST", `/workspaces/${ws}/improvements/${summary.id}/decision`, { decision }, headers);
  assert.equal((await decide("approve")).statusCode, 409);
  assert.equal((await decide("approve", memberOf(orgA))).statusCode, 403);

  // Test: version 2 is created (not published) and the regression suite is replayed on both versions.
  const tested = await call("POST", `/workspaces/${ws}/improvements/${summary.id}/test`);
  assert.equal(tested.statusCode, 202, tested.payload);
  const current = await employee();
  assert.equal(current.versions[0]?.number, 2);
  assert.equal(current.versions[0]?.systemInstructions, `${BASE_INSTRUCTIONS}\n${FIX}`);
  assert.equal(current.publishedVersion, 1, "production is untouched");
  detail = await until(() => detailOf(summary.id), (d) => d.tests?.complete === true, "both regression runs");
  assert.equal(detail.stage, "tested");
  assert.equal(detail.proposedVersion, 2);
  assert.equal(detail.tests?.cases.length, 3, "the failing conversations became cases");
  assert.equal(detail.tests?.fixes, 3);
  assert.equal(detail.tests?.regressions, 0);
  assert.equal(detail.tests?.baseline?.employeeVersion, 1);
  assert.equal(detail.tests?.candidate?.passed, 3);
  const suite = (await releases()).regressionSuite;
  assert.equal(suite?.cases, 3);

  // Unapproved, the version can be neither published nor rolled out.
  assert.equal((await call("POST", `/workspaces/${ws}/employees/${ava}/publish`, { version: 2 })).statusCode, 409);
  const start = (body: object, headers?: Headers) => call("POST", `/workspaces/${ws}/employees/${ava}/rollouts`, body, headers);
  assert.equal((await start({ version: 2, percent: 50, kpi: "score" })).statusCode, 409);

  const approved = await decide("approve");
  assert.equal(approved.statusCode, 200, approved.payload);
  assert.equal(approved.json<ImprovementDetail>().stage, "approved");
  assert.equal((await decide("reject")).statusCode, 409, "decided once");

  // Rollout to half of the customers; production publishing waits until it ends.
  assert.equal((await start({ version: 2, percent: 50, kpi: "score" }, memberOf(orgA))).statusCode, 403);
  assert.equal((await start({ version: 1, percent: 50, kpi: "score" })).statusCode, 400, "already live");
  const started = await start({ version: 2, percent: 50, kpi: "score" });
  assert.equal(started.statusCode, 201, started.payload);
  const rollout = started.json<RolloutInfo>();
  assert.deepEqual([rollout.controlVersion, rollout.candidateVersion, rollout.status], [1, 2, "active"]);
  assert.equal((await start({ version: 2, percent: 10, kpi: "score" })).statusCode, 409, "one at a time");
  assert.equal((await call("POST", `/workspaces/${ws}/employees/${ava}/publish`, { version: 2 })).statusCode, 409);
  assert.equal((await detailOf(summary.id)).stage, "rolling_out");

  const inside = keyFor(rollout.id, true, 50);
  const outside = keyFor(rollout.id, false, 50);
  assert.equal((await liveEmployee(ava, inside))?.version.number, 2);
  assert.equal((await liveEmployee(ava, outside))?.version.number, 1);
  assert.equal((await liveEmployee(ava))?.version.number, 1);

  const patch = (body: object, headers?: Headers) => call("PATCH", `/workspaces/${ws}/employees/${ava}/rollouts/${rollout.id}`, body, headers);
  assert.equal((await patch({ action: "set_percent", percent: 100 })).statusCode, 200);
  assert.equal((await liveEmployee(ava, outside))?.version.number, 2, "everyone at 100%");

  // KPI: production evaluations of each version (the three graded on v1 count as its baseline).
  const v = await prisma.aiEmployeeVersion.findMany({ where: { employeeId: ava }, orderBy: { number: "asc" }, select: { id: true } });
  const conversation = await prisma.conversation.findFirstOrThrow({ where: { employeeId: ava, channel: "test" } });
  const graded = (versionId: string | undefined, score: number) => ({
    organizationId: orgA,
    workspaceId: ws,
    conversationId: conversation.id,
    employeeId: ava,
    employeeVersionId: versionId,
    trigger: "auto",
    status: "COMPLETED" as const,
    score,
    passed: score >= 70,
    messageCount: 2,
    lastMessageAt: new Date(),
    requestedBy: "system",
  });
  await prisma.evaluation.createMany({
    data: [
      ...Array.from({ length: 10 }, (_, i) => graded(v[0]?.id, 40 + (i % 3) * 5)),
      ...Array.from({ length: 12 }, (_, i) => graded(v[1]?.id, 85 + (i % 3) * 5)),
    ],
  });
  const active = (await releases()).active;
  assert.equal(active?.result.verdict, "improved");
  assert.equal(active?.result.candidate.samples, 12);
  assert.equal(active?.result.control.samples, 13);
  assert.ok((active?.result.difference ?? 0) > 30);

  // Promote: version 2 is published for everyone and the rollout ends.
  const promoted = await patch({ action: "promote" });
  assert.equal(promoted.statusCode, 200, promoted.payload);
  assert.equal(promoted.json<RolloutInfo>().status, "promoted");
  assert.equal((await employee()).publishedVersion, 2);
  assert.equal((await detailOf(summary.id)).stage, "released");
  assert.equal((await patch({ action: "rollback" })).statusCode, 409, "no longer running");
  let r = await releases();
  assert.equal(r.active, null);
  assert.deepEqual(r.releases.map((x) => [x.action, x.version, x.previousVersion]), [["promote", 2, 1], ["publish", 1, null]]);
  assert.equal(r.rollbackTo, 1);

  // Roll back to the previous version.
  assert.equal((await call("POST", `/workspaces/${ws}/employees/${ava}/rollback`, undefined, memberOf(orgA))).statusCode, 403);
  const back = await call("POST", `/workspaces/${ws}/employees/${ava}/rollback`);
  assert.equal(back.statusCode, 200, back.payload);
  assert.equal((await employee()).publishedVersion, 1);
  r = await releases();
  assert.deepEqual(r.releases[0] && [r.releases[0].action, r.releases[0].version, r.releases[0].previousVersion], ["rollback", 1, 2]);
  assert.equal(r.rollbackTo, null, "nothing was live before version 1");
  assert.equal((await call("POST", `/workspaces/${ws}/employees/${ava}/rollback`)).statusCode, 409);

  // A rollout rolled back leaves everyone on the published version.
  const again = (await start({ version: 2, percent: 30, kpi: "tone" })).json<RolloutInfo>();
  const rolled = await call("PATCH", `/workspaces/${ws}/employees/${ava}/rollouts/${again.id}`, { action: "rollback" });
  assert.equal(rolled.json<RolloutInfo>().status, "rolled_back");
  assert.equal((await liveEmployee(ava, keyFor(again.id, true, 30)))?.version.number, 1);
  assert.equal((await detailOf(summary.id)).stage, "rolled_back");
  assert.equal((await employee()).publishedVersion, 1);

  // Other organizations see nothing.
  assert.equal((await call("GET", `/workspaces/${ws}/improvements/${summary.id}`, undefined, adminOf(orgB))).statusCode, 404);
  assert.equal((await call("GET", `/workspaces/${wsB}/improvements/${summary.id}`, undefined, adminOf(orgB))).statusCode, 404);
  assert.equal((await call("POST", `/workspaces/${wsB}/improvements/${summary.id}/decision`, { decision: "reject" }, adminOf(orgB))).statusCode, 404);
  assert.equal((await call("GET", `/workspaces/${wsB}/employees/${ava}/releases`, undefined, adminOf(orgB))).statusCode, 404);
  assert.equal((await call("POST", `/workspaces/${wsB}/employees/${ava}/rollback`, undefined, adminOf(orgB))).statusCode, 404);
});
