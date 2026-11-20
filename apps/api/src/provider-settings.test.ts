// Phase 14: universal provider settings. The registry, sealing and redaction, fallback across connections (speech, email)
// with Phase 13's loop rules, then end to end through the API and the database: connections (encrypted, masked, validated,
// isolated), test connection (rate limit, duplicate presses, timeouts), rotation, defaults, deletion, resolution
// (workflow > employee > organization default > platform) for language models and speech, per-connection telephony
// webhooks, SSRF on typed addresses, usage and metrics, and the Phase 13 key migration.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { AIProviderError, type AIProvider, type ProviderSettings as LlmSettings } from "@workforce/ai-provider";
import type { ChannelSender } from "@workforce/channels";
import { prisma } from "@workforce/database";
import {
  fallbackEmail,
  fallbackSTT,
  fallbackTTS,
  firstThatWorks,
  openCredentials,
  redact,
  REGISTRY,
  registryEntry,
  scrubSecrets,
  sealCredentials,
  sealKey,
  testConnection,
  type AttemptRecord,
  type Conn,
  type Target,
} from "@workforce/providers";
import {
  defaultEmployeeConfig,
  PROVIDER_CATALOG,
  PROVIDER_TYPES,
  ProviderError,
  type AiCredential,
  type EmployeeDetail,
  type ProviderConnectionInfo,
  type ProviderMetric,
  type ProviderSettings,
  type TestConnectionResult,
  type Workspace,
} from "@workforce/shared";
import type { STTEvent, STTProvider } from "@workforce/stt";
import { twilioSignature, type TelephonyProvider } from "@workforce/telephony";
import { resolver, safeFetch } from "@workforce/tools";
import type { TTSProvider } from "@workforce/tts";
import { planFor, type Platform } from "./ai.ts";
import { buildApp } from "./app.ts";
import { adminOf, deleteOrgs, headerAuth, memberOf, newOrg } from "./testing.ts";

const SECRET = "test-credentials-secret-0123456789abcdef";

// ---- Registry ----

test("registry: every supported catalog entry has an adapter and a test, nothing coming soon can be built, two or more per category", () => {
  for (const meta of PROVIDER_CATALOG) {
    const entry = registryEntry(meta.type, meta.id);
    if (meta.status === "supported") assert.ok(entry, `${meta.type}/${meta.id} is marked supported but has no adapter`);
    else assert.equal(entry, null, `${meta.type}/${meta.id} is coming soon but buildable`);
  }
  for (const type of PROVIDER_TYPES) {
    for (const id of Object.keys(REGISTRY[type])) assert.ok(PROVIDER_CATALOG.some((p) => p.type === type && p.id === id), `${type}/${id} has no catalog entry`);
    assert.ok(PROVIDER_CATALOG.filter((p) => p.type === type && p.status === "supported").length >= 2, `${type} has fewer than two providers`);
  }
  const ids = (type: string) => PROVIDER_CATALOG.filter((p) => p.type === type && p.status === "supported").map((p) => p.id);
  for (const llm of ["groq", "mistral", "deepseek", "xai", "together", "fireworks", "huggingface"]) assert.ok(ids("llm").includes(llm), llm);
  assert.deepEqual(
    PROVIDER_CATALOG.filter((p) => p.status === "coming_soon").map((p) => p.id),
    ["plivo", "vonage", "sip"],
  );
  // Live phone-call recognition is a capability: transcribe-only providers cannot take calls.
  assert.deepEqual(PROVIDER_CATALOG.filter((p) => p.type === "stt" && p.capabilities.includes("live")).map((p) => p.id), ["deepgram", "assemblyai"]);
});

// ---- Sealing and redaction ----

test("credentials are sealed with a fresh IV, open only with the server secret (or the previous one while rotating it)", () => {
  const creds = { accountSid: "AC123", authToken: "tok-very-secret-123456" };
  const sealed = sealCredentials(creds, SECRET);
  assert.ok(sealed.startsWith("v2:") && !sealed.includes("tok-very-secret"));
  assert.notEqual(sealCredentials(creds, SECRET), sealed);
  assert.deepEqual(openCredentials(sealed, { current: SECRET }), { credentials: creds, stale: false });
  assert.throws(() => openCredentials(sealed, { current: "x".repeat(40) }));
  // Rotating the server secret: the old one still opens, and says to seal again.
  assert.deepEqual(openCredentials(sealed, { current: "n".repeat(40), previous: SECRET }), { credentials: creds, stale: true });
  // Phase 13's format is a bare key.
  assert.deepEqual(openCredentials(sealKey("sk-old-key-12345678", SECRET), { current: SECRET }), { credentials: { apiKey: "sk-old-key-12345678" }, stale: true });
});

test("secrets are removed from messages, whole or in part", () => {
  assert.equal(redact("bad key sk-live-ABCDEFGHIJKL1234 for you", ["sk-live-ABCDEFGHIJKL1234"]), "bad key [redacted] for you");
  assert.ok(!redact("Incorrect API key provided: sk-live-…JKL1234", ["sk-live-ABCDEFGHIJKL1234"]).includes("JKL1234"));
  assert.equal(scrubSecrets("Authorization: Bearer abc.def-ghi_jkl"), "Authorization: Bearer [redacted]");
  assert.ok(!scrubSecrets("key AKIA1234567890ABCDEFGHIJ refused").includes("567890ABCDEF"));
  assert.equal(scrubSecrets("model gpt-4o-mini is slow"), "model gpt-4o-mini is slow");
});

// ---- Fallback across connections (Phase 13 rules for every type) ----

const failing = (kind: string) => Object.assign(new Error(`${kind} failure`), { kind });
const tgt = <T,>(key: string, value: T, provider = key): Target<T> => ({ key, provider, connectionId: key, value });

