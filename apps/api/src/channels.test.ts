// Needs the database from .env to be running (pnpm infra:up && pnpm db:migrate).
// Phase 9: WhatsApp (Meta's webhook format and signatures, a fake Graph API), web chat (the widget's
// endpoints) and email, all answered by the same runtime with a fake model, and one customer
// carried from a phone call to WhatsApp to web chat.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, beforeEach, test } from "node:test";
import { runTurn } from "@workforce/agent-runtime";
import type { AIProvider, CompletionRequest, ToolCall } from "@workforce/ai-provider";
import { metaSignature, metaWhatsApp, splitText, telnyxWhatsApp, twilioWhatsApp } from "@workforce/channels";
import { prisma } from "@workforce/database";
import { EXTRACTION_PROMPT, identifyCustomer, memoryService } from "@workforce/memory";
import {
  defaultEmployeeConfig,
  type ChannelMessageRecord,
  type EmployeeChannelInfo,
  type EmployeeChannels,
  type EmployeeDetail,
  type Workspace,
} from "@workforce/shared";
import type { STTProvider } from "@workforce/stt";
import { twilioSignature } from "@workforce/telephony";
import { buildApp } from "./app.ts";
import { identityHash } from "./channels/webchat.ts";
import { adminOf, deleteOrgs, headerAuth, memberOf, newOrg } from "./testing.ts";

const APP_SECRET = "meta-app-secret";
const VERIFY = "verify-me";
const PNID = `1${Date.now()}`; // Meta's phone number id; unique per run, since it routes globally
const PNID_PAUSED = `2${Date.now()}`;
const EMAIL = `support-${Date.now()}@example.test`;
const PHONE = "+15557654321";
const WA_ID = "15557654321"; // how WhatsApp writes the same number
const orgA = newOrg();
const orgB = newOrg();
let app: Awaited<ReturnType<typeof buildApp>>;
let ws: string;
let wsB: string;
let ava: string;
let paused: string;

// ---- Fakes ----

type Step = (req: CompletionRequest) => { text?: string; calls?: ToolCall[] };
let script: Step[] = [];
let requests: CompletionRequest[] = [];
/** What the memory extractor "learns" from each exchange. */
let extraction = '{"memories":[]}';
const model: AIProvider = {
  name: "fake",
  model: "fake-1",
  async *stream(req) {
    if (req.system.startsWith(EXTRACTION_PROMPT)) {
      yield { type: "text", text: extraction };
      yield { type: "done", inputTokens: 1, outputTokens: 1 };
      return;
    }
    requests.push(req);
    const step: Step = script.shift() ?? (() => ({}));
    const { text = "OK.", calls } = step(req);
    yield { type: "text", text };
    yield { type: "done", inputTokens: 1, outputTokens: 1, ...(calls && { toolCalls: calls }) };
  },
};
const memory = memoryService(model, 5000);
/** What the customer's last message looked like to the model. */
const lastSaid = (req?: CompletionRequest) => {
  const m = req?.messages.at(-1);
  return m && "content" in m ? m.content : undefined;
};

const stt: STTProvider = {
  name: "fake-stt",
  open: () => ({ send() {}, close() {} }),
  async transcribe(audio, { mimeType }) {
    assert.equal(mimeType, "audio/ogg; codecs=opus");
    return audio.toString() === "OGG-VOICE" ? "Can I book a demo for Friday?" : "";
  },
};

// Meta's Graph API: sends, read receipts, media lookups and downloads.
type GraphReply = { status: number; body: object };
let sent: { to: string; text: string }[] = [];
let reads: string[] = [];
let sendReplies: GraphReply[] = [];
const files: Record<string, { mime: string; data: string }> = {
  "media-voice": { mime: "audio/ogg; codecs=opus", data: "OGG-VOICE" },
  "media-doc": { mime: "text/plain", data: "Order 1234: two blue chairs, delivery on Monday." },
  "media-img": { mime: "image/jpeg", data: "JPEG" },
};
const graph = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const json = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  assert.equal(new Headers(init?.headers).get("authorization"), "Bearer wa-token");
  if (url.startsWith("https://lookaside.test/")) {
    const file = files[url.slice("https://lookaside.test/".length)];
    return file ? new Response(file.data) : new Response("gone", { status: 404 });
  }
  const path = url.replace("https://graph.test/v26.0/", "");
  if (init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as { status?: string; message_id?: string; to?: string; text?: { body: string } };
    if (body.status === "read") {
      reads.push(body.message_id ?? "");
      return json(200, { success: true });
    }
    const reply = sendReplies.shift();
    if (reply && reply.status !== 200) return json(reply.status, reply.body);
    sent.push({ to: body.to ?? "", text: body.text?.body ?? "" });
    return json(200, { messaging_product: "whatsapp", messages: [{ id: `wamid.out-${sent.length}-${Date.now()}` }] });
  }
  const file = files[path];
  return file ? json(200, { url: `https://lookaside.test/${path}`, mime_type: file.mime, file_size: file.data.length, id: path }) : json(404, {});
}) as typeof fetch;
const whatsapp = metaWhatsApp({
  accessToken: "wa-token",
  appSecret: APP_SECRET,
  verifyToken: VERIFY,
  graphUrl: "https://graph.test",
  fetch: graph,
  retry: { attempts: 3, backoffMs: 1 },
});

