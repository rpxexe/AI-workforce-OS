// What each node type does when a run reaches it. A node either finishes (with an output that
// later steps can read, and a branch for conditions) or asks to wait (until a time, or until a
// person continues the run), and is called again when the wait is over.
//
// Idempotency: a step can run twice when its runner dies mid-step (the next runner continues the
// same attempt). Every step with an outside effect is keyed by `run.idempotencyKey`
// (execution:node:attempt), so the second run finds or deduplicates the first one's effect; where
// that is impossible it fails instead of acting twice. A manual retry is a new attempt and acts again.
import { configOf, ROLLOUT_INCLUDE, runTurn, servedVersion, startHandoff, type HandoffNotice, type HandoffRequest } from "@workforce/agent-runtime";
import { AIProviderError, type AIProvider, type EmbeddingProvider, type Route } from "@workforce/ai-provider";
import { prisma } from "@workforce/database";
import { factWrites, identifyCustomer, type MemoryService } from "@workforce/memory";
import { normalizeCustomerId, type Branch, type NodeConfig, type NodeType, type UsageLimiter } from "@workforce/shared";
import { ENDED_STATUSES } from "@workforce/telephony";
import { toolRegistry, ToolError, type Mailer, type ToolExecutor } from "@workforce/tools";
import { z } from "zod";

export type PlaceCallRequest = {
  organizationId: string;
  workspaceId: string;
  employeeId: string;
  to: string;
  greeting?: string;
  /** Placing again with the same key returns the first call instead of dialing. */
  idempotencyKey: string;
  /** The workflow placing it: its provider overrides apply to the call (Phase 14). */
  workflowId?: string;
};

/** Everything the engine needs from outside, so the API and tests can supply their own. */
export type EngineDeps = {
  /** A provider bound to a route (tenant and task): the model router. */
  provider: (route: Route) => AIProvider;
  embedder: () => EmbeddingProvider;
  /** Customer memory for a tenant; extraction runs on the tenant's "memory" model. */
  memory: (scope: { organizationId: string; workspaceId: string }) => MemoryService;
  tools: ToolExecutor;
  timeoutMs: number;
  /** Network access for HTTP Request and Webhook nodes: `safeFetch` (public https only) in production. */
  fetch: typeof fetch;
  /** Places an outbound call with an employee; throws `StepError` when it cannot. */
  placeCall: (request: PlaceCallRequest) => Promise<{ callId: string }>;
  /** Sends Message steps' email; null means test mode (nothing is delivered). */
  mailer: Mailer | null;
  /** How often a waiting Voice Call step checks whether the call has ended. */
  callPollMs: number;
  /** Hears about failures that are bugs; the run only shows "the step failed unexpectedly". */
  onError: (err: unknown, context: string) => void;
  /** Tells people about a handoff an AI Employee step's turn started. */
  onHandoff?: (notice: HandoffNotice) => void;
  /** Plan limits (Phase 16), passed to the AI Employee step's turn. */
  planLimits?: UsageLimiter;
};

/** A failure the step expects. Its message is shown on the run. */
export class StepError extends Error {}

export type StepResult =
  | { output: unknown; branch?: Branch }
  /** `until` null: wait until someone continues the run. `state` comes back on the next call. */
  | { wait: { until: Date | null; state: Record<string, unknown> } };

export type StepRun = {
  scope: { organizationId: string; workspaceId: string };
  executionId: string;
  workflowId: string;
  nodeId: string;
  /** What templates read: { trigger, steps }. */
  data: { trigger: unknown; steps: Record<string, unknown> };
  /** What this step saved when it last asked to wait; null on the first call. */
  state: Record<string, unknown> | null;
  /** `${executionId}:${nodeId}:${attempt}`: the same when a step is run again after its runner died. */
  idempotencyKey: string;
  /** True when this attempt already started once and its runner died before it finished. */
  interrupted: boolean;
  deps: EngineDeps;
};

type Handlers = { [T in NodeType]: (config: NodeConfig<T>, run: StepRun) => Promise<StepResult> };