test("fallback: each target once, at most three, only for failures another provider can fix; every attempt recorded", async () => {
  const records: AttemptRecord[] = [];
  const tried: string[] = [];
  const run = (fail: Record<string, string>) => (name: string) => {
    tried.push(name);
    return fail[name] ? Promise.reject(failing(fail[name]!)) : Promise.resolve(`ok:${name}`);
  };
  // rate_limit -> next; the duplicate "a" is not tried again (no loops).
  const result = await firstThatWorks([tgt("a", "a"), tgt("a", "a"), tgt("b", "b")], "transcribe", run({ a: "rate_limit" }), (r) => records.push(r));
  assert.equal(result, "ok:b");
  assert.deepEqual(tried, ["a", "b"]);
  assert.deepEqual(records.map((r) => [r.provider, r.attempt, r.success, r.errorKind]), [["a", 1, false, "rate_limit"], ["b", 2, true, null]]);
  assert.equal(new Set(records.map((r) => r.requestId)).size, 1, "one request id across attempts");

  // Authentication and configuration errors are the admin's to fix: no fallback.
  for (const kind of ["auth", "config"]) {
    tried.length = 0;
    await assert.rejects(firstThatWorks([tgt("a", "a"), tgt("b", "b")], "x", run({ a: kind }), () => {}), new RegExp(kind));
    assert.deepEqual(tried, ["a"], `${kind} does not fall back`);
  }
  // Never more than three.
  tried.length = 0;
  await assert.rejects(firstThatWorks(["a", "b", "c", "d"].map((k) => tgt(k, k)), "x", run({ a: "unavailable", b: "unavailable", c: "unavailable", d: "unavailable" }), () => {}));
  assert.deepEqual(tried, ["a", "b", "c"]);
  // Nothing configured is a configuration error.
  await assert.rejects(firstThatWorks([], "x", run({}), () => {}), (err: Error & { kind?: string }) => err.kind === "config");
});

const speaker = (name: string, behave: "ok" | "fail-first" | "fail-after-audio" | "auth", calls: string[]): TTSProvider => ({
  name,
  synthesize(text) {
    calls.push(name);
    return (async function* () {
      if (behave === "auth") throw new ProviderError("auth", "bad key");
      if (behave === "fail-first") throw new ProviderError("unavailable", "down");
      yield Buffer.from([0xff, 0xff]);
      if (behave === "fail-after-audio") throw new ProviderError("unavailable", "broke mid-sentence");
      yield Buffer.from(text.slice(0, 1));
    })();
  },
});

test("speech synthesis falls back only before any audio was played, and records characters", async () => {
  const calls: string[] = [];
  const records: AttemptRecord[] = [];
  const read = async (tts: TTSProvider) => {
    const out: Buffer[] = [];
    for await (const chunk of tts.synthesize("Hello", { language: "en", signal: AbortSignal.timeout(1000) })) out.push(chunk);
    return Buffer.concat(out);
  };
  const tts = fallbackTTS([tgt("a", speaker("a", "fail-first", calls)), tgt("b", speaker("b", "ok", calls))], (r) => records.push(r));
  assert.equal((await read(tts)).length, 3);
  assert.deepEqual(calls, ["a", "b"]);
  assert.deepEqual(records.map((r) => [r.provider, r.success, r.characters]), [["a", false, 5], ["b", true, 5]]);

  calls.length = 0;
  await assert.rejects(read(fallbackTTS([tgt("a", speaker("a", "fail-after-audio", calls)), tgt("b", speaker("b", "ok", calls))], () => {})), /mid-sentence/);
  assert.deepEqual(calls, ["a"], "audio already reached the caller: no second voice");

  calls.length = 0;
  await assert.rejects(read(fallbackTTS([tgt("a", speaker("a", "auth", calls)), tgt("b", speaker("b", "ok", calls))], () => {})), /bad key/);
  assert.deepEqual(calls, ["a"], "auth errors do not fall back");
});

test("live recognition falls back when a stream fails before hearing anything; transcribe-only providers never take calls", async () => {
  const opened: string[] = [];
  const live = (name: string, fail: boolean): STTProvider => ({
    name,
    open({ onEvent }) {
      opened.push(name);
      if (fail) setTimeout(() => onEvent({ type: "error", error: new ProviderError("unavailable", "socket closed") }), 5);
      else setTimeout(() => onEvent({ type: "turn", text: `heard by ${name}` }), 5);
      return { send() {}, close() {} };
    },
  });
  const fileOnly: STTProvider = { name: "whisper", transcribe: async () => "text" };
  const records: AttemptRecord[] = [];
  const stt = fallbackSTT([tgt("w", fileOnly, "whisper"), tgt("a", live("a", true)), tgt("b", live("b", false))], (r) => records.push(r));
  assert.equal(stt.name, "a", "the first live provider answers calls");
  const events: STTEvent[] = [];
  const stream = stt.open!({ language: "en", onEvent: (e) => events.push(e) });
  stream.send(Buffer.alloc(8000)); // one second of 8 kHz audio
  await new Promise((r) => setTimeout(r, 40));
  stream.close();
  assert.deepEqual(events, [{ type: "turn", text: "heard by b" }], "the caller never saw the failure");
  assert.deepEqual(opened, ["a", "b"]);
  assert.deepEqual(records.map((r) => [r.provider, r.success, r.operation]), [["a", false, "live_transcribe"], ["b", true, "live_transcribe"]]);
  assert.equal(await stt.transcribe!(Buffer.from("x"), { mimeType: "audio/ogg", language: "en" }), "text");
  assert.equal(fallbackSTT([tgt("w", fileOnly, "whisper")], () => {}).open, undefined, "no live provider: no calls");
});