const PUBLIC = "https://chat.example.test";
const json = (status: number, body: object, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

// Twilio's Messages API: sends (form-encoded) and media behind the account's credentials.
const TW_TOKEN = "twilio-auth-token";
const TW_NUMBER = "+15550007777";
let twilioSent: URLSearchParams[] = [];
let twilioReplies: GraphReply[] = [];
const twilioAuth = `Basic ${Buffer.from(`ACtest:${TW_TOKEN}`).toString("base64")}`;
const twilio = twilioWhatsApp({
  accountSid: "ACtest",
  authToken: TW_TOKEN,
  webhookUrl: `${PUBLIC}/channels/whatsapp/twilio/webhook`,
  api: "https://twilio.test",
  retry: { attempts: 3, backoffMs: 1 },
  fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    assert.equal(new Headers(init?.headers).get("authorization"), twilioAuth);
    if (url.endsWith("/Media/ME1")) return new Response("OGG-VOICE", { headers: { "content-type": "audio/ogg; codecs=opus" } });
    assert.equal(url, "https://twilio.test/2010-04-01/Accounts/ACtest/Messages.json");
    const reply = twilioReplies.shift();
    if (reply) return json(reply.status, reply.body);
    twilioSent.push(new URLSearchParams(String(init?.body)));
    return json(201, { sid: `SMout${twilioSent.length}${Date.now()}`, status: "queued" });
  }) as typeof fetch,
});

// Telnyx: Ed25519-signed webhooks, sends to /v2/messages/whatsapp with an Idempotency-Key.
const TX_NUMBER = "+15550008888";
const telnyxKeys = generateKeyPairSync("ed25519");
let telnyxSent: { key: string | null; body: { from: string; to: string; webhook_url?: string; whatsapp_message: { text: { body: string } } } }[] = [];
let telnyxReplies: GraphReply[] = [];
let telnyxDownloads: { url: string; auth: string | null }[] = [];
const telnyx = telnyxWhatsApp({
  apiKey: "telnyx-key",
  // The portal shows the raw 32-byte key in base64: the last 32 bytes of the DER form.
  publicKey: telnyxKeys.publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64"),
  webhookUrl: `${PUBLIC}/channels/whatsapp/telnyx/webhook`,
  api: "https://telnyx.test",
  retry: { attempts: 3, backoffMs: 1 },
  fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url.startsWith("https://media.telnyx-hosted.test/")) {
      telnyxDownloads.push({ url, auth: headers.get("authorization") });
      return new Response("Invoice 77: total 120 EUR, due Friday.", { headers: { "content-type": "text/plain" } });
    }
    assert.equal(url, "https://telnyx.test/v2/messages/whatsapp");
    assert.equal(headers.get("authorization"), "Bearer telnyx-key");
    telnyxSent.push({ key: headers.get("idempotency-key"), body: JSON.parse(String(init?.body)) });
    const reply = telnyxReplies.shift();
    if (reply) return json(reply.status, reply.body);
    return json(200, { data: { id: `tx-out-${telnyxSent.length}-${Date.now()}`, type: "WHATSAPP" } });
  }) as typeof fetch,
});

// ---- Helpers ----

type Headers = Record<string, string>;
const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object, headers: Headers = adminOf(orgA)) =>
  app.inject({ method, url, headers, payload });

const until = async (ok: () => boolean | Promise<boolean>, what: string, ms = 4000) => {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(15);
  }
};

const messages = async (query = "", headers = adminOf(orgA)) =>
  (await call("GET", `/workspaces/${ws}/channel-messages?${query}`, undefined, headers)).json<ChannelMessageRecord[]>();

/** A webhook from Meta, signed like Meta signs it. */
const waWebhook = (body: object, signature?: string) => {
  const raw = JSON.stringify(body);
  return app.inject({
    method: "POST",
    url: "/channels/whatsapp/meta/webhook",
    headers: { "content-type": "application/json", "x-hub-signature-256": signature ?? metaSignature(APP_SECRET, raw) },
    payload: raw,
  });
};
const waValue = (value: object, pnid = PNID) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "15550001111", phone_number_id: pnid }, ...value } }] }],
});
let waCount = 0;
/** One customer message; `content` is the type-specific part. Returns its wamid. */
const waSend = async (content: object, from = WA_ID, pnid = PNID) => {
  const id = `wamid.in-${++waCount}-${Date.now()}`;
  const res = await waWebhook(
    waValue({ contacts: [{ profile: { name: "Rahul" }, wa_id: from }], messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), ...content }] }, pnid),
  );
  assert.equal(res.statusCode, 200, res.payload);
  return id;
};
const inboundRow = async (providerMessageId: string) =>
  prisma.channelMessage.findFirst({ where: { providerMessageId, direction: "INBOUND" } });
/** Waits until the inbound message is no longer being answered, and any reply has left. */
const settled = async (providerMessageId: string) => {
  await until(async () => {
    const row = await inboundRow(providerMessageId);
    if (!row || row.status === "RECEIVED") return false;
    const pending = await prisma.channelMessage.count({ where: { channelId: row.channelId, direction: "OUTBOUND", status: "PENDING" } });
    return pending === 0;
  }, `message ${providerMessageId} to be answered`);
  return (await inboundRow(providerMessageId))!;
};

const setChannel = (kind: string, body: object, employee = ava, headers = adminOf(orgA)) =>
  call("PUT", `/workspaces/${ws}/employees/${employee}/channels/${kind}`, body, headers);

/** The widget's calls. */
const chat = (key: string, path: string, payload: object, headers: Headers = {}) =>
  app.inject({ method: "POST", url: `/chat/${key}/${path}`, headers: { "content-type": "application/json", ...headers }, payload });
const events = (payload: string) =>
  payload
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice(6)) as { type: string; text?: string; error?: string; conversation?: { id: string } });

