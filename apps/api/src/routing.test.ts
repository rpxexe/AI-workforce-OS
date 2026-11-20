// Phase 13: model routing and BYOAI. The router is tested on its own with fake providers (fallback, limits,
// ordering, bounded attempts), then end to end through the API with the database: keys sealed and never
// returned, policies, test chat answered by the policy's models, and usage records naming who answered.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  AIProviderError,
  createRouter,
  type AIProvider,
  type CompletionRequest,
  type ProviderEvent,
  type ProviderSettings,
  type RoutePlan,
  type RouteTarget,
  type UsageRecord,
} from "@workforce/ai-provider";
import { prisma } from "@workforce/database";
import { defaultEmployeeConfig, type AiCredential, type AiSettings, type AiUsageSummary, type ConversationDetail, type EmployeeDetail, type Workspace } from "@workforce/shared";
import { openCredentials } from "@workforce/providers";
import { openKey, sealKey } from "./ai.ts";
import { buildApp } from "./app.ts";
import { adminOf, deleteOrgs, headerAuth, memberOf, newOrg } from "./testing.ts";

// ---- The router alone ----

type Behaviour = "ok" | ProviderEvent | AIProviderError | "text-then-fail" | "hang";

/** A provider that does what it is told, and counts its calls. */
const fakeModel = (name: string, model: string, behave: Behaviour = "ok") => {
  const calls: CompletionRequest[] = [];
  const provider: AIProvider = {
    name,
    model,
    async *stream(request) {
      calls.push(request);
      if (behave instanceof AIProviderError) throw behave;
      if (behave === "hang") await new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      yield { type: "text", text: `from ${model}` };
      if (behave === "text-then-fail") throw new AIProviderError("unavailable", "broke mid-reply");
      yield typeof behave === "object" ? behave : { type: "done", inputTokens: 1000, outputTokens: 100 };
    },
  };
  return { provider, calls };
};

const target = (provider: AIProvider, extra: Partial<RouteTarget> = {}): RouteTarget => ({ provider, kind: provider.name, credentialId: null, ...extra });
const plan = (targets: RouteTarget[], extra: Partial<RoutePlan> = {}): RoutePlan => ({ targets, maxCostUsd: null, timeoutMs: null, allowedProviders: [], strategy: "ordered", ...extra });
const request = (extra: Partial<CompletionRequest> = {}): CompletionRequest => ({
  system: "Be brief.",
  messages: [{ role: "user", content: "Hello" }],
  signal: AbortSignal.timeout(5000),
  ...extra,
});
const route = { organizationId: "org_router", task: "chat" };

/** Runs one request through a router over `routePlan`; returns the events or the error, and the usage records. */
const run = async (routePlan: RoutePlan, req = request(), given?: ReturnType<typeof createRouter>) => {
  const records: UsageRecord[] = [];
  const router = given ?? createRouter({ plan: async () => routePlan, record: (u) => records.push(u) });
  const events: ProviderEvent[] = [];
  try {
    for await (const event of router.provider(route).stream(req)) events.push(event);
    return { events, records, error: null, done: events.at(-1) as Extract<ProviderEvent, { type: "done" }> };
  } catch (err) {
    return { events, records, error: err as Error, done: undefined };
  }
};

const unavailable = () => new AIProviderError("unavailable", "down");
const info = (extra: Partial<NonNullable<RouteTarget["info"]>> = {}) => ({ id: "m", contextTokens: null, inputPricePerM: null, outputPricePerM: null, tools: true, ...extra });

test("router: falls back before any text, records each attempt, and names the model that answered", async () => {
  const a = fakeModel("anthropic", "claude-opus-5-5", unavailable());
  const b = fakeModel("openai", "gpt-x");
  const { events, records, done, error } = await run(plan([target(a.provider), target(b.provider)]));
  assert.equal(error, null);
  assert.deepEqual(events[0], { type: "text", text: "from gpt-x" });
  assert.equal(done?.provider, "openai");
  assert.equal(done?.model, "gpt-x");
  assert.deepEqual(
    records.map((r) => [r.attempt, r.provider, r.model, r.success, r.errorKind]),
    [
      [1, "anthropic", "claude-opus-5-5", false, "unavailable"],
      [2, "openai", "gpt-x", true, null],
    ],
  );
  assert.equal(new Set(records.map((r) => r.requestId)).size, 1);
  assert.equal(records[1]?.inputTokens, 1000);
});