test("email falls back only when the provider refused for load, never when the message may have gone", async () => {
  const sent: string[] = [];
  const sender = (name: string, error?: string): ChannelSender => ({
    kind: "email",
    async send() {
      sent.push(name);
      if (error) throw Object.assign(new Error(`${name} ${error}`), { kind: error });
      return { providerMessageId: `${name}-1`, attempts: 1 };
    },
  });
  const message = { address: "a@x.com", to: "b@y.com", text: "hi" };
  assert.equal((await fallbackEmail([tgt("a", sender("a", "rate_limit")), tgt("b", sender("b"))], () => {}).send(message)).providerMessageId, "b-1");
  sent.length = 0;
  await assert.rejects(fallbackEmail([tgt("a", sender("a", "unavailable")), tgt("b", sender("b"))], () => {}).send(message));
  assert.deepEqual(sent, ["a"], "a network error or 5xx may have sent it: no second send");
});

// ---- Test Connection (adapters, fake networks) ----

/** A fake network: answers by URL; records what was asked. */
const network = (routes: [RegExp, (req: { url: string; init: RequestInit }) => Response | Promise<Response>][]) => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const http: typeof fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()) });
    const route = routes.find(([re]) => re.test(url));
    if (!route) return new Response("not found", { status: 404 });
    return route[1]({ url, init });
  };
  return { http, seen };
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const conn = (credentials: Record<string, string>, configuration: Record<string, unknown>, http: typeof fetch): Conn => ({ credentials, configuration, fetch: http, userFetch: http });

test("test connection reports auth, config, capabilities, latency and the provider's error without secrets", async () => {
  const { http, seen } = network([
    [/api\.groq\.com\/openai\/v1\/models/, () => json({ data: [{ id: "llama-4" }, { id: "qwen-3" }] })],
    [/api\.deepgram\.com\/v1\/projects/, () => json({ projects: [] })],
    // A provider that echoes the key it was given in its error.
    [/api\.elevenlabs\.io/, ({ init }) => json({ detail: `invalid api key ${new Headers(init.headers).get("xi-api-key")}` }, 401)],
    [/api\.telnyx\.com\/v2\/texml_applications\//, () => json({ errors: [{ detail: "Resource not found" }] }, 404)],
  ]);
  const groq = await testConnection("llm", "groq", conn({ apiKey: "gsk_secret_groq_key_1234" }, {}, http));
  assert.equal(groq.ok, true);
  assert.equal(groq.auth, "ok");
  assert.deepEqual(groq.models, ["llama-4", "qwen-3"]);
  assert.ok(groq.capabilities.includes("tools") && groq.latencyMs >= 0);
  assert.equal(seen[0]?.headers.authorization, "Bearer gsk_secret_groq_key_1234");

  assert.equal((await testConnection("stt", "deepgram", conn({ apiKey: "dg-key-1234567890" }, {}, http))).ok, true);

  const eleven = await testConnection("tts", "elevenlabs", conn({ apiKey: "xi-secret-elevenlabs-9999" }, {}, http));
  assert.equal(eleven.ok, false);
  assert.equal(eleven.auth, "failed");
  assert.match(eleven.error ?? "", /401/);
  assert.ok(!eleven.error?.includes("xi-secret-elevenlabs-9999") && !eleven.error?.includes("lenlabs-9999"), eleven.error ?? "");

  const telnyx = await testConnection("telephony", "telnyx", conn({ apiKey: "KEY0123456789" }, { applicationId: "missing-app" }, http));
  assert.equal(telnyx.config, "invalid", "a TeXML application that does not exist is a configuration problem");

  // A provider that never answers: a timeout, reported, not thrown.
  const hang: typeof fetch = (_url, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }))));
  const slow = await testConnection("stt", "assemblyai", conn({ apiKey: "aai-key-12345678" }, {}, hang), 50);
  assert.equal(slow.ok, false);
  assert.match(slow.error ?? "", /No answer within/);

  assert.equal((await testConnection("telephony", "plivo", conn({}, {}, http))).ok, false, "coming soon cannot be tested");
});

// ---- SSRF ----

test("typed addresses: private, loopback, metadata and rebinding hosts are refused; redirects are not followed", async () => {
  for (const url of ["https://127.0.0.1/v1", "https://10.0.0.8/v1", "https://169.254.169.254/latest/meta-data", "https://[::1]/x", "https://[::ffff:127.0.0.1]/x", "http://example.com/"])
    await assert.rejects(safeFetch(url), Error, url);
  // DNS rebinding: public for the check, private for the connection. The pinned lookup refuses it before any packet.
  const real = resolver.lookup;
  let calls = 0;
  resolver.lookup = async () => (calls++ === 0 ? [{ address: "93.184.215.14", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]);
  try {
    await assert.rejects(safeFetch("https://rebind.example.test/"), (err: Error) => /private address/.test(String((err.cause as Error)?.message ?? err.message)));
  } finally {
    resolver.lookup = real;
  }
});

// ---- End to end through the API ----

const orgA = newOrg();
const orgB = newOrg();
let app: Awaited<ReturnType<typeof buildApp>>;
let wsA: string;
let wsB: string;
let employeeId: string;
let workflowId: string;

type Headers_ = Record<string, string>;
const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, headers: Headers_, payload?: object) => app.inject({ method, url, headers, payload });

/** Every outside call the app makes through organizations' connections lands here. */
const outside: { url: string; headers: Record<string, string>; body: string }[] = [];
/** Hosts answering 429 for now. */
const limitedHosts = new Set<string>();
let testCalls = 0;
const vendorFetch: typeof fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  outside.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()), body: typeof init.body === "string" ? init.body : "" });
  if (limitedHosts.has(new URL(url).host)) return json({ error: { message: "busy" } }, 429);
  if (/deepgram\.com\/v1\/projects/.test(url)) {
    testCalls++;
    await new Promise((r) => setTimeout(r, 30)); // long enough for a second press to arrive
    return json({ projects: [] });
  }
  if (/elevenlabs\.io\/v1\/text-to-speech/.test(url)) return new Response(new Uint8Array([0x7f, 0x7f, 0x7f]));
  if (/api\.openai\.com\/v1\/audio\/speech/.test(url)) {
    // 16-bit 8 kHz WAV, two samples of silence
    const wav = Buffer.alloc(48);
    wav.write("RIFF", 0, "latin1");
    wav.writeUInt32LE(40, 4);
    wav.write("WAVEfmt ", 8, "latin1");
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36, "latin1");
    wav.writeUInt32LE(4, 40);
    return new Response(new Uint8Array(wav));
  }
  return json({ error: "unexpected" }, 404);
};