before(async () => {
  app = await buildApp({
    authenticate: headerAuth,
    provider: model,
    memory: () => memory,
    logger: false,
    publicUrl: PUBLIC,
    whatsapp: [whatsapp, twilio, telnyx],
    voice: { stt },
  });
  await app.ready();
  const workspaceOf = async (org: string) => (await call("GET", "/workspaces", undefined, adminOf(org))).json<Workspace[]>()[0]?.id ?? "";
  ws = await workspaceOf(orgA);
  wsB = await workspaceOf(orgB);
  const create = async (name: string) =>
    (await call("POST", `/workspaces/${ws}/employees`, { ...defaultEmployeeConfig("UTC"), name, role: "Sales assistant" })).json<EmployeeDetail>().id;
  ava = await create("Ava");
  paused = await create("Paused");
  for (const id of [ava, paused]) assert.equal((await call("POST", `/workspaces/${ws}/employees/${id}/publish`, { version: 1 })).statusCode, 200);
  assert.equal((await call("PATCH" as "PUT", `/workspaces/${ws}/employees/${paused}/status`, { status: "PAUSED" })).statusCode, 200);
  const grant = await call("PUT", `/workspaces/${ws}/employees/${ava}/tools`, { tools: [{ name: "calendar_book_meeting" }, { name: "send_email" }] });
  assert.equal(grant.statusCode, 200, grant.payload);
  assert.equal((await setChannel("whatsapp", { config: { phoneNumberId: PNID } })).statusCode, 200);
  assert.equal((await setChannel("whatsapp", { config: { phoneNumberId: PNID_PAUSED } }, paused)).statusCode, 200);
});
beforeEach(() => {
  script = [];
  requests = [];
  sent = [];
  reads = [];
  sendReplies = [];
  twilioSent = [];
  twilioReplies = [];
  telnyxSent = [];
  telnyxReplies = [];
  telnyxDownloads = [];
  extraction = '{"memories":[]}';
});
after(async () => {
  await app.close();
  await deleteOrgs(orgA, orgB);
});