test("router: never falls back after text reached the caller, nor on a refusal", async () => {
  const b = fakeModel("openai", "gpt-x");
  const midReply = await run(plan([target(fakeModel("a", "a1", "text-then-fail").provider), target(b.provider)]));
  assert.match(midReply.error?.message ?? "", /broke mid-reply/);
  assert.deepEqual(midReply.events, [{ type: "text", text: "from a1" }]);
  assert.equal(b.calls.length, 0);

  const refused = await run(plan([target(fakeModel("a", "a1", new AIProviderError("refused", "no")).provider), target(b.provider)]));
  assert.equal((refused.error as AIProviderError).kind, "refused");
  assert.equal(b.calls.length, 0);
  assert.equal(refused.records.length, 1);
});

test("router: attempts are bounded, each model at most once (no loops)", async () => {
  const failing = Array.from({ length: 5 }, (_, i) => fakeModel("p", `m${i}`, unavailable()));
  const first = failing[0]!;
  // The first model listed twice is still tried once.
  const { records, error } = await run(plan([target(first.provider), target(first.provider), ...failing.slice(1).map((f) => target(f.provider))]));
  assert.equal((error as AIProviderError).kind, "unavailable");
  assert.deepEqual(records.map((r) => r.model), ["m0", "m1", "m2"]);
  assert.equal(first.calls.length, 1);
  assert.deepEqual(failing.map((f) => f.calls.length), [1, 1, 1, 0, 0]);
});

test("router: the policy timeout moves on to the next model; the caller cancelling does not", async () => {
  const slow = fakeModel("p", "slow", "hang");
  const quick = fakeModel("p", "quick");
  const timed = await run(plan([target(slow.provider), target(quick.provider)], { timeoutMs: 50 }));
  assert.equal(timed.done?.model, "quick");
  assert.equal(timed.records[0]?.errorKind, "timeout");
  assert.match(timed.records[0]?.error ?? "", /did not answer within 50 ms/);

  const caller = new AbortController();
  setTimeout(() => caller.abort(), 30);
  const cancelled = await run(plan([target(fakeModel("p", "slow2", "hang").provider), target(quick.provider)]), request({ signal: caller.signal }));
  assert.ok(cancelled.error);
  assert.equal(quick.calls.length, 1, "not tried again after the caller left");
  assert.equal(cancelled.records[0]?.errorKind, "cancelled");
});

test("router: capability, context, cost and allowed providers rule models out, with reasons", async () => {
  const noTools = fakeModel("gemini", "flash");
  const small = fakeModel("openai", "small");
  const pricey = fakeModel("anthropic", "claude-fable-5-2");
  const unknownPrice = fakeModel("openrouter", "auto");
  const cheap = fakeModel("anthropic", "claude-haiku-5-5");
  const tools = [{ name: "calendar_book_meeting", description: "Books", inputSchema: { type: "object" } }];
  const targets = [
    target(noTools.provider, { info: info({ tools: false }) }),
    target(small.provider, { info: info({ contextTokens: 1000 }) }),
    target(pricey.provider, { info: info({ inputPricePerM: 8, outputPricePerM: 40 }) }),
    target(unknownPrice.provider),
    target(cheap.provider, { info: info({ inputPricePerM: 0.1, outputPricePerM: 0.5 }) }),
  ];
  // About 1000 input tokens: small's context is too small; fable costs ~$0.05 > $0.01.
  const long = request({ tools, messages: [{ role: "user", content: "x".repeat(4000) }] });
  const { done, records } = await run(plan(targets, { maxCostUsd: 0.01 }), long);
  assert.equal(done?.model, "claude-haiku-5-5");
  assert.equal(records.length, 1);
  // Estimated from the price list: 1000 in, 100 out at $0.10 / $0.50 per million.
  assert.ok(Math.abs((records[0]?.costUsd ?? 0) - (1000 * 0.1 + 100 * 0.5) / 1e6) < 1e-12);

  const none = await run(plan(targets, { maxCostUsd: 0.01, allowedProviders: ["openai", "gemini", "openrouter"] }), long);
  assert.equal((none.error as AIProviderError).kind, "config");
  assert.match(none.error?.message ?? "", /flash: cannot call tools/);
  assert.match(none.error?.message ?? "", /small: context too small/);
  assert.match(none.error?.message ?? "", /auto: price unknown/);
  assert.match(none.error?.message ?? "", /claude-fable-5-2: provider not allowed/);
  assert.deepEqual(
    none.records.map((r) => [r.provider, r.success, r.errorKind]),
    [["none", false, "config"]],
  );
});