const platformModel: AIProvider = {
  name: "fake",
  model: "fake-1",
  async *stream() {
    yield { type: "text", text: "Platform reply" };
    yield { type: "done", inputTokens: 10, outputTokens: 2 };
  },
};
const byoBuilt: { kind: string; settings: LlmSettings }[] = [];
const byoProvider = (kind: string, settings: LlmSettings): AIProvider => {
  byoBuilt.push({ kind, settings });
  return {
    name: kind,
    model: settings.model ?? "",
    async *stream() {
      if (settings.apiKey === "rate-limited-key-123") throw new AIProviderError("rate_limit", "slow down");
      if (settings.apiKey === "bad-key-1234567890") throw new AIProviderError("auth", "invalid key");
      yield { type: "text", text: `reply from ${kind}/${settings.model}` };
      yield { type: "done", inputTokens: 100, outputTokens: 20 };
    },
  };
};

const TWILIO_PUBLIC = "https://voice.example.test";
const platformTelephony: TelephonyProvider = {
  name: "twilio",
  verifyWebhook: () => false,
  connectToStream: (url) => `<Response><Connect><Stream url="${url}"/></Connect></Response>`,
  sayAndHangUp: (m) => `<Response><Say>${m}</Say></Response>`,
  statusOf: () => ({ providerCallId: "", status: null, durationSec: null }),
  placeCall: async () => ({ providerCallId: "CA-platform" }),
  endCall: async () => {},
  transferCall: async () => {},
  configureNumber: async () => ({ providerNumberId: "PN-platform" }),
  parseMedia: () => ({ type: "other" }),
  audioMessage: () => "",
  markMessage: () => "",
  clearMessage: () => "",
};

const connect = async (headers: Headers_, body: object) => call("POST", "/providers/connections", headers, body);

before(async () => {
  app = await buildApp({
    authenticate: headerAuth,
    provider: platformModel,
    credentialsKey: SECRET,
    byoProvider,
    providerFetch: { vendor: vendorFetch },
    logger: false,
    publicUrl: TWILIO_PUBLIC,
    voice: { telephony: [platformTelephony], stt: null, tts: null, publicUrl: TWILIO_PUBLIC, secret: "stream-secret", limits: { idleMs: 60_000, maxCallMs: 600_000 } },
  });
  for (const org of [orgA, orgB]) await call("GET", "/workspaces", adminOf(org));
  wsA = (await call("GET", "/workspaces", adminOf(orgA))).json<Workspace[]>()[0]!.id;
  wsB = (await call("GET", "/workspaces", adminOf(orgB))).json<Workspace[]>()[0]!.id;
  const employee = await call("POST", `/workspaces/${wsA}/employees`, adminOf(orgA), { ...defaultEmployeeConfig(), name: "Ava", role: "Support" });
  employeeId = employee.json<EmployeeDetail>().id;
  const workflow = await call("POST", `/workspaces/${wsA}/workflows`, adminOf(orgA), { name: "Follow-up" });
  workflowId = workflow.json<{ id: string }>().id;
});
after(async () => {
  await deleteOrgs(orgA, orgB);
  await app.close();
});

test("connections: admins connect, secrets are sealed and never returned, fields are validated, names unique, coming soon refused", async () => {
  const deepgram = { providerType: "stt", providerId: "deepgram", displayName: "Deepgram", credentials: { apiKey: "dg-secret-key-ABCD1234" }, configuration: { model: "nova-3" } };
  assert.equal((await connect(memberOf(orgA), deepgram)).statusCode, 403);
  const res = await connect(adminOf(orgA), deepgram);
  assert.equal(res.statusCode, 201, res.payload);
  assert.ok(!res.payload.includes("dg-secret-key"));
  const created = res.json<ProviderConnectionInfo>();
  assert.deepEqual(created.credentialHints, { apiKey: "…1234" });
  assert.equal(created.status, "active");
  const row = await prisma.providerConnection.findUniqueOrThrow({ where: { id: created.id } });
  assert.ok(!row.encryptedCredentials.includes("dg-secret"));
  assert.equal(openCredentials(row.encryptedCredentials, { current: SECRET }).credentials.apiKey, "dg-secret-key-ABCD1234");
  assert.equal((await connect(adminOf(orgA), deepgram)).statusCode, 409, "names are unique");

  const missing = await connect(adminOf(orgA), { providerType: "tts", providerId: "azure_speech", displayName: "Azure", credentials: { apiKey: "k-12345678" }, configuration: {} });
  assert.equal(missing.statusCode, 400);
  assert.deepEqual(missing.json<{ issues: { path: string }[] }>().issues.map((i) => i.path), ["configuration.region"]);
  const unknownField = await connect(adminOf(orgA), { ...deepgram, displayName: "X", credentials: { apiKey: "k-12345678", token: "y" } });
  assert.equal(unknownField.statusCode, 400);
  assert.match((await connect(adminOf(orgA), { providerType: "telephony", providerId: "vonage", displayName: "V", credentials: {}, configuration: {} })).payload, /coming soon/);
  assert.equal((await connect(adminOf(orgA), { providerType: "stt", providerId: "nope", displayName: "N", credentials: {}, configuration: {} })).statusCode, 400);

  // Typed addresses must be public https: the server calls them.
  for (const baseUrl of ["https://127.0.0.1:8880/v1", "https://169.254.169.254/v1", "https://192.168.1.5/v1", "http://tts.example.com/v1"]) {
    const res = await connect(adminOf(orgA), { providerType: "tts", providerId: "voicestudio", displayName: `VS ${baseUrl}`, credentials: {}, configuration: { baseUrl } });
    assert.equal(res.statusCode, 400, baseUrl);
  }
  // SMTP hosts too.
  assert.match(
    (await connect(adminOf(orgA), { providerType: "email", providerId: "smtp", displayName: "SMTP", credentials: { username: "u", password: "p" }, configuration: { host: "localhost", from: "a@b.co" } })).payload,
    /could not be found|private address/,
  );

  const settings = await call("GET", "/providers/settings", memberOf(orgA));
  assert.equal(settings.statusCode, 200);
  assert.ok(!settings.payload.includes("dg-secret-key") && !settings.payload.includes(row.encryptedCredentials));
  assert.ok(settings.json<ProviderSettings>().connections.some((c) => c.id === created.id));
  assert.equal(settings.json<ProviderSettings>().canStoreKeys, true);

  // Without the server secret, nothing can be stored.
  const keyless = await buildApp({ authenticate: headerAuth, provider: platformModel, credentialsKey: null, logger: false });
  try {
    assert.equal((await keyless.inject({ method: "POST", url: "/providers/connections", headers: adminOf(orgA), payload: { ...deepgram, displayName: "K" } })).statusCode, 503);
  } finally {
    await keyless.close();
  }
});