test("splitText keeps short replies whole and cuts long ones at paragraph or word breaks", () => {
  assert.deepEqual(splitText("Hello there.", 4096), ["Hello there."]);
  assert.deepEqual(splitText("  one  ", null), ["one"]);
  const long = `${"a".repeat(60)}\n\n${"b".repeat(60)}`;
  assert.deepEqual(splitText(long, 100), ["a".repeat(60), "b".repeat(60)]);
  const words = "word ".repeat(50).trim();
  const parts = splitText(words, 40);
  assert.ok(parts.every((p) => p.length <= 40 && !p.startsWith(" ") && p.endsWith("word")));
  assert.equal(parts.join(" "), words);
  assert.deepEqual(splitText("x".repeat(25), 10), ["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
});

test("WhatsApp webhook: the subscription handshake and signatures are checked", async () => {
  const ok = await app.inject({ method: "GET", url: `/channels/whatsapp/meta/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=12345` });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.payload, "12345");
  const wrong = await app.inject({ method: "GET", url: "/channels/whatsapp/meta/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1" });
  assert.equal(wrong.statusCode, 403);
  const forged = await waWebhook(waValue({ messages: [{ from: WA_ID, id: "wamid.forged", type: "text", text: { body: "hi" } }] }), "sha256=00");
  assert.equal(forged.statusCode, 403);
  const unsigned = await app.inject({ method: "POST", url: "/channels/whatsapp/meta/webhook", headers: { "content-type": "application/json" }, payload: "{}" });
  assert.equal(unsigned.statusCode, 403);
  await sleep(50);
  assert.equal(await inboundRow("wamid.forged"), null);
});

test("one customer across channels: a phone call, then WhatsApp, then web chat, with memory and history carried over", async () => {
  // 1. The phone call. The voice channel calls runTurn exactly like this (see voice.test.ts).
  const scope = { organizationId: orgA, workspaceId: ws };
  const customerId = await identifyCustomer(scope, PHONE);
  extraction = JSON.stringify({
    memories: [
      { category: "identity", key: "name", value: "Rahul" },
      { category: "lead", key: "budget", value: "50000" },
    ],
    summary: "Rahul called about the enterprise plan and asked for the pricing on WhatsApp.",
  });
  script = [() => ({ text: "I'll send you the pricing on WhatsApp." })];
  const version = await prisma.aiEmployeeVersion.findFirstOrThrow({ where: { employeeId: ava, number: 1 } });
  for await (const e of runTurn({
    provider: model,
    ...scope,
    employeeId: ava,
    userId: "voice",
    employee: { ...defaultEmployeeConfig("UTC"), name: version.name, role: version.role },
    employeeVersion: 1,
    customer: { id: customerId, memory, onError: (err) => assert.fail(String(err)) },
    channel: "voice",
    userMessage: "Hi, I'm Rahul, I'm interested in the enterprise plan. Can you message me the pricing?",
    timeoutMs: 5000,
  }))
    assert.notEqual(e.type, "error");
  await until(async () => (await prisma.customerConversation.count({ where: { customerId, summary: { not: "" } } })) === 1, "the call's summary");
  requests = [];

  // 2. WhatsApp, from the same number as WhatsApp writes it.
  extraction = JSON.stringify({ memories: [], summary: "Rahul asked on WhatsApp for the enterprise pricing sheet." });
  script = [() => ({ text: "Hi Rahul! The enterprise plan is $499 per month." })];
  const first = await waSend({ type: "text", text: { body: "Hi, it's me again. What's the price?" } });
  const answered = await settled(first);
  assert.equal(answered.status, "ANSWERED", answered.error ?? "");
  assert.equal(answered.customerId, customerId, "WhatsApp found the caller's customer by number");
  assert.equal(answered.from, PHONE);
  const system = requests[0]?.system ?? "";
  assert.match(system, /- name: Rahul/);
  assert.match(system, /- budget: 50000/);
  assert.match(system, /phone call: Rahul called about the enterprise plan/);
  assert.match(system, /chatting with the customer on WhatsApp/);
  assert.deepEqual(sent, [{ to: WA_ID, text: "Hi Rahul! The enterprise plan is $499 per month." }]);
  assert.deepEqual(reads, [first], "the message is marked read, with a typing indicator");
  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: answered.conversationId ?? "" } });
  assert.equal(conversation.channel, "whatsapp");
  assert.equal(conversation.createdBy, "whatsapp");

  // The next message continues the same WhatsApp conversation.
  const second = await waSend({ type: "text", text: { body: "Thanks!" } });
  assert.equal((await settled(second)).conversationId, conversation.id);
  assert.deepEqual(
    requests[1]?.messages.map((m) => m.role),
    ["user", "assistant", "user"],
  );

  // Meta retries webhooks: the same message is never answered twice.
  const before = sent.length;
  const again = await waWebhook(
    waValue({ messages: [{ from: WA_ID, id: second, timestamp: "1", type: "text", text: { body: "Thanks!" } }] }),
  );
  assert.equal(again.statusCode, 200);
  await sleep(100);
  assert.equal(sent.length, before);
  assert.equal((await prisma.channelMessage.count({ where: { providerMessageId: second } })), 1);
  await until(async () => (await prisma.customerConversation.count({ where: { customerId, summary: { not: "" } } })) === 2, "the WhatsApp summary");

  // 3. Web chat on the company website, which vouches for the visitor's phone number.
  const saved = await setChannel("web_chat", { config: { allowedOrigins: ["https://shop.example"] } });
  assert.equal(saved.statusCode, 200, saved.payload);
  const web = saved.json<EmployeeChannelInfo>();
  assert.ok(web.address.startsWith("wc_") && web.secret);
  const customer = "+1 (555) 765-4321"; // as the website stores it
  const forged = await chat(web.address, "session", { customer, customerHash: "0".repeat(64) });
  assert.equal(forged.statusCode, 403, "a website cannot claim a customer without the secret");
  const session = await chat(web.address, "session", { customer, customerHash: identityHash(web.secret!, customer) }, { origin: "https://shop.example" });
  assert.equal(session.statusCode, 200, session.payload);
  const { token, verified, visitorId, employee } = session.json<{ token: string; verified: boolean; visitorId: string | null; employee: { name: string } }>();
  assert.equal(verified, true);
  assert.equal(visitorId, null);
  assert.equal(employee.name, "Ava");

  script = [() => ({ text: "Welcome back, Rahul. I sent the pricing on WhatsApp earlier." })];
  const reply = await chat(web.address, "messages", { message: "Did you send me the pricing?" }, { authorization: `Bearer ${token}`, origin: "https://shop.example" });
  assert.equal(reply.statusCode, 200, reply.payload);
  assert.equal(reply.headers["access-control-allow-origin"], "https://shop.example");
  const streamed = events(reply.payload);
  assert.equal(streamed.at(-1)?.type, "done");
  assert.equal(streamed.filter((e) => e.type === "text").map((e) => e.text).join(""), "Welcome back, Rahul. I sent the pricing on WhatsApp earlier.");
  const webSystem = requests.at(-1)?.system ?? "";
  assert.match(webSystem, /- name: Rahul/);
  assert.match(webSystem, /phone call: Rahul called/);
  assert.match(webSystem, /WhatsApp: Rahul asked on WhatsApp/);
  assert.match(webSystem, /chat widget on the company's website/);

  // The log has every message, in and out, on all three channels, for the one customer.
  const log = await messages(`customerId=${customerId}`, memberOf(orgA));
  const byChannel = (channel: string) => log.filter((m) => m.channel === channel).map((m) => `${m.direction}:${m.status}`);
  assert.deepEqual(byChannel("whatsapp").sort(), ["INBOUND:ANSWERED", "INBOUND:ANSWERED", "OUTBOUND:SENT", "OUTBOUND:SENT"]);
  assert.deepEqual(byChannel("web_chat").sort(), ["INBOUND:ANSWERED", "OUTBOUND:SENT"]);
  assert.ok(log.filter((m) => m.direction === "OUTBOUND").every((m) => m.latencyMs !== null && m.attempts === 1));

  // A new session on the website shows the conversation so far.
  const resumed = await chat(web.address, "session", { customer, customerHash: identityHash(web.secret!, customer) });
  assert.deepEqual(
    resumed.json<{ messages: { role: string }[] }>().messages.map((m) => m.role),
    ["USER", "ASSISTANT"],
  );
});

test("WhatsApp delivery receipts move forward only, and failures say why", async () => {
  script = [() => ({ text: "Sure." })];
  const id = await waSend({ type: "text", text: { body: "Status test" } });
  await settled(id);
  const out = await prisma.channelMessage.findFirstOrThrow({ where: { direction: "OUTBOUND", channel: "whatsapp" }, orderBy: { createdAt: "desc" } });
  const wamid = out.providerMessageId ?? "";
  const receipt = (status: string, errors?: object[]) =>
    waWebhook(waValue({ statuses: [{ id: wamid, status, timestamp: "1", recipient_id: WA_ID, ...(errors && { errors }) }] }));
  const statusOf = async () => (await prisma.channelMessage.findUniqueOrThrow({ where: { id: out.id } })).status;
  const becomes = (status: string) => until(async () => (await statusOf()) === status, `status ${status}`);
  await receipt("delivered");
  await becomes("DELIVERED");
  await receipt("sent"); // late
  await sleep(150);
  assert.equal(await statusOf(), "DELIVERED");
  await receipt("read");
  await becomes("READ");
  await receipt("failed", [{ code: 131026, title: "Message undeliverable" }]);
  await becomes("FAILED");
  assert.match((await prisma.channelMessage.findUniqueOrThrow({ where: { id: out.id } })).error ?? "", /131026.*may not use WhatsApp/);
});