test("router: cheapest and fastest orders; a model that just failed goes last; provider-reported cost wins", async () => {
  const dear = fakeModel("anthropic", "dear");
  const cheap = fakeModel("anthropic", "cheap", { type: "done", inputTokens: 10, outputTokens: 10, costUsd: 0.5 });
  const priced = [target(dear.provider, { info: info({ inputPricePerM: 10, outputPricePerM: 10 }) }), target(cheap.provider, { info: info({ inputPricePerM: 1, outputPricePerM: 1 }) })];
  const cheapest = await run(plan(priced, { strategy: "cheapest" }));
  assert.equal(cheapest.done?.model, "cheap");
  assert.equal(cheapest.done?.costUsd, 0.5);
  assert.equal(cheapest.records[0]?.costUsd, 0.5);

  // One router across requests: it remembers latency and failures.
  const records: UsageRecord[] = [];
  let flaky = true;
  const shaky: AIProvider = {
    name: "p",
    model: "shaky",
    async *stream() {
      if (flaky) throw unavailable();
      yield { type: "done", inputTokens: 1, outputTokens: 1 };
    },
  };
  const steady = fakeModel("p", "steady");
  const router = createRouter({ plan: async () => plan([target(shaky), target(steady.provider)]), record: (u) => records.push(u) });
  assert.equal((await run(plan([]), request(), router)).done?.model, "steady");
  flaky = false;
  // shaky failed a moment ago: steady is tried first now, although shaky is listed first.
  assert.equal((await run(plan([]), request(), router)).done?.model, "steady");

  const slowOk: AIProvider = {
    name: "p",
    model: "slow",
    async *stream() {
      await new Promise((r) => setTimeout(r, 40));
      yield { type: "done", inputTokens: 1, outputTokens: 1 };
    },
  };
  const fast = fakeModel("p", "fast");
  const timing = createRouter({ plan: async () => plan([target(slowOk), target(fast.provider)], { strategy: "fastest" }), record: () => {} });
  // Nothing measured: the listed order. Then the unmeasured model gets its turn, and from then on the faster one leads.
  assert.equal((await run(plan([]), request(), timing)).done?.model, "slow");
  assert.equal((await run(plan([]), request(), timing)).done?.model, "fast");
  assert.equal((await run(plan([]), request(), timing)).done?.model, "fast");
});

test("keys are sealed with AES-256-GCM and open only with the same secret", () => {
  const secret = "s".repeat(40);
  const sealed = sealKey("sk-live-abcdef123456", secret);
  assert.ok(!sealed.includes("abcdef"));
  assert.notEqual(sealKey("sk-live-abcdef123456", secret), sealed, "a fresh IV each time");
  assert.equal(openKey(sealed, secret), "sk-live-abcdef123456");
  assert.throws(() => openKey(sealed, "t".repeat(40)));
});

// ---- Through the API ----

const orgA = newOrg();
const orgB = newOrg();
const SECRET = "test-credentials-secret-0123456789abcdef";
let app: Awaited<ReturnType<typeof buildApp>>;
let wsA: string;
let employeeId: string;