const UNIT_MS = { seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;
/** A placed call that has not ended after this long is reported as failed. */
const CALL_GIVE_UP_MS = 45 * 60_000;
const HTTP_TIMEOUT_MS = 15_000;
const MAX_BODY_CHARS = 100_000;

const aiFailed = (err: unknown) =>
  err instanceof AIProviderError ? new StepError(`The AI provider failed (${err.kind}): ${err.message}`) : err;

/**
 * A published, active employee in the run's workspace, or a StepError. `publishedVersion` is the version that
 * answers: a rollout's candidate for its share of customers (keyed by the step's customer, else the run).
 */
async function liveEmployee(run: StepRun, employeeId: string, customer?: string) {
  const employee = await prisma.aiEmployee.findFirst({
    where: { id: employeeId, ...run.scope },
    include: { publishedVersion: true, knowledgeSources: { select: { sourceId: true } }, tools: { select: { tool: true } }, ...ROLLOUT_INCLUDE },
  });
  if (!employee) throw new StepError("The employee no longer exists");
  if (employee.status !== "ACTIVE" || !employee.publishedVersion) throw new StepError("The employee is not published and active");
  return { ...employee, publishedVersion: servedVersion(employee.publishedVersion, employee.activeRollout, customer ? normalizeCustomerId(customer) : run.executionId) };
}

/** Tells people about a handoff a workflow started, as a handoff in a chat does (alert, email, reminder). */
async function notifyHandoff(run: StepRun, handoffId: string, conversationId: string, employeeId: string, request: HandoffRequest) {
  if (!run.deps.onHandoff) return;
  const employee = await prisma.aiEmployee.findFirst({
    where: { id: employeeId, ...run.scope },
    include: { publishedVersion: true, versions: { orderBy: { number: "desc" }, take: 1 } },
  });
  const version = employee?.publishedVersion ?? employee?.versions[0];
  if (!version) return;
  const { name, escalation } = configOf(version);
  try {
    run.deps.onHandoff({
      ...run.scope,
      employeeId,
      employeeName: name,
      conversationId,
      handoffId,
      ...request,
      contactEmail: escalation.contactEmail,
      reminderMinutes: escalation.reminderMinutes,
    });
  } catch {
    // A failed notification must not fail the step: the conversation is already with people.
  }
}

/** Sends a request through the guarded fetch and returns the status and the body (JSON when it parses). */
async function request(run: StepRun, url: string, init: RequestInit) {
  let res: Response;
  try {
    res = await run.deps.fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof ToolError) throw new StepError(err.message);
    throw new StepError(err instanceof Error && err.name === "TimeoutError" ? "The request timed out" : "The request could not be sent");
  }
  const text = (await res.text().catch(() => "")).slice(0, MAX_BODY_CHARS);
  if (!res.ok) throw new StepError(`The server answered ${res.status}`);
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON: keep the text
  }
  return { status: res.status, body };
}

const compare = (config: Extract<NodeConfig<"condition">, { mode: "compare" }>) => {
  const left = config.left.trim().toLowerCase();
  const right = config.right.trim().toLowerCase();
  switch (config.operator) {
    case "equals":
      return left === right;
    case "not_equals":
      return left !== right;
    case "contains":
      return left.includes(right);
    case "is_empty":
      return left === "";
    case "is_not_empty":
      return left !== "";
    case "greater_than":
    case "less_than": {
      const [a, b] = [Number(left), Number(right)];
      if (left === "" || right === "" || Number.isNaN(a) || Number.isNaN(b))
        throw new StepError(`"${config.left}" and "${config.right}" must both be numbers`);
      return config.operator === "greater_than" ? a > b : a < b;
    }
  }
};

const YES_NO_PROMPT =
  "You decide one yes/no question for an automated business workflow, from the data the workflow has collected so far. " +
  "Answer with YES or NO as the first word, then at most one sentence of reason. If the data does not clearly support yes, answer NO.";