test("WhatsApp sending: rate limits are retried, the 24-hour window is not", async () => {
  sendReplies = [{ status: 400, body: { error: { message: "Rate limit hit", type: "OAuthException", code: 130429 } } }];
  script = [() => ({ text: "First reply." })];
  const first = await waSend({ type: "text", text: { body: "one" } });
  await settled(first);
  const ok = await prisma.channelMessage.findFirstOrThrow({ where: { direction: "OUTBOUND", text: "First reply." } });
  assert.equal(ok.status, "SENT");
  assert.equal(ok.attempts, 2);

  sendReplies = [{ status: 400, body: { error: { message: "Re-engagement message", code: 131047, error_data: { details: "outside window" } } } }];
  script = [() => ({ text: "Too late." })];
  const second = await waSend({ type: "text", text: { body: "two" } });
  const inbound = await settled(second);
  assert.equal(inbound.status, "ANSWERED");
  const failed = await prisma.channelMessage.findFirstOrThrow({ where: { direction: "OUTBOUND", text: "Too late." } });
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.attempts, 1);
  assert.match(failed.error ?? "", /131047.*24 hours/);
});

test("WhatsApp files: voice notes are transcribed, documents read, images described, unsupported types answered", async () => {
  const voice = await waSend({ type: "audio", audio: { id: "media-voice", mime_type: "audio/ogg; codecs=opus", voice: true } });
  const row = await settled(voice);
  assert.equal(row.status, "ANSWERED");
  assert.equal(lastSaid(requests.at(-1)), "[Voice message, transcribed]: Can I book a demo for Friday?");
  assert.match(JSON.stringify(row.media), /Transcript: Can I book a demo for Friday\?/);

  const doc = await waSend({ type: "document", document: { id: "media-doc", mime_type: "text/plain", filename: "order.txt", caption: "my order" } });
  await settled(doc);
  const docText = String(lastSaid(requests.at(-1)));
  assert.match(docText, /sent the document "order.txt" with the caption "my order"/);
  assert.match(docText, /two blue chairs/);

  const image = await waSend({ type: "image", image: { id: "media-img", mime_type: "image/jpeg", caption: "broken leg" } });
  await settled(image);
  assert.match(String(lastSaid(requests.at(-1))), /sent an image with the caption "broken leg", which you cannot see/);

  const asked = requests.length;
  const poll = await waSend({ type: "unsupported", errors: [{ code: 131051 }] });
  const rejected = await settled(poll);
  assert.equal(rejected.status, "REJECTED");
  assert.equal(requests.length, asked, "the model is not asked");
  assert.match(sent.at(-1)?.text ?? "", /I can only read text, voice messages and documents/);

  // Reactions are not messages to answer.
  const before = sent.length;
  await waSend({ type: "reaction", reaction: { message_id: "x", emoji: "👍" } });
  await sleep(100);
  assert.equal(sent.length, before);
});

test("channel capability restrictions: tools per channel, identity required, allowed websites", async () => {
  // Web chat may use only email: the calendar is neither offered nor run, even if the model asks for it.
  const web = (await setChannel("web_chat", { allowedTools: ["send_email"], config: { allowedOrigins: ["https://shop.example"] } })).json<EmployeeChannelInfo>();
  const visitor = await chat(web.address, "session", {});
  assert.equal(visitor.statusCode, 200);
  const { token, visitorId } = visitor.json<{ token: string; visitorId: string }>();
  assert.match(visitorId, /^[0-9a-f-]{36}$/);
  script = [
    () => ({ calls: [{ id: "c1", name: "calendar_book_meeting", input: { title: "Demo", date: "2030-01-01", time: "10:00", durationMinutes: 30 } }] }),
    () => ({ text: "I can't book meetings here." }),
  ];
  const res = await chat(web.address, "messages", { message: "Book me a demo" }, { authorization: `Bearer ${token}` });
  assert.equal(res.statusCode, 200, res.payload);
  assert.deepEqual(requests[0]?.tools?.map((t) => t.name), ["send_email"]);
  const audit = await prisma.toolExecution.findFirstOrThrow({ where: { organizationId: orgA, tool: "calendar_book_meeting" }, orderBy: { createdAt: "desc" } });
  assert.equal(audit.status, "DENIED");
  assert.match(audit.error ?? "", /not available in this conversation/);

  // An anonymous visitor is their own customer, with no one else's memory.
  assert.match(requests[0]?.system ?? "", /You have not met this customer before/);
  const visitorCustomer = await prisma.customer.findFirstOrThrow({ where: { workspaceId: ws, externalId: `visitor:${visitorId}` } });
  assert.ok(visitorCustomer);

  // WhatsApp has no restriction: every granted tool is offered.
  const id = await waSend({ type: "text", text: { body: "What can you do?" } });
  await settled(id);
  assert.deepEqual(requests.at(-1)?.tools?.map((t) => t.name).sort(), ["calendar_book_meeting", "send_email"]);

  // Other websites cannot show the widget; tokens cannot be forged or moved between channels.
  assert.equal((await chat(web.address, "session", {}, { origin: "https://evil.example" })).statusCode, 403);
  assert.equal((await chat(web.address, "messages", { message: "hi" }, { authorization: "Bearer abc.def" })).statusCode, 401);
  assert.equal((await chat("wc_nope", "session", {})).statusCode, 404);

  // Identity required: anonymous visitors are refused.
  await setChannel("web_chat", { config: { requireIdentity: true } });
  assert.equal((await chat(web.address, "session", {})).statusCode, 403);
  // Turned off: the widget's key stops working.
  await setChannel("web_chat", { enabled: false, config: {} });
  assert.equal((await chat(web.address, "session", {})).statusCode, 404);
  await setChannel("web_chat", { config: {} });

  // The widget script and the preview page are served.
  const script_ = await app.inject({ method: "GET", url: "/widget.js" });
  assert.equal(script_.statusCode, 200);
  assert.match(String(script_.headers["content-type"]), /javascript/);
  const demo = await app.inject({ method: "GET", url: `/chat/${web.address}/demo` });
  assert.equal(demo.statusCode, 200);
  assert.match(demo.payload, new RegExp(`data-key="${web.address}"`));
});