const platformModel: AIProvider = {
  name: "fake",
  model: "fake-1",
  async *stream() {
    yield { type: "text", text: "Platform reply" };
    yield { type: "done", inputTokens: 50, outputTokens: 5 };
  },
};
/** What the organization's own Anthropic key does, and the keys and models it was built with. */
let byoBehaviour: "ok" | "rate_limit" = "ok";
const byoBuilt: { kind: string; settings: ProviderSettings }[] = [];
const byoProvider = (kind: string, settings: ProviderSettings): AIProvider => {
  byoBuilt.push({ kind, settings });
  return {
    name: kind,
    model: settings.model ?? "",
    async *stream() {
      if (byoBehaviour === "rate_limit") throw new AIProviderError("rate_limit", "slow down");
      yield { type: "text", text: "Own key reply" };
      yield { type: "done", inputTokens: 1000, outputTokens: 200, provider: kind, model: settings.model };
    },
  };
};

type Headers = Record<string, string>;
const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, headers: Headers, payload?: object) => app.inject({ method, url, headers, payload });
const chat = async (message: string) => {
  const res = await call("POST", `/workspaces/${wsA}/employees/${employeeId}/messages`, adminOf(orgA), { message });
  const done = res.payload
    .split("\n\n")
    .filter(Boolean)
    .map((f) => JSON.parse(f.replace(/^data: /, "")) as { type: string; conversation?: { id: string } })
    .find((e) => e.type === "done");
  assert.ok(done?.conversation, res.payload);
  return (await call("GET", `/workspaces/${wsA}/employees/${employeeId}/conversations/${done.conversation.id}`, adminOf(orgA))).json<ConversationDetail>();
};
/** Usage rows are written in the background. */
const usageRows = async (count: number) => {
  for (let i = 0; i < 50; i++) {
    const rows = await prisma.aiUsage.findMany({ where: { organizationId: orgA }, orderBy: [{ createdAt: "asc" }, { attempt: "asc" }] });
    if (rows.length >= count) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Expected ${count} usage rows`);
};

before(async () => {
  app = await buildApp({ authenticate: headerAuth, provider: platformModel, credentialsKey: SECRET, byoProvider, logger: false });
  for (const org of [orgA, orgB]) await call("GET", "/workspaces", adminOf(org));
  wsA = (await call("GET", "/workspaces", adminOf(orgA))).json<Workspace[]>()[0]!.id;
  const created = await call("POST", `/workspaces/${wsA}/employees`, adminOf(orgA), { ...defaultEmployeeConfig(), name: "Ava", role: "Support", systemInstructions: "Be brief." });
  employeeId = created.json<EmployeeDetail>().id;
});
after(async () => {
  await deleteOrgs(orgA, orgB);
  await app.close();
});

test("BYOAI: keys are admin-only, validated, sealed at rest and never returned", async () => {
  const key = { name: "Team Anthropic", kind: "anthropic", apiKey: "sk-ant-secret-WXYZ" };
  assert.equal((await call("POST", "/ai/credentials", memberOf(orgA), key)).statusCode, 403);
  assert.equal((await call("POST", "/ai/credentials", adminOf(orgA), { ...key, kind: "openai_compatible" })).statusCode, 400, "custom needs a base URL");
  assert.equal((await call("POST", "/ai/credentials", adminOf(orgA), { ...key, baseUrl: "https://x.example.com" })).statusCode, 400, "only custom takes one");
  const local = await call("POST", "/ai/credentials", adminOf(orgA), { ...key, name: "Local", kind: "openai_compatible", baseUrl: "https://127.0.0.1:8080/v1" });
  assert.equal(local.statusCode, 400);
  assert.match(local.json<{ error: string }>().error, /private address/);
  assert.equal((await call("POST", "/ai/credentials", adminOf(orgA), { ...key, baseUrl: "http://api.example.com" })).statusCode, 400);

  const res = await call("POST", "/ai/credentials", adminOf(orgA), { ...key, models: [{ id: "claude-opus-5-5" }] });
  assert.equal(res.statusCode, 201);
  assert.ok(!res.payload.includes("sk-ant-secret"), "the key never comes back");
  const credential = res.json<AiCredential>();
  assert.equal(credential.keyHint, "…WXYZ");
  assert.equal((await call("POST", "/ai/credentials", adminOf(orgA), key)).statusCode, 409, "names are unique");

  // Phase 14: keys are "llm" provider connections, sealed as JSON.
  const row = await prisma.providerConnection.findUniqueOrThrow({ where: { id: credential.id } });
  assert.ok(!row.encryptedCredentials.includes("sk-ant-secret"));
  assert.equal(openCredentials(row.encryptedCredentials, { current: SECRET }).credentials.apiKey, "sk-ant-secret-WXYZ");

  const settings = await call("GET", "/ai/settings", memberOf(orgA));
  assert.ok(!settings.payload.includes("sk-ant-secret") && !settings.payload.includes(row.encryptedCredentials));
  assert.equal(settings.json<AiSettings>().credentials.length, 1);
  assert.deepEqual(settings.json<AiSettings>().platform, { provider: "fake", model: "fake-1" });

  // A blank key keeps the stored one; the provider cannot change.
  const renamed = await call("PUT", `/ai/credentials/${credential.id}`, adminOf(orgA), { name: "Anthropic", kind: "anthropic", apiKey: "" });
  assert.equal(renamed.json<AiCredential>().keyHint, "…WXYZ");
  assert.equal((await call("PUT", `/ai/credentials/${credential.id}`, adminOf(orgA), { name: "A", kind: "openai", apiKey: "" })).statusCode, 400);

  // Other organizations see nothing and touch nothing.
  assert.equal((await call("GET", "/ai/settings", adminOf(orgB))).json<AiSettings>().credentials.length, 0);
  assert.equal((await call("PUT", `/ai/credentials/${credential.id}`, adminOf(orgB), { name: "x", kind: "anthropic" })).statusCode, 404);
  assert.equal((await call("DELETE", `/ai/credentials/${credential.id}`, adminOf(orgB))).statusCode, 404);
});

test("BYOAI: without AI_CREDENTIALS_KEY the server refuses to store keys", async () => {
  const keyless = await buildApp({ authenticate: headerAuth, provider: platformModel, credentialsKey: null, logger: false });
  try {
    const res = await keyless.inject({ method: "POST", url: "/ai/credentials", headers: adminOf(orgA), payload: { name: "K", kind: "openai", apiKey: "sk-12345678" } });
    assert.equal(res.statusCode, 503);
    assert.match(res.json<{ error: string }>().error, /AI_CREDENTIALS_KEY/);
    assert.equal((await keyless.inject({ method: "GET", url: "/ai/settings", headers: adminOf(orgA) })).json<AiSettings>().canStoreKeys, false);
  } finally {
    await keyless.close();
  }
});

test("routing: test chat follows the chat policy, falls back to the platform, and records who answered", async () => {
  const credential = (await call("GET", "/ai/settings", adminOf(orgA))).json<AiSettings>().credentials[0]!;
  // No policy yet: the platform's provider answers, as before.
  const first = await chat("Hi");
  assert.equal(first.messages[1]?.model, "fake-1");

  const policy = {
    primary: { credentialId: credential.id, model: "claude-opus-5-5" },
    fallbacks: [{ credentialId: null, model: "fake-1" }],
    timeoutMs: 20_000,
  };
  assert.equal((await call("PUT", "/ai/policies/chat", memberOf(orgA), policy)).statusCode, 403);
  const otherKey = await call("POST", "/ai/credentials", adminOf(orgB), { name: "B", kind: "openai", apiKey: "sk-b-12345678" });
  const foreign = { ...policy, primary: { credentialId: otherKey.json<AiCredential>().id, model: "gpt-x" } };
  assert.equal((await call("PUT", "/ai/policies/chat", adminOf(orgA), foreign)).statusCode, 400, "another organization's key is unknown");
  assert.equal((await call("PUT", "/ai/policies/nope", adminOf(orgA), policy)).statusCode, 400);
  const saved = await call("PUT", "/ai/policies/chat", adminOf(orgA), policy);
  assert.equal(saved.statusCode, 200, saved.payload);

  const own = await chat("Hello again");
  assert.equal(own.messages[1]?.content, "Own key reply");
  assert.equal(own.messages[1]?.model, "claude-opus-5-5");
  const built = byoBuilt.at(-1);
  assert.equal(built?.kind, "anthropic");
  assert.equal(built?.settings.apiKey, "sk-ant-secret-WXYZ", "the provider got the opened key");

  byoBehaviour = "rate_limit";
  const fellBack = await chat("And again");
  assert.equal(fellBack.messages[1]?.content, "Platform reply");
  assert.equal(fellBack.messages[1]?.model, "fake-1");
  byoBehaviour = "ok";

  const rows = await usageRows(4);
  assert.deepEqual(
    rows.map((r) => [r.task, r.attempt, r.provider, r.model, r.credentialId, r.success, r.errorKind]),
    [
      ["chat", 1, "fake", "fake-1", null, true, null],
      ["chat", 1, "anthropic", "claude-opus-5-5", credential.id, true, null],
      ["chat", 1, "anthropic", "claude-opus-5-5", credential.id, false, "rate_limit"],
      ["chat", 2, "fake", "fake-1", null, true, null],
    ],
  );
  assert.equal(rows[0]?.workspaceId, wsA);
  // Estimated from Anthropic's price list: 1000 in, 200 out at $4 / $20 per million.
  assert.ok(Math.abs((rows[1]?.costUsd ?? 0) - 0.008) < 1e-12);
  assert.equal(rows[0]?.costUsd, null, "the platform fake has no known price");

  const usage = (await call("GET", "/ai/usage?days=7", memberOf(orgA))).json<AiUsageSummary>();
  assert.equal(usage.totals.calls, 4);
  assert.equal(usage.totals.failures, 1);
  assert.equal(usage.totals.fallbacks, 1);
  assert.ok(Math.abs(usage.totals.costUsd - 0.008) < 1e-12);
  assert.deepEqual(usage.byModel.map((g) => [g.provider, g.model, g.calls, g.failures]).sort(), [
    ["anthropic", "claude-opus-5-5", 2, 1],
    ["fake", "fake-1", 2, 0],
  ]);
  assert.equal(usage.recent.length, 4);
  assert.ok(!("organizationId" in usage.recent[0]!));
  assert.equal((await call("GET", "/ai/usage", adminOf(orgB))).json<AiUsageSummary>().totals.calls, 0, "isolated");

  // A key a policy uses cannot be deleted.
  const del = await call("DELETE", `/ai/credentials/${credential.id}`, adminOf(orgA));
  assert.equal(del.statusCode, 409);
  assert.match(del.json<{ error: string }>().error, /chat/);
});

test("routing: the default policy covers tasks without their own; limits no model meets fail the turn clearly", async () => {
  assert.equal((await call("DELETE", "/ai/policies/chat", adminOf(orgA))).statusCode, 204);
  const settings = (await call("GET", "/ai/settings", adminOf(orgA))).json<AiSettings>();
  assert.equal(settings.policies.length, 0);
  const credential = settings.credentials[0]!;
  await call("PUT", "/ai/policies/default", adminOf(orgA), { primary: { credentialId: credential.id, model: "claude-sonnet-5-5" } });
  assert.equal((await chat("Default please")).messages[1]?.model, "claude-sonnet-5-5");

  // Only OpenAI allowed, but the only model is Anthropic's: nothing can answer, and the turn says why.
  await call("PUT", "/ai/policies/chat", adminOf(orgA), { primary: { credentialId: credential.id, model: "claude-sonnet-5-5" }, allowedProviders: ["openai"] });
  const res = await call("POST", `/workspaces/${wsA}/employees/${employeeId}/messages`, adminOf(orgA), { message: "Blocked" });
  assert.match(res.payload, /"type":"error"/);
  assert.match(res.payload, /not configured correctly/);
  const last = (await usageRows(6)).at(-1);
  assert.equal(last?.provider, "none");
  assert.match(last?.error ?? "", /provider not allowed/);

  await call("DELETE", "/ai/policies/chat", adminOf(orgA));
  await call("DELETE", "/ai/policies/default", adminOf(orgA));
  assert.equal((await call("DELETE", `/ai/credentials/${credential.id}`, adminOf(orgA))).statusCode, 204);
});