test("test connection: results stored and audited, duplicate presses share one call, rate limited per organization, other organizations 404", async () => {
  const id = (await call("GET", "/providers/settings", adminOf(orgA))).json<ProviderSettings>().connections.find((c) => c.providerId === "deepgram")!.id;
  testCalls = 0;
  const [first, second] = await Promise.all([call("POST", `/providers/connections/${id}/test`, adminOf(orgA)), call("POST", `/providers/connections/${id}/test`, adminOf(orgA))]);
  assert.equal(first.statusCode, 200, first.payload);
  assert.deepEqual(first.json(), second.json());
  assert.equal(testCalls, 1, "a second press while a test runs does not call the provider again");
  const result = first.json<TestConnectionResult>();
  assert.equal(result.ok, true);
  assert.equal(result.auth, "ok");
  assert.ok(result.capabilities.includes("live"));
  assert.ok(!first.payload.includes("dg-secret"));
  const row = await prisma.providerConnection.findUniqueOrThrow({ where: { id } });
  assert.equal(row.lastTestStatus, "ok");
  assert.ok(row.lastTestedAt);
  assert.equal(outside.find((o) => o.url.includes("deepgram.com/v1/projects"))?.headers.authorization, "Token dg-secret-key-ABCD1234");

  assert.equal((await call("POST", `/providers/connections/${id}/test`, memberOf(orgA))).statusCode, 403);
  assert.equal((await call("POST", `/providers/connections/${id}/test`, adminOf(orgB))).statusCode, 404);
  // 10 a minute per organization (one used above).
  const codes: number[] = [];
  for (let i = 0; i < 10; i++) codes.push((await call("POST", `/providers/connections/${id}/test`, adminOf(orgA))).statusCode);
  assert.deepEqual(codes.filter((c) => c === 429).length, 1);
  const audit = await call("GET", "/providers/audit", adminOf(orgA));
  assert.ok(audit.json<{ action: string }[]>().some((a) => a.action === "test"));
  assert.ok(!audit.payload.includes("dg-secret"));
  assert.equal((await call("GET", "/providers/audit", memberOf(orgA))).statusCode, 403);
});

test("rotation replaces every secret, resets the test, is audited; configure cannot change secrets", async () => {
  const id = (await call("GET", "/providers/settings", adminOf(orgA))).json<ProviderSettings>().connections.find((c) => c.providerId === "deepgram")!.id;
  const rotated = await call("POST", `/providers/connections/${id}/rotate`, adminOf(orgA), { credentials: { apiKey: "dg-rotated-key-WXYZ9876" } });
  assert.equal(rotated.statusCode, 200, rotated.payload);
  const info = rotated.json<ProviderConnectionInfo>();
  assert.deepEqual(info.credentialHints, { apiKey: "…9876" });
  assert.ok(info.rotatedAt);
  assert.equal(info.lastTestStatus, null);
  const row = await prisma.providerConnection.findUniqueOrThrow({ where: { id } });
  assert.equal(openCredentials(row.encryptedCredentials, { current: SECRET }).credentials.apiKey, "dg-rotated-key-WXYZ9876");
  assert.equal((await call("POST", `/providers/connections/${id}/rotate`, adminOf(orgA), { credentials: {} })).statusCode, 400, "a required secret cannot be dropped");
  const configured = await call("PATCH", `/providers/connections/${id}`, adminOf(orgA), { configuration: { model: "nova-2" }, credentials: { apiKey: "sneaky" } });
  assert.equal(configured.statusCode, 200);
  assert.equal(openCredentials((await prisma.providerConnection.findUniqueOrThrow({ where: { id } })).encryptedCredentials, { current: SECRET }).credentials.apiKey, "dg-rotated-key-WXYZ9876");
  assert.ok((await prisma.providerAuditLog.findMany({ where: { connectionId: id } })).some((a) => a.action === "rotate"));
});