test("not answering: a paused employee, a turned-off channel, a customer over the rate limit", async () => {
  const toPaused = await waSend({ type: "text", text: { body: "hello?" } }, WA_ID, PNID_PAUSED);
  const rejected = await settled(toPaused);
  assert.equal(rejected.status, "REJECTED");
  assert.match(rejected.error ?? "", /not published, or is paused/);

  await setChannel("whatsapp", { enabled: false, config: { phoneNumberId: PNID } });
  const off = await settled(await waSend({ type: "text", text: { body: "anyone?" } }));
  assert.equal(off.status, "REJECTED");
  assert.match(off.error ?? "", /turned off/);
  await setChannel("whatsapp", { config: { phoneNumberId: PNID } });

  const spammer = "+15550003333";
  const channel = await prisma.employeeChannel.findFirstOrThrow({ where: { employeeId: ava, kind: "whatsapp" } });
  await prisma.channelMessage.createMany({
    data: Array.from({ length: 20 }, () => ({ organizationId: orgA, workspaceId: ws, employeeId: ava, channelId: channel.id, channel: "whatsapp", direction: "INBOUND" as const, status: "ANSWERED" as const, from: spammer, text: "spam" })),
  });
  const limited = await settled(await waSend({ type: "text", text: { body: "one more" } }, spammer.slice(1)));
  assert.equal(limited.status, "REJECTED");
  assert.match(limited.error ?? "", /Rate limited/);
  assert.equal(sent.length, 0);
  assert.equal(requests.length, 0);
});

test("email: inbound emails are answered by email (test mode), and replies continue the thread", async () => {
  const saved = await setChannel("email", { config: { address: EMAIL.toUpperCase() } });
  assert.equal(saved.statusCode, 200, saved.payload);
  const info = saved.json<EmployeeChannelInfo>();
  assert.equal(info.address, EMAIL);
  const hook = new URL(info.url ?? "").pathname;

  assert.equal((await app.inject({ method: "POST", url: hook.replace(/[^/]+$/, "wrong"), payload: {} })).statusCode, 404);
  script = [() => ({ text: "Hello Priya,\n\nYes, we deliver on weekends.\n\nAva" })];
  const res = await app.inject({
    method: "POST",
    url: hook,
    payload: { from: '"Priya Shah" <Priya@Example.com>', subject: "Weekend delivery?", text: "Do you deliver on weekends?", messageId: "<m1@example.com>" },
  });
  assert.equal(res.statusCode, 202, res.payload);
  const first = await settled("<m1@example.com>");
  assert.equal(first.from, "priya@example.com");
  assert.match(requests[0]?.system ?? "", /answering the customer by email/);
  const reply = await prisma.channelMessage.findFirstOrThrow({ where: { direction: "OUTBOUND", channel: "email", conversationId: first.conversationId } });
  assert.equal(reply.status, "SENT");
  assert.match(reply.providerMessageId ?? "", /^<test-/);

  // The customer replies to our email, quoting it: the same conversation continues, without the quote.
  script = [() => ({ text: "You're welcome." })];
  await app.inject({
    method: "POST",
    url: hook,
    payload: {
      from: "priya@example.com",
      subject: "Re: Weekend delivery?",
      text: "Great, thanks!\n\nOn Tue, Ava wrote:\n> Yes, we deliver on weekends.",
      messageId: "<m2@example.com>",
      inReplyTo: reply.providerMessageId,
    },
  });
  const second = await settled("<m2@example.com>");
  assert.equal(second.conversationId, first.conversationId);
  assert.equal(lastSaid(requests[1]), "Great, thanks!");
});