export const handlers: Handlers = {
  async trigger(_config, run) {
    return { output: run.data.trigger };
  },

  async ai_employee(config, run) {
    // A turn cannot be deduplicated: the employee may have used tools before the runner died.
    if (run.interrupted)
      throw new StepError("This step was interrupted while the employee was answering and may have used tools. Check its conversations, then retry.");
    const employee = await liveEmployee(run, config.employeeId, config.customer);
    const { deps } = run;
    let provider: AIProvider;
    let embedder: EmbeddingProvider | undefined;
    try {
      provider = deps.provider({ ...run.scope, employeeId: config.employeeId, workflowId: run.workflowId, task: "chat" });
      if (employee.knowledgeSources.length > 0) embedder = deps.embedder();
    } catch (err) {
      throw aiFailed(err);
    }
    const memory = deps.memory(run.scope);
    const customerId = config.customer ? await memory.identify(run.scope, config.customer) : undefined;
    const specs = toolRegistry.specs(employee.tools.map((t) => t.tool));
    for await (const event of runTurn({
      provider,
      ...run.scope,
      employeeId: employee.id,
      userId: "workflow",
      employee: configOf(employee.publishedVersion),
      employeeVersion: employee.publishedVersion.number,
      knowledge: embedder && { embedder, sourceIds: employee.knowledgeSources.map((k) => k.sourceId) },
      customer: customerId ? { id: customerId, memory, onError: (err) => deps.onError(err, "customer memory") } : undefined,
      tools: specs.length > 0 ? { executor: deps.tools, specs } : undefined,
      channel: "workflow",
      userMessage: config.message,
      timeoutMs: deps.timeoutMs,
      onHandoff: deps.onHandoff,
      planLimits: deps.planLimits,
    })) {
      if (event.type === "error") throw new StepError(event.message);
      if (event.type === "done")
        return { output: { reply: event.messages[1].content, conversationId: event.conversation.id, handedOff: Boolean(event.handoff) } };
    }
    throw new StepError("The employee did not answer");
  },

  async condition(config, run) {
    if (config.mode === "compare") {
      const result = compare(config);
      return { output: { result }, branch: result ? "yes" : "no" };
    }
    let text = "";
    try {
      const data = JSON.stringify(run.data, null, 1).slice(0, 30_000);
      for await (const event of run.deps.provider({ ...run.scope, workflowId: run.workflowId, task: "workflow" }).stream({
        system: YES_NO_PROMPT,
        messages: [{ role: "user", content: `Question: ${config.question}\n\nWorkflow data (JSON):\n${data}` }],
        signal: AbortSignal.timeout(run.deps.timeoutMs),
      }))
        if (event.type === "text") text += event.text;
    } catch (err) {
      throw aiFailed(err);
    }
    const answer = /^\W*(yes|no)\b/i.exec(text)?.[1]?.toLowerCase();
    if (!answer) throw new StepError("The model did not answer yes or no");
    return { output: { result: answer === "yes", answer: text.trim().slice(0, 500) }, branch: answer === "yes" ? "yes" : "no" };
  },

  async tool(config, run) {
    const employee = await prisma.aiEmployee.findFirst({
      where: { id: config.employeeId, ...run.scope },
      include: { publishedVersion: true, versions: { orderBy: { number: "desc" }, take: 1 } },
    });
    const version = employee?.publishedVersion ?? employee?.versions[0];
    if (!version) throw new StepError("The employee no longer exists");
    // The executor checks the employee's grant, validates the input and writes the audit row.
    // The run id stands in for a conversation id on the audit row and anything the tool creates.
    // The audit row id is the step's key: a step run again reuses the recorded outcome, and the
    // webhook tool sends the same idempotency key.
    const id = `wf:${run.idempotencyKey}`;
    const earlier = await prisma.toolExecution.findFirst({ where: { id, ...run.scope } });
    const outcome = earlier
      ? { isError: earlier.status !== "SUCCEEDED", content: JSON.stringify(earlier.status === "SUCCEEDED" ? earlier.output : { error: earlier.error }) }
      : (
          await run.deps.tools.execute(
            { id, name: config.tool, input: config.input },
            {
              ...run.scope,
              employeeId: version.employeeId,
              conversationId: run.executionId,
              timezone: configOf(version).workingHours.timezone,
              executionId: id,
            },
            AbortSignal.timeout(5 * 60_000),
          )
        ).result;
    const result = JSON.parse(outcome.content) as Record<string, unknown>;
    if (outcome.isError) throw new StepError(String(result.error ?? `${config.tool} failed`));
    // A booking that found the slot taken did not do the job; the steps after it assume it did.
    if (result.status === "conflict") throw new StepError(`${config.tool}: that time is taken (${JSON.stringify(result.busy)})`);
    return { output: result };
  },

  async http_request(config, run) {
    const hasBody = config.method !== "GET" && config.method !== "DELETE" && config.body !== "";
    const headers: Record<string, string> = Object.fromEntries(config.headers.map((h) => [h.key, h.value]));
    // Servers that honour it ignore the repeat when the step is run again; a header set in the step wins.
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "idempotency-key")) headers["idempotency-key"] = run.idempotencyKey;
    return { output: await request(run, config.url, { method: config.method, headers, body: hasBody ? config.body : undefined, redirect: "manual" }) };
  },

  async webhook(config, run) {
    const { status } = await request(run, config.url, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": run.idempotencyKey },
      body: JSON.stringify({ workflowId: run.workflowId, executionId: run.executionId, ...run.data }),
      redirect: "manual",
    });
    return { output: { status } };
  },

  async wait(config, run) {
    const until = typeof run.state?.until === "string" ? new Date(run.state.until) : new Date(Date.now() + config.amount * UNIT_MS[config.unit]);
    if (Date.now() >= until.getTime()) return { output: { waitedUntil: until.toISOString() } };
    return { wait: { until, state: { until: until.toISOString() } } };
  },

  async voice_call(config, run) {
    const poll = () => new Date(Date.now() + run.deps.callPollMs);
    const callId = typeof run.state?.callId === "string" ? run.state.callId : null;
    if (!callId) {
      const placed = await run.deps.placeCall({
        ...run.scope,
        employeeId: config.employeeId,
        to: config.to,
        greeting: config.greeting || undefined,
        idempotencyKey: run.idempotencyKey,
        workflowId: run.workflowId,
      });
      return { wait: { until: poll(), state: { callId: placed.callId, placedAt: new Date().toISOString() } } };
    }
    const call = await prisma.call.findFirst({
      where: { id: callId, ...run.scope },
      include: { transcript: { orderBy: { offsetMs: "asc" } } },
    });
    if (!call) throw new StepError("The call no longer exists");
    if (!ENDED_STATUSES.includes(call.status)) {
      if (Date.now() - new Date(String(run.state?.placedAt)).getTime() > CALL_GIVE_UP_MS) throw new StepError("The call did not end in time");
      return { wait: { until: poll(), state: run.state ?? {} } };
    }
    const transcript = call.transcript.map((t) => `${t.speaker === "CUSTOMER" ? "Customer" : "Employee"}: ${t.text}`).join("\n");
    return { output: { callId, status: call.status, durationSec: call.durationSec, transcript, customerId: call.customerId } };
  },

  // Email through the server's mailer (Resend); test mode without one: nothing is delivered, the message is kept on the step.
  // The step's idempotency key goes to the provider, so a step run again after a crash does not send twice.
  async message(config, run) {
    if (!z.email().safeParse(config.to).success) throw new StepError(`"${config.to}" is not an email address`);
    let testMode = run.deps.mailer === null;
    let messageId = run.idempotencyKey;
    if (run.deps.mailer)
      try {
        const sent = await run.deps.mailer.send(
          { to: config.to, subject: config.subject, text: config.body, idempotencyKey: run.idempotencyKey },
          { ...run.scope, workflowId: run.workflowId },
        );
        messageId = sent.messageId;
        testMode = sent.testMode ?? false;
      } catch (err) {
        throw err instanceof ToolError ? new StepError(err.message) : err;
      }
    return { output: { status: "sent", testMode, messageId, channel: config.channel, to: config.to, subject: config.subject, body: config.body } };
  },

  async crm_update(config, run) {
    if (!config.customer) throw new StepError("The customer's email or phone is empty");
    const facts = config.fields.map((f) => {
      const key = f.key.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      if (!/^[a-z][a-z0-9_]{0,49}$/.test(key)) throw new StepError(`"${f.key}" is not a usable field name`);
      // Identity fields also fill the customer's profile card.
      const category = ["name", "email", "phone", "company"].includes(key) ? ("identity" as const) : ("lead" as const);
      return { category, key, value: f.value.slice(0, 500) };
    });
    const customerId = await identifyCustomer(run.scope, config.customer);
    await prisma.$transaction(factWrites(customerId, facts, null));
    return { output: { customerId, updated: Object.fromEntries(facts.map((f) => [f.key, f.value])) } };
  },

  async human_handoff(config, run) {
    if (typeof run.state?.resumedBy === "string")
      return { output: { note: config.note, conversationId: config.conversationId || null, resumedBy: run.state.resumedBy, resumedAt: run.state.resumedAt } };
    // With a conversation, it also goes to the agents' inbox. Run again after a crash, the conversation is already with people and nothing changes.
    if (config.conversationId) {
      const conversation = await prisma.conversation.findFirst({ where: { id: config.conversationId, ...run.scope }, select: { id: true, organizationId: true, workspaceId: true } });
      if (!conversation) throw new StepError(`Conversation "${config.conversationId}" not found`);
      const request = { trigger: "workflow_condition" as const, reason: `Workflow: ${config.note}`.slice(0, 500) };
      const started = await startHandoff(conversation, request);
      if (started) await notifyHandoff(run, started.id, conversation.id, started.employeeId, request);
    }
    return { wait: { until: null, state: { note: config.note, conversationId: config.conversationId || null } } };
  },

  async end() {
    return { output: null };
  },
};