test("resolution for language models: workflow > employee > policy > organization default > platform; disabled connections skipped", async () => {
  const llm = async (name: string, apiKey: string, configuration: object = {}) =>
    (await connect(adminOf(orgA), { providerType: "llm", providerId: "groq", displayName: name, credentials: { apiKey }, configuration })).json<ProviderConnectionInfo>();
  const orgDefault = await llm("Groq default", "groq-default-key-1", { defaultModel: "llama-default" });
  const employeeOwn = await llm("Groq employee", "groq-employee-key-2");
  const workflowOwn = await llm("Groq workflow", "groq-workflow-key-3");
  const platform: Platform = { kind: "fake", get: () => platformModel };
  const plan = (route: object) => planFor({ organizationId: orgA, workspaceId: wsA, task: "chat", ...route }, platform, SECRET, byoProvider);
  const models = async (route: object) => (await plan(route)).targets.map((t) => `${t.kind}:${t.provider.model}`);

  assert.deepEqual(await models({}), ["fake:fake-1"], "nothing set: the platform");
  assert.equal((await call("POST", `/providers/connections/${orgDefault.id}/default`, adminOf(orgA))).statusCode, 200);
  assert.deepEqual(await models({}), ["groq:llama-default"], "the organization's default connection");

  // Overrides must name the organization's own active connections.
  assert.equal((await call("PUT", `/workspaces/${wsA}/employees/${employeeId}/providers`, adminOf(orgA), { llm: { connectionId: "nope", model: "x" } })).statusCode, 400);
  assert.equal((await call("PUT", `/workspaces/${wsA}/employees/${employeeId}/providers`, memberOf(orgA), { llm: { connectionId: employeeOwn.id, model: "m" } })).statusCode, 403);
  assert.equal((await call("PUT", `/workspaces/${wsA}/employees/${employeeId}/providers`, adminOf(orgA), { llm: { connectionId: employeeOwn.id, model: "llama-employee" } })).statusCode, 200);
  assert.deepEqual(await models({ employeeId }), ["groq:llama-employee", "groq:llama-default"], "the employee's own model first, the default after");
  assert.equal((await call("PUT", `/workspaces/${wsA}/workflows/${workflowId}/providers`, adminOf(orgA), { llm: { connectionId: workflowOwn.id, model: "llama-workflow" } })).statusCode, 200);
  assert.deepEqual(await models({ employeeId, workflowId }), ["groq:llama-workflow", "groq:llama-employee", "groq:llama-default"]);
  // A task policy replaces the default connection; overrides still come first.
  assert.equal((await call("PUT", "/ai/policies/chat", adminOf(orgA), { primary: { credentialId: null, model: "fake-1" } })).statusCode, 200);
  assert.deepEqual(await models({ employeeId }), ["groq:llama-employee", "fake:fake-1"]);
  // Disabling the employee's connection: it is skipped, the next level answers.
  assert.equal((await call("POST", `/providers/connections/${employeeOwn.id}/status`, adminOf(orgA), { status: "disabled" })).statusCode, 200);
  assert.deepEqual(await models({ employeeId }), ["fake:fake-1"]);
  assert.equal((await call("POST", `/providers/connections/${employeeOwn.id}/status`, adminOf(orgA), { status: "active" })).statusCode, 200);

  // Through test chat: the employee's key answers and usage names the employee.
  await call("DELETE", "/ai/policies/chat", adminOf(orgA));
  const reply = await call("POST", `/workspaces/${wsA}/employees/${employeeId}/messages`, adminOf(orgA), { message: "Hi" });
  assert.match(reply.payload, /reply from groq\/llama-employee/);
  assert.equal(byoBuilt.findLast((b) => b.settings.model === "llama-employee")?.settings.apiKey, "groq-employee-key-2");
  let usage = null;
  for (let i = 0; i < 50 && !usage; i++) {
    usage = await prisma.aiUsage.findFirst({ where: { organizationId: orgA, providerType: "llm", success: true, model: "llama-employee" } });
    if (!usage) await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(usage?.employeeId, employeeId);
  assert.equal(usage?.credentialId, employeeOwn.id);
});

test("no fallback on authentication errors: a bad key fails the request instead of quietly using another model", async () => {
  const bad = (await connect(adminOf(orgA), { providerType: "llm", providerId: "mistral", displayName: "Bad Mistral", credentials: { apiKey: "bad-key-1234567890" }, configuration: {} })).json<ProviderConnectionInfo>();
  await call("PUT", `/workspaces/${wsA}/employees/${employeeId}/providers`, adminOf(orgA), { llm: { connectionId: bad.id, model: "mistral-large" } });
  const reply = await call("POST", `/workspaces/${wsA}/employees/${employeeId}/messages`, adminOf(orgA), { message: "Hi" });
  assert.match(reply.payload, /"type":"error"/);
  assert.ok(!reply.payload.includes("reply from groq"), "the organization default did not answer");
  await call("PUT", `/workspaces/${wsA}/employees/${employeeId}/providers`, adminOf(orgA), {});
});

test("resolution for speech: employee override, organization default, platform; usage records characters; fallback on rate limits", async () => {
  const eleven = (await connect(adminOf(orgA), { providerType: "tts", providerId: "elevenlabs", displayName: "Eleven", credentials: { apiKey: "xi-org-key-12345678" }, configuration: { voice: "voice-org" } })).json<ProviderConnectionInfo>();
  const openai = (await connect(adminOf(orgA), { providerType: "tts", providerId: "openai_tts", displayName: "OpenAI voice", credentials: { apiKey: "sk-openai-tts-12345678" }, configuration: {} })).json<ProviderConnectionInfo>();
  await call("POST", `/providers/connections/${eleven.id}/default`, adminOf(orgA));
  // Calls resolve speech through the same service (voice/routes.ts speechFor); it is exercised directly here.
  const { providerService } = await import("./providers/service.ts");
  const service = providerService({ secret: SECRET, platform: { stt: null, tts: null, telephony: [], whatsapp: [], email: null, emailFrom: null }, fetch: vendorFetch, log: app.log });
  const scope = { organizationId: orgA, workspaceId: wsA, employeeId };
  const speak = async () => {
    outside.length = 0;
    const tts = await service.tts(scope);
    assert.ok(tts);
    const out: Buffer[] = [];
    for await (const chunk of tts.synthesize("Hello there", { language: "en", signal: AbortSignal.timeout(2000) })) out.push(chunk);
    return { name: tts.name, hosts: outside.map((o) => new URL(o.url).host) };
  };
  assert.deepEqual(await speak(), { name: "elevenlabs", hosts: ["api.elevenlabs.io"] }, "the organization default");
  assert.match(outside[0]!.url, /text-to-speech\/voice-org\//, "the connection's voice");
  assert.equal(outside[0]!.headers["xi-api-key"], "xi-org-key-12345678");
  await call("PUT", `/workspaces/${wsA}/employees/${employeeId}/providers`, adminOf(orgA), { tts: { connectionId: openai.id, voice: "nova" } });
  const own = await speak();
  assert.equal(own.name, "openai_tts");
  assert.deepEqual(own.hosts, ["api.openai.com"]);
  assert.equal(JSON.parse(outside[0]!.body).voice, "nova", "the override's voice");
  // The employee's provider is rate limited: the organization default speaks instead, before any audio was played.
  limitedHosts.add("api.openai.com");
  assert.deepEqual((await speak()).hosts, ["api.openai.com", "api.elevenlabs.io"]);
  limitedHosts.clear();
  await call("PUT", `/workspaces/${wsA}/employees/${employeeId}/providers`, adminOf(orgA), {});

  let rows: { characters: number | null; providerType: string }[] = [];
  for (let i = 0; i < 50 && rows.length === 0; i++) {
    rows = await prisma.aiUsage.findMany({ where: { organizationId: orgA, providerType: "tts", success: true } });
    if (rows.length === 0) await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(rows[0]?.characters, "Hello there".length);

  // Live recognition: a transcribe-only provider as the only one means calls cannot be answered.
  const whisper = (await connect(adminOf(orgA), { providerType: "stt", providerId: "openai_whisper", displayName: "Whisper", credentials: { apiKey: "sk-whisper-12345678" }, configuration: {} })).json<ProviderConnectionInfo>();
  await call("PUT", `/workspaces/${wsA}/employees/${employeeId}/providers`, adminOf(orgA), { stt: { connectionId: whisper.id } });
  const fileOnly = await service.stt(scope);
  assert.ok(fileOnly?.transcribe, "voice notes can be transcribed");
  assert.equal(fileOnly?.open, undefined, "but calls cannot be answered: Whisper has no live capability");
  // With a live provider as the organization's default, calls fall to it while voice notes keep the employee's Whisper.
  const deepgram = (await call("GET", "/providers/settings", adminOf(orgA))).json<ProviderSettings>().connections.find((c) => c.providerId === "deepgram")!;
  await call("POST", `/providers/connections/${deepgram.id}/default`, adminOf(orgA));
  const both = await service.stt(scope);
  assert.ok(both?.open && both.transcribe);
  assert.equal(both.name, "deepgram");
  await call("PUT", `/workspaces/${wsA}/employees/${employeeId}/providers`, adminOf(orgA), {});
});

test("metrics: per provider and type, with failures, fallbacks and units; isolated per organization", async () => {
  const res = await call("GET", "/providers/metrics?days=7", memberOf(orgA));
  assert.equal(res.statusCode, 200);
  const providers = res.json<{ providers: ProviderMetric[] }>().providers;
  const tts = providers.filter((p) => p.providerType === "tts");
  assert.ok(tts.some((p) => p.provider === "openai_tts" && p.failures >= 1), JSON.stringify(tts));
  assert.ok(tts.some((p) => p.provider === "elevenlabs" && p.characters > 0 && p.failures === 0), JSON.stringify(tts));
  assert.ok(providers.some((p) => p.providerType === "llm" && p.provider === "groq"));
  assert.deepEqual((await call("GET", "/providers/metrics", memberOf(orgB))).json<{ providers: ProviderMetric[] }>().providers, []);
});

test("deletion is refused while in use (policies, overrides, phone numbers), then allowed and audited; isolation", async () => {
  const settings = (await call("GET", "/providers/settings", adminOf(orgA))).json<ProviderSettings>();
  const groq = settings.connections.find((c) => c.displayName === "Groq workflow")!;
  const del = await call("DELETE", `/providers/connections/${groq.id}`, adminOf(orgA));
  assert.equal(del.statusCode, 409);
  assert.match(del.json<{ error: string }>().error, /workflow Follow-up/);
  assert.equal((await call("DELETE", `/providers/connections/${groq.id}`, adminOf(orgB))).statusCode, 404);
  assert.equal((await call("DELETE", `/providers/connections/${groq.id}`, memberOf(orgA))).statusCode, 403);
  await call("PUT", `/workspaces/${wsA}/workflows/${workflowId}/providers`, adminOf(orgA), {});
  assert.equal((await call("DELETE", `/providers/connections/${groq.id}`, adminOf(orgA))).statusCode, 204);
  assert.ok((await prisma.providerAuditLog.findMany({ where: { connectionId: groq.id } })).some((a) => a.action === "delete"));

  // Another organization cannot name A's connections in its own overrides, nor see them.
  const employeeB = (await call("POST", `/workspaces/${wsB}/employees`, adminOf(orgB), { ...defaultEmployeeConfig(), name: "Bo", role: "Support" })).json<EmployeeDetail>().id;
  const other = settings.connections.find((c) => c.displayName === "Groq default")!;
  assert.equal((await call("PUT", `/workspaces/${wsB}/employees/${employeeB}/providers`, adminOf(orgB), { llm: { connectionId: other.id, model: "x" } })).statusCode, 400);
  assert.equal((await call("GET", "/providers/settings", adminOf(orgB))).json<ProviderSettings>().connections.length, 0);
  assert.equal((await call("PATCH", `/providers/connections/${other.id}`, adminOf(orgB), { displayName: "mine" })).statusCode, 404);
  assert.equal((await call("GET", `/workspaces/${wsA}/employees/${employeeId}/providers`, adminOf(orgB))).statusCode, 404);
});

test("telephony on an organization's own account: webhooks under its connection, checked with its token, numbers bound to it", async () => {
  const twilio = await connect(adminOf(orgA), { providerType: "telephony", providerId: "twilio", displayName: "Our Twilio", credentials: { accountSid: "ACorg000111", authToken: "org-twilio-token-5555" }, configuration: {} });
  assert.equal(twilio.statusCode, 201, twilio.payload);
  const info = twilio.json<ProviderConnectionInfo>();
  assert.equal(info.webhookUrls?.voice, `${TWILIO_PUBLIC}/voice/twilio/c/${info.id}/inbound`);
  assert.equal((await call("GET", "/providers/settings", memberOf(orgA))).json<ProviderSettings>().connections.find((c) => c.id === info.id)?.webhookUrls, null, "members do not get webhook addresses");

  const number = "+15557770001";
  await prisma.phoneNumber.create({
    data: { organizationId: orgA, workspaceId: wsA, employeeId, number, provider: "twilio", connectionId: info.id, providerNumberId: "PN1", greeting: "Hi", createdBy: "user_admin" },
  });
  const params = { CallSid: "CA-org-1", From: "+15550009999", To: number };
  const webhook = (path: string, token: string) =>
    app.inject({
      method: "POST",
      url: path,
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(token, TWILIO_PUBLIC + path, params) },
      payload: new URLSearchParams(params).toString(),
    });
  const own = `/voice/twilio/c/${info.id}/inbound`;
  assert.equal((await webhook(own, "the-platform-token")).statusCode, 403, "signed with another account's token");
  const answered = await webhook(own, "org-twilio-token-5555");
  assert.equal(answered.statusCode, 200);
  // Not published yet: turned away politely, but recognised as this account's number.
  assert.match(answered.payload, /no one is available/);
  // The platform's account (or another connection) cannot ring this organization's number.
  // Another organization's account (validly signed by it) cannot ring this organization's number.
  const theirs = (
    await connect(adminOf(orgB), { providerType: "telephony", providerId: "twilio", displayName: "Their Twilio", credentials: { accountSid: "ACother", authToken: "other-token-7777" }, configuration: {} })
  ).json<ProviderConnectionInfo>();
  assert.match((await webhook(`/voice/twilio/c/${theirs.id}/inbound`, "other-token-7777")).payload, /not in service/);
  assert.equal((await webhook(`/voice/twilio/c/unknown-connection/inbound`, "org-twilio-token-5555")).statusCode, 404);

  // The number keeps the connection from being deleted.
  assert.match((await call("DELETE", `/providers/connections/${info.id}`, adminOf(orgA))).payload, /phone number \+15557770001/);
});

test("migration: Phase 13 keys become llm connections with the same ids, still open, and are sealed again in the new format", async () => {
  const sql = readFileSync(new URL("../../../packages/database/prisma/migrations/20261121090000_provider_connections/migration.sql", import.meta.url), "utf8");
  const copy = sql.slice(sql.indexOf('INSERT INTO "ProviderConnection"'), sql.indexOf('FROM "AiCredential";') + 'FROM "AiCredential";'.length);
  const orgC = newOrg();
  await prisma.organization.create({ data: { id: orgC, name: "Migrated" } });
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE "AiCredential" ("id" text, "organizationId" text, "name" text, "kind" text, "baseUrl" text, "secret" text, "keyHint" text, "models" jsonb, "createdBy" text, "createdAt" timestamp(3), "updatedAt" timestamp(3)) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(
        `INSERT INTO "AiCredential" VALUES ('cred_phase13', $1, 'Old OpenAI', 'openai', NULL, $2, '…5678', '[{"id":"gpt-x"}]', 'user_admin', now(), now()), ('cred_custom', $1, 'Old custom', 'openai_compatible', 'https://llm.example.com/v1', $3, '…9999', '[]', 'user_admin', now() + interval '1 second', now())`,
        orgC,
        sealKey("sk-phase13-key-5678", SECRET),
        sealKey("custom-key-9999", SECRET),
      );
      await tx.$executeRawUnsafe(copy);
    });
    const migrated = await call("GET", "/ai/settings", adminOf(orgC));
    const keys = migrated.json<{ credentials: AiCredential[] }>().credentials;
    assert.deepEqual(
      keys.map((k) => [k.id, k.name, k.kind, k.keyHint, k.baseUrl, k.models.map((m) => m.id)]),
      [
        ["cred_phase13", "Old OpenAI", "openai", "…5678", null, ["gpt-x"]],
        ["cred_custom", "Old custom", "openai_compatible", "…9999", "https://llm.example.com/v1", []],
      ],
    );
    // A Phase 13 policy naming the old id still routes to it, and the key opens.
    await prisma.aiModelPolicy.create({ data: { organizationId: orgC, task: "default", primary: { credentialId: "cred_phase13", model: "gpt-x" }, fallbacks: [], allowedProviders: [], updatedBy: "user_admin" } });
    const plan = await planFor({ organizationId: orgC, task: "chat" }, { kind: "fake", get: () => platformModel }, SECRET, byoProvider);
    assert.equal(plan.targets[0]?.credentialId, "cred_phase13");
    assert.equal(byoBuilt.at(-1)?.settings.apiKey, "sk-phase13-key-5678");
    // Opening a v1 key through the provider service seals it again as v2.
    const { providerService } = await import("./providers/service.ts");
    const service = providerService({ secret: SECRET, platform: { stt: null, tts: null, telephony: [], whatsapp: [], email: null, emailFrom: null }, log: app.log });
    service.conn(await prisma.providerConnection.findUniqueOrThrow({ where: { id: "cred_phase13" } }));
    let sealed = "";
    for (let i = 0; i < 50 && !sealed.startsWith("v2:"); i++) {
      sealed = (await prisma.providerConnection.findUniqueOrThrow({ where: { id: "cred_phase13" } })).encryptedCredentials;
      if (!sealed.startsWith("v2:")) await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(sealed.startsWith("v2:"));
    assert.deepEqual(openCredentials(sealed, { current: SECRET }).credentials, { apiKey: "sk-phase13-key-5678" });
  } finally {
    await deleteOrgs(orgC);
  }
});