test("channel settings: validation, roles, isolation, one number per employee, the message log", async () => {
  const bad = await setChannel("whatsapp", { config: { phoneNumberId: "+1 555" } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json<{ issues: { path: string }[] }>().issues[0]?.path, "phoneNumberId");
  assert.equal((await setChannel("web_chat", { config: { allowedOrigins: ["not a url"] } })).statusCode, 400);
  assert.equal((await setChannel("sms", { config: {} })).statusCode, 400);
  assert.equal((await setChannel("whatsapp", { config: { phoneNumberId: PNID } }, ava, memberOf(orgA))).statusCode, 403);
  // The paused employee answers PNID_PAUSED; Ava cannot take it.
  assert.equal((await setChannel("whatsapp", { config: { phoneNumberId: PNID_PAUSED } })).statusCode, 409);

  const asMember = (await call("GET", `/workspaces/${ws}/employees/${ava}/channels`, undefined, memberOf(orgA))).json<EmployeeChannels>();
  assert.deepEqual(asMember.whatsappProviders, ["meta", "twilio", "telnyx"]);
  assert.ok(asMember.channels.length >= 1);
  assert.ok(asMember.channels.every((c) => c.secret === null), "secrets are for admins");
  const asAdmin = (await call("GET", `/workspaces/${ws}/employees/${ava}/channels`)).json<EmployeeChannels>();
  assert.ok(asAdmin.channels.find((c) => c.kind === "whatsapp")?.url?.endsWith("/channels/whatsapp/meta/webhook"));

  // Another organization sees none of it.
  assert.equal((await call("GET", `/workspaces/${ws}/employees/${ava}/channels`, undefined, adminOf(orgB))).statusCode, 404);
  assert.equal((await call("GET", `/workspaces/${wsB}/employees/${ava}/channels`, undefined, adminOf(orgB))).statusCode, 404);
  assert.equal((await call("PUT", `/workspaces/${wsB}/employees/${ava}/channels/web_chat`, { config: {} }, adminOf(orgB))).statusCode, 404);
  assert.deepEqual((await call("GET", `/workspaces/${wsB}/channel-messages`, undefined, adminOf(orgB))).json(), []);
  assert.equal((await call("GET", `/workspaces/${ws}/channel-messages`, undefined, adminOf(orgB))).statusCode, 404);

  const whatsappOnly = await messages(`employeeId=${ava}&channel=whatsapp`);
  assert.ok(whatsappOnly.length > 0 && whatsappOnly.every((m) => m.channel === "whatsapp" && m.employeeId === ava));

  // Removing a channel stops it; its log stays.
  const paused_ = await prisma.employeeChannel.findFirstOrThrow({ where: { employeeId: paused, kind: "whatsapp" } });
  assert.equal((await call("DELETE", `/workspaces/${ws}/employees/${paused}/channels/whatsapp`)).statusCode, 204);
  assert.equal((await call("DELETE", `/workspaces/${ws}/employees/${paused}/channels/whatsapp`)).statusCode, 404);
  assert.ok((await prisma.channelMessage.count({ where: { channelId: paused_.id } })) > 0);
});

/** A published employee whose WhatsApp number is carried by `provider`. */
const employeeOn = async (name: string, provider: "twilio" | "telnyx", number: string) => {
  const id = (await call("POST", `/workspaces/${ws}/employees`, { ...defaultEmployeeConfig("UTC"), name, role: "Support" })).json<EmployeeDetail>().id;
  assert.equal((await call("POST", `/workspaces/${ws}/employees/${id}/publish`, { version: 1 })).statusCode, 200);
  const saved = await setChannel("whatsapp", { config: { provider, number } }, id);
  assert.equal(saved.statusCode, 200, saved.payload);
  const info = saved.json<EmployeeChannelInfo>();
  assert.equal(info.address, number);
  assert.equal(info.url, `${PUBLIC}/channels/whatsapp/${provider}/webhook`);
  return id;
};

test("WhatsApp through Twilio: signed form webhooks, replies through the Messages API, status callbacks, media, the 24-hour window", async () => {
  await employeeOn("Tina", "twilio", TW_NUMBER);
  const path = "/channels/whatsapp/twilio/webhook";
  const post = (params: Record<string, string>, query = "", signature = twilioSignature(TW_TOKEN, PUBLIC + path + query, params)) =>
    app.inject({
      method: "POST",
      url: path + query,
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
      payload: new URLSearchParams(params).toString(),
    });
  const message = (sid: string, extra: Record<string, string>) => ({
    MessageSid: sid,
    AccountSid: "ACtest",
    From: `whatsapp:${PHONE}`,
    To: `whatsapp:${TW_NUMBER}`,
    ProfileName: "Rahul",
    WaId: WA_ID,
    NumMedia: "0",
    ...extra,
  });

  assert.equal((await post(message("SMforged", { Body: "hi" }), "", "bad")).statusCode, 403);

  script = [() => ({ text: "Hello from Tina." })];
  const sid = `SMin${Date.now()}`;
  const res = await post(message(sid, { Body: "Hi, is anyone there?" }));
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["content-type"]), /^text\/xml/);
  assert.equal(res.payload, "<Response></Response>");
  const row = await settled(sid);
  assert.equal(row.status, "ANSWERED", row.error ?? "");
  const customer = await prisma.customer.findFirstOrThrow({ where: { workspaceId: ws, externalId: PHONE } });
  assert.equal(row.customerId, customer.id, "the same customer whichever provider carries the number");
  assert.equal(twilioSent.length, 1);
  assert.equal(twilioSent[0]?.get("From"), `whatsapp:${TW_NUMBER}`);
  assert.equal(twilioSent[0]?.get("To"), `whatsapp:${PHONE}`);
  assert.equal(twilioSent[0]?.get("Body"), "Hello from Tina.");
  assert.equal(twilioSent[0]?.get("StatusCallback"), `${PUBLIC}${path}?event=status`);

  // Status callbacks, signed over the callback URL with its query.
  const out = await prisma.channelMessage.findFirstOrThrow({ where: { direction: "OUTBOUND", conversationId: row.conversationId } });
  assert.equal((await post({ MessageSid: out.providerMessageId ?? "", MessageStatus: "read" }, "?event=status")).statusCode, 200);
  await until(async () => (await prisma.channelMessage.findUniqueOrThrow({ where: { id: out.id } })).status === "READ", "READ");

  // A voice note at a MediaUrl, downloaded with the account's credentials and transcribed.
  const voiceSid = `SMvoice${Date.now()}`;
  await post(
    message(voiceSid, {
      NumMedia: "1",
      MediaUrl0: "https://twilio.test/2010-04-01/Accounts/ACtest/Messages/MM1/Media/ME1",
      MediaContentType0: "audio/ogg; codecs=opus",
    }),
  );
  await settled(voiceSid);
  assert.equal(lastSaid(requests.at(-1)), "[Voice message, transcribed]: Can I book a demo for Friday?");

  // Outside the 24-hour window Twilio refuses (63016): logged in plain words, not retried.
  twilioReplies = [{ status: 400, body: { code: 63016, message: "Failed to send freeform message because you are outside the allowed window." } }];
  script = [() => ({ text: "Late reply." })];
  const lateSid = `SMlate${Date.now()}`;
  await post(message(lateSid, { Body: "Still there?" }));
  await settled(lateSid);
  const failed = await prisma.channelMessage.findFirstOrThrow({ where: { direction: "OUTBOUND", text: "Late reply." } });
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.attempts, 1);
  assert.match(failed.error ?? "", /63016.*24 hours/);

  // A webhook naming a number set up on another provider (Ava's, on Meta) is not answered.
  const wrongSid = `SMwrong${Date.now()}`;
  assert.equal((await post({ ...message(wrongSid, { Body: "hi" }), To: `whatsapp:${PNID}` })).statusCode, 200);
  await sleep(100);
  assert.equal(await inboundRow(wrongSid), null);
});

test("WhatsApp through Telnyx: Ed25519-signed webhooks, idempotent sends retried safely, delivery events, hosted media", async () => {
  await employeeOn("Tess", "telnyx", TX_NUMBER);
  const post = (event: object, at = Math.floor(Date.now() / 1000), key = telnyxKeys.privateKey) => {
    const raw = JSON.stringify(event);
    return app.inject({
      method: "POST",
      url: "/channels/whatsapp/telnyx/webhook",
      headers: {
        "content-type": "application/json",
        "telnyx-timestamp": String(at),
        "telnyx-signature-ed25519": sign(null, Buffer.from(`${at}|${raw}`), key).toString("base64"),
      },
      payload: raw,
    });
  };
  const received = (id: string, body: object, type = "WHATSAPP") => ({
    data: {
      event_type: "message.received",
      id: `evt-${id}`,
      record_type: "event",
      payload: { id, type, direction: "inbound", from: { phone_number: PHONE }, to: TX_NUMBER, body: { from: WA_ID, id: `wamid.${id}`, ...body } },
    },
  });

  const otherKey = generateKeyPairSync("ed25519").privateKey;
  assert.equal((await post(received("forged", { type: "text", text: { body: "x" } }), undefined, otherKey)).statusCode, 403);
  assert.equal((await post(received("old", { type: "text", text: { body: "x" } }), Math.floor(Date.now() / 1000) - 3600)).statusCode, 403);

  // The first send fails with a 503; the retry carries the same Idempotency-Key, so Telnyx sends once.
  telnyxReplies = [{ status: 503, body: { errors: [{ code: "10016", title: "Service unavailable" }] } }];
  script = [() => ({ text: "Hello from Tess." })];
  const id = `tx-in-${Date.now()}`;
  assert.equal((await post(received(id, { type: "text", text: { body: "Hi via Telnyx" } }))).statusCode, 200);
  const row = await settled(id);
  assert.equal(row.status, "ANSWERED", row.error ?? "");
  assert.equal(lastSaid(requests.at(-1)), "Hi via Telnyx");
  assert.equal(telnyxSent.length, 2);
  assert.ok(telnyxSent[0]?.key && telnyxSent[0].key === telnyxSent[1]?.key);
  const last = telnyxSent[1]?.body;
  assert.deepEqual(
    { from: last?.from, to: last?.to, text: last?.whatsapp_message.text.body, hook: last?.webhook_url },
    { from: TX_NUMBER, to: PHONE, text: "Hello from Tess.", hook: `${PUBLIC}/channels/whatsapp/telnyx/webhook` },
  );
  const out = await prisma.channelMessage.findFirstOrThrow({ where: { direction: "OUTBOUND", conversationId: row.conversationId } });
  assert.equal(out.status, "SENT");
  assert.equal(out.attempts, 2);

  // Delivery events.
  await post({
    data: {
      event_type: "message.finalized",
      id: "evt-delivered",
      payload: { id: out.providerMessageId, type: "WHATSAPP", direction: "outbound", to: [{ phone_number: PHONE, status: "delivered" }] },
    },
  });
  await until(async () => (await prisma.channelMessage.findUniqueOrThrow({ where: { id: out.id } })).status === "DELIVERED", "DELIVERED");

  // A document at a Telnyx-hosted URL, without a file name: read by its type, fetched without the API key.
  const doc = `tx-doc-${Date.now()}`;
  await post(received(doc, { type: "document", document: { url: "https://media.telnyx-hosted.test/m1", mime_type: "text/plain" } }));
  await settled(doc);
  assert.match(String(lastSaid(requests.at(-1))), /Invoice 77: total 120 EUR/);
  assert.deepEqual(telnyxDownloads, [{ url: "https://media.telnyx-hosted.test/m1", auth: null }]);

  // SMS on the same Telnyx profile is not WhatsApp: ignored.
  const sms = `tx-sms-${Date.now()}`;
  await post(received(sms, { type: "text", text: { body: "sms" } }, "SMS"));
  await sleep(100);
  assert.equal(await inboundRow(sms), null);
});
