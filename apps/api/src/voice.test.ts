// Needs the database from .env to be running (pnpm infra:up && pnpm db:migrate).
// A simulated Twilio connects over a real WebSocket and speaks Twilio's message format; the
// Twilio REST calls, speech recognition, speech synthesis and the model are faked.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, beforeEach, test } from "node:test";
import { AIProviderError, type AIProvider, type CompletionRequest, type ToolCall } from "@workforce/ai-provider";
import { prisma } from "@workforce/database";
import { EXTRACTION_PROMPT } from "@workforce/memory";
import { defaultEmployeeConfig, type CallDetail, type CallSummary, type EmployeeDetail, type Workspace } from "@workforce/shared";
import type { STTEvent, STTProvider } from "@workforce/stt";
import { TelephonyError, telnyxProvider, twilioProvider, twilioSignature, type TelephonyProvider } from "@workforce/telephony";
import { localTime } from "@workforce/tools";
import type { TTSProvider } from "@workforce/tts";
import type WebSocket from "ws";
import { buildApp } from "./app.ts";
import { adminOf, deleteOrgs, headerAuth, memberOf, newOrg } from "./testing.ts";
import { forSpeech, Speaker } from "./voice/speaker.ts";
import type { VoiceConfig } from "./voice/routes.ts";

const PUBLIC = "https://voice.example.test";
const TOKEN = "test-auth-token";
const NUMBER = "+15550001111";
const CALLER = "+15557654321";
const TELNYX_NUMBER = "+15550009999"; // owned by the Telnyx account only
const UNOWNED = "+15550008888"; // owned by neither account
const TZ = "Asia/Kolkata";
const orgA = newOrg();
const orgB = newOrg();
let app: Awaited<ReturnType<typeof buildApp>>;
let ws: string;
let wsB: string;
let ava: string;
let draft: string; // never published

// ---- Fakes ----

type Step = (req: CompletionRequest) => { text?: string; calls?: ToolCall[]; hang?: boolean; fail?: boolean };
let script: Step[] = [];
let requests: CompletionRequest[] = [];
const model: AIProvider = {
  name: "fake",
  model: "fake-1",
  async *stream(req) {
    // Customer memory runs after each saved turn; answer it without touching the script.
    if (req.system.startsWith(EXTRACTION_PROMPT)) {
      yield { type: "text", text: '{"memories":[]}' };
      yield { type: "done", inputTokens: 1, outputTokens: 1 };
      return;
    }
    requests.push(req);
    const step: Step = script.shift() ?? (() => ({ text: "OK." }));
    const { text, calls, hang, fail } = step(req);
    if (fail) throw new AIProviderError("unavailable", "down");
    if (text) yield { type: "text", text };
    if (hang) await new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    yield { type: "done", inputTokens: 1, outputTokens: 1, ...(calls && { toolCalls: calls }) };
  },
};

let caller: ((e: STTEvent) => void) | undefined;
let sttAudio: Buffer[] = [];
let sttClosed = false;
const stt: STTProvider = {
  name: "fake-stt",
  open({ onEvent }) {
    caller = onEvent;
    sttClosed = false;
    return { send: (audio) => void sttAudio.push(audio), close: () => void (sttClosed = true) };
  },
};

let synthesized: string[] = [];
// "Audio" is the sentence's text, so the test can read what the caller heard.
const tts: TTSProvider = {
  name: "fake-tts",
  synthesize(text, { signal }) {
    synthesized.push(text);
    return (async function* () {
      await sleep(2);
      if (!signal.aborted) yield Buffer.from(text);
    })();
  },
};

const real = twilioProvider({ accountSid: "ACtest", authToken: TOKEN });
let placed: Parameters<TelephonyProvider["placeCall"]>[0][] = [];
let ended: string[] = [];
let placeFails = false;
const telephony: TelephonyProvider = {
  ...real,
  async placeCall(options) {
    if (placeFails) throw new (await import("@workforce/telephony")).TelephonyError("Twilio answered 400: unverified number");
    placed.push(options);
    return { providerCallId: `CA-out-${placed.length}` };
  },
  async endCall(sid) {
    ended.push(sid);
  },
  async configureNumber(number) {
    if (number === TELNYX_NUMBER || number === UNOWNED) throw new TelephonyError(`${number} is not a number in this Twilio account`);
    return { providerNumberId: "PN0123456789abcdef0123456789abcdef" };
  },
};
// Telnyx's real message formats and webhook check; its REST calls are faked.
const TELNYX_KEY = "telnyx-test-key";
const telnyxToken = createHmac("sha256", TELNYX_KEY).update("telnyx-webhook").digest("hex");
let telnyxPlaced: Parameters<TelephonyProvider["placeCall"]>[0][] = [];
const telnyx: TelephonyProvider = {
  ...telnyxProvider({ apiKey: TELNYX_KEY, accountSid: "acct", applicationId: "app1" }),
  async placeCall(options) {
    telnyxPlaced.push(options);
    return { providerCallId: null }; // as Telnyx's API reference describes: no id until the first callback
  },
  async endCall(sid) {
    ended.push(sid);
  },
  async configureNumber(number) {
    if (number !== TELNYX_NUMBER) throw new TelephonyError(`${number} is not a number in this Telnyx account`);
    return { providerNumberId: "tn-1" };
  },
};
const voice: VoiceConfig = { telephony: [telephony, telnyx], stt, tts, publicUrl: PUBLIC, secret: TOKEN, limits: { idleMs: 60_000, maxCallMs: 600_000 } };

// ---- Helpers ----

type Headers = Record<string, string>;
const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object, headers: Headers = adminOf(orgA)) =>
  app.inject({ method, url, headers, payload });

/** A webhook from Twilio, signed like Twilio signs it. */
const webhook = (path: string, params: Record<string, string>, signature = twilioSignature(TOKEN, PUBLIC + path, params)) =>
  app.inject({
    method: "POST",
    url: path,
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
    payload: new URLSearchParams(params).toString(),
  });

const until = async (ok: () => boolean | Promise<boolean>, what: string, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(10);
  }
};

/** Twilio's side of one call's media stream. */
async function phoneCall(callSid: string, twiml: string) {
  const callId = /name="callId" value="([^"]+)"/.exec(twiml)?.[1] ?? "";
  const token = /name="token" value="([^"]+)"/.exec(twiml)?.[1] ?? "";
  const socket: WebSocket = await app.injectWS("/voice/twilio/stream");
  const got: { event: string; media?: { payload: string }; mark?: { name: string } }[] = [];
  let closed = false;
  socket.on("message", (data) => got.push(JSON.parse(data.toString())));
  socket.on("close", () => (closed = true));
  const echoed = new Set<string>();
  const sendJson = (m: object) => socket.send(JSON.stringify(m));
  sendJson({ event: "connected", protocol: "Call", version: "1.0.0" });
  sendJson({
    event: "start",
    sequenceNumber: "1",
    streamSid: "MZ1",
    start: {
      accountSid: "ACtest",
      streamSid: "MZ1",
      callSid,
      tracks: ["inbound"],
      mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
      customParameters: { callId, token },
    },
  });
  return {
    callId,
    got,
    closed: () => closed,
    /** Everything the caller has been sent to hear, in order. */
    heard: () =>
      got
        .filter((m) => m.event === "media")
        .map((m) => Buffer.from(m.media?.payload ?? "", "base64").toString())
        .join(" "),
    /** Twilio reports that buffered audio finished playing. */
    playAll() {
      for (const m of got)
        if (m.event === "mark" && m.mark && !echoed.has(m.mark.name)) {
          echoed.add(m.mark.name);
          sendJson({ event: "mark", sequenceNumber: "9", streamSid: "MZ1", mark: { name: m.mark.name } });
        }
    },
    audio: (bytes: string) =>
      sendJson({ event: "media", streamSid: "MZ1", media: { track: "inbound", chunk: "1", timestamp: "5", payload: Buffer.from(bytes).toString("base64") } }),
    hangUp: () => sendJson({ event: "stop", sequenceNumber: "10", streamSid: "MZ1", stop: { accountSid: "ACtest", callSid } }),
    socket,
  };
}

const inbound = async (callSid: string, from = CALLER, to = NUMBER) => {
  const res = await webhook("/voice/twilio/inbound", { CallSid: callSid, From: from, To: to, CallStatus: "ringing", AccountSid: "ACtest" });
  assert.equal(res.statusCode, 200, res.payload);
  return res.payload;
};
const transcript = async (callId: string) =>
  (await call("GET", `/workspaces/${ws}/calls/${callId}`, undefined, memberOf(orgA))).json<CallDetail>().transcript;
/** The caller listens to the whole greeting (Twilio echoes its marks) before saying anything. */
const greeted = (phone: Awaited<ReturnType<typeof phoneCall>>) =>
  until(async () => (phone.playAll(), (await transcript(phone.callId)).length >= 1), "the greeting to finish");

before(async () => {
  app = await buildApp({ authenticate: headerAuth, provider: model, logger: false, voice });
  await app.ready();
  const workspaceOf = async (org: string) => (await call("GET", "/workspaces", undefined, adminOf(org))).json<Workspace[]>()[0]?.id ?? "";
  ws = await workspaceOf(orgA);
  wsB = await workspaceOf(orgB);
  const create = async (name: string) =>
    (await call("POST", `/workspaces/${ws}/employees`, { ...defaultEmployeeConfig(TZ), name, role: "Sales assistant" })).json<EmployeeDetail>().id;
  ava = await create("Ava");
  draft = await create("Draft");
  assert.equal((await call("POST", `/workspaces/${ws}/employees/${ava}/publish`, { version: 1 })).statusCode, 200);
  assert.equal((await call("PUT", `/workspaces/${ws}/employees/${ava}/tools`, { tools: [{ name: "calendar_book_meeting" }] })).statusCode, 200);
  const added = await call("POST", `/workspaces/${ws}/phone-numbers`, { number: NUMBER, employeeId: ava });
  assert.equal(added.statusCode, 201, added.payload);
  assert.equal((await call("POST", `/workspaces/${ws}/phone-numbers`, { number: "+15550002222", employeeId: draft })).statusCode, 201);
});
beforeEach(() => {
  script = [];
  requests = [];
  sttAudio = [];
  synthesized = [];
  placed = [];
  telnyxPlaced = [];
  ended = [];
  placeFails = false;
});
after(async () => {
  // Closing ends any call still open; let those sessions record their end before cleaning up.
  await app.close();
  await sleep(200);
  await deleteOrgs(orgA, orgB);
});

test("a phone call: the customer speaks, STT, the employee runtime with its tools, TTS, the customer hears the answer", async () => {
  const twiml = await inbound("CA1");
  assert.match(twiml, /<Connect><Stream url="wss:\/\/voice\.example\.test\/voice\/twilio\/stream">/);
  const phone = await phoneCall("CA1", twiml);

  // The employee picks up and greets the caller.
  await greeted(phone);
  assert.match(phone.heard(), /Hi, this is Ava\. How can I help you today\?/);

  // The caller's audio goes to speech recognition untouched.
  phone.audio("caller audio bytes");
  await until(() => sttAudio.length === 1, "audio at STT");
  assert.equal(sttAudio[0]?.toString(), "caller audio bytes");

  const date = localTime(new Date(Date.now() + 24 * 3600_000), TZ).slice(0, 10);
  script = [
    (req) => {
      // Same runtime as chat: the employee's instructions, its tools, plus the phone-call style.
      assert.match(req.system, /You are Ava, an AI employee working as: Sales assistant/);
      assert.match(req.system, /phone call, and everything you write is read aloud/);
      assert.ok(req.tools?.some((t) => t.name === "calendar_book_meeting"));
      assert.deepEqual(req.messages, [{ role: "user", content: "Book me a meeting tomorrow at 3 PM." }]);
      return { text: "One moment while I book that.", calls: [{ id: "c1", name: "calendar_book_meeting", input: { title: "Call booking", date, time: "15:00" } }] };
    },
    () => ({ text: "Your meeting is booked for tomorrow at **3 PM**. Anything else?" }),
  ];
  caller?.({ type: "partial", text: "Book me" }); // nobody is talking yet: not a barge-in
  caller?.({ type: "turn", text: "Book me a meeting tomorrow at 3 PM." });
  await until(() => phone.heard().includes("Anything else?"), "the answer");
  assert.match(phone.heard(), /One moment while I book that\. Your meeting is booked for tomorrow at 3 PM\. Anything else\?/);
  assert.ok(!phone.got.some((m) => m.event === "clear"));
  phone.playAll();

  // A second turn continues the same conversation.
  script = [(req) => ({ text: req.messages.length === 3 ? "Goodbye!" : "wrong history" })];
  caller?.({ type: "turn", text: "Thanks, bye." });
  await until(() => phone.heard().includes("Goodbye!"), "the second answer");
  phone.playAll();
  await until(async () => (await transcript(phone.callId)).length === 5, "five transcript lines");

  phone.hangUp();
  await until(async () => (await prisma.call.findUnique({ where: { id: phone.callId } }))?.status === "COMPLETED", "the call to end");
  assert.ok(sttClosed);

  const stored = await prisma.call.findUniqueOrThrow({ where: { id: phone.callId }, include: { participants: true } });
  assert.deepEqual([stored.direction, stored.from, stored.to, stored.providerCallId, stored.streamId], ["INBOUND", CALLER, NUMBER, "CA1", "MZ1"]);
  assert.ok(stored.answeredAt && stored.endedAt);
  assert.deepEqual(stored.participants.map((p) => p.role).sort(), ["CUSTOMER", "EMPLOYEE"]);

  // The conversation is the runtime's, on the voice channel, linked to the caller as a customer.
  const conversation = await prisma.conversation.findUniqueOrThrow({
    where: { id: stored.conversationId ?? "" },
    include: { messages: { orderBy: { createdAt: "asc" } }, customer: { include: { customer: true } } },
  });
  assert.equal(conversation.channel, "voice");
  assert.equal(conversation.customer?.customer.externalId, CALLER);
  assert.deepEqual(
    conversation.messages.map((m) => m.content),
    [
      "Book me a meeting tomorrow at 3 PM.",
      "One moment while I book that.\n\nYour meeting is booked for tomorrow at **3 PM**. Anything else?",
      "Thanks, bye.",
      "Goodbye!",
    ],
  );
  // The tool really ran.
  const event = await prisma.calendarEvent.findFirstOrThrow({ where: { conversationId: conversation.id } });
  assert.equal(localTime(event.startsAt, TZ), `${date} 15:00`);

  assert.deepEqual(
    (await transcript(phone.callId)).map((t) => [t.speaker, t.text]),
    [
      ["EMPLOYEE", "Hi, this is Ava. How can I help you today?"],
      ["CUSTOMER", "Book me a meeting tomorrow at 3 PM."],
      ["EMPLOYEE", "One moment while I book that. Your meeting is booked for tomorrow at 3 PM. Anything else?"],
      ["CUSTOMER", "Thanks, bye."],
      ["EMPLOYEE", "Goodbye!"],
    ],
  );

  // Twilio's final status callback records the billed duration.
  assert.equal((await webhook("/voice/twilio/status", { CallSid: "CA1", CallStatus: "completed", CallDuration: "42" })).statusCode, 204);
  assert.equal((await prisma.call.findUniqueOrThrow({ where: { id: phone.callId } })).durationSec, 42);
});

test("barge-in: the caller talking over the employee stops it, and an unsaved turn is carried into the next", async () => {
  const phone = await phoneCall("CA2", await inbound("CA2"));
  await greeted(phone);

  script = [() => ({ text: "Let me tell you about all of our plans in detail. ", hang: true })];
  caller?.({ type: "turn", text: "Tell me about your plans" });
  await until(() => phone.heard().includes("Let me tell you"), "the employee to start talking");

  // Real words while the employee talks: stop the audio, abandon the reply.
  caller?.({ type: "partial", text: "wait" });
  await until(() => phone.got.some((m) => m.event === "clear"), "a clear message");

  script = [(req) => ({ text: req.messages.at(-1)?.role === "user" ? "Enterprise is 499 dollars a month." : "?" })];
  caller?.({ type: "turn", text: "actually just the enterprise price" });
  await until(() => phone.heard().includes("499 dollars"), "the new answer");
  // The cut-off turn was never saved, so what the caller said then is part of this turn.
  assert.deepEqual(requests.at(-1)?.messages.at(-1), {
    role: "user",
    content: "Tell me about your plans actually just the enterprise price",
  });
  phone.playAll();
  await until(async () => (await transcript(phone.callId)).some((t) => t.text.includes("499")), "the transcript");
  const lines = await transcript(phone.callId);
  assert.deepEqual(
    lines.filter((t) => t.speaker === "EMPLOYEE").map((t) => [t.text, t.interrupted]),
    [
      ["Hi, this is Ava. How can I help you today?", false],
      ["Let me tell you about all of our plans in detail.", true],
      ["Enterprise is 499 dollars a month.", false],
    ],
  );
  phone.hangUp();
  await until(() => sttClosed, "the call to end");
});

test("error recovery: a failed reply is apologised for, lost speech recognition ends the call politely, bad streams are refused", async () => {
  const phone = await phoneCall("CA3", await inbound("CA3"));
  await greeted(phone);

  script = [() => ({ fail: true })];
  caller?.({ type: "turn", text: "Hello?" });
  await until(() => phone.heard().includes("Sorry, I had trouble with that"), "the apology");
  phone.playAll();

  caller?.({ type: "error", error: new Error("lost") });
  await until(() => phone.heard().includes("trouble hearing you"), "the goodbye");
  // Twilio plays it, then the employee hangs up.
  await until(() => (phone.playAll(), ended.includes("CA3")), "the hang-up");
  phone.hangUp();

  // A stream without a valid token is closed at once (Twilio then plays the fallback and hangs up).
  const twiml = (await inbound("CA4")).replace(/name="token" value="[^"]+"/, 'name="token" value="forged"');
  const forged = await phoneCall("CA4", twiml);
  await until(() => forged.closed(), "the forged stream to be closed");
  assert.equal(forged.heard(), "");
});

test("silence: the employee checks in, then hangs up", async () => {
  voice.limits.idleMs = 100;
  try {
    const phone = await phoneCall("CA5", await inbound("CA5"));
    await greeted(phone);
    await until(() => (phone.playAll(), phone.heard().includes("end the call now")), "the check-in, then the goodbye");
    assert.match(phone.heard(), /Are you still there\?/);
    await until(() => (phone.playAll(), ended.includes("CA5")), "the hang-up");
    phone.hangUp();
  } finally {
    voice.limits.idleMs = 60_000;
  }
});

test("inbound webhooks: signatures are checked, unknown numbers and unpublished employees are turned away, retries make one call", async () => {
  const params = { CallSid: "CA6", From: CALLER, To: NUMBER, CallStatus: "ringing" };
  assert.equal((await webhook("/voice/twilio/inbound", params, "bad-signature")).statusCode, 403);
  // Signed for another URL.
  assert.equal((await webhook("/voice/twilio/inbound", params, twilioSignature(TOKEN, `${PUBLIC}/other`, params))).statusCode, 403);

  assert.match(await inbound("CA7", CALLER, "+15559999999"), /<Say>This number is not in service\.<\/Say><Hangup\/>/);
  assert.match(await inbound("CA8", CALLER, "+15550002222"), /no one is available/);

  await inbound("CA6");
  await inbound("CA6");
  assert.equal(await prisma.call.count({ where: { providerCallId: "CA6" } }), 1);
});

test("outbound calls: placed through the employee's number, status callbacks move the state", async () => {
  const res = await call("POST", `/workspaces/${ws}/employees/${ava}/calls`, { to: "+15551234567" });
  assert.equal(res.statusCode, 201, res.payload);
  const placedCall = res.json<CallSummary>();
  assert.deepEqual([placedCall.direction, placedCall.status, placedCall.from, placedCall.to], ["OUTBOUND", "QUEUED", NUMBER, "+15551234567"]);
  const [request] = placed;
  assert.equal(request?.streamUrl, "wss://voice.example.test/voice/twilio/stream");
  assert.equal(request?.statusCallbackUrl, `${PUBLIC}/voice/twilio/status?callId=${placedCall.id}`);
  assert.equal(request?.parameters.callId, placedCall.id);

  await webhook("/voice/twilio/status", { CallSid: "CA-out-1", CallStatus: "ringing" });
  assert.equal((await prisma.call.findUniqueOrThrow({ where: { id: placedCall.id } })).status, "RINGING");

  // The callee answers: the stream starts and the employee opens with the outbound greeting.
  const phone = await phoneCall("CA-out-1", real.connectToStream("wss://x", request?.parameters ?? {}));
  await greeted(phone);
  assert.match(phone.heard(), /Is now a good time to talk\?/);
  phone.hangUp();
  await until(async () => (await prisma.call.findUniqueOrThrow({ where: { id: placedCall.id } })).status === "COMPLETED", "the end");

  assert.equal((await call("POST", `/workspaces/${ws}/employees/${ava}/calls`, { to: "+15551234567" }, memberOf(orgA))).statusCode, 403);
  assert.equal((await call("POST", `/workspaces/${ws}/employees/${draft}/calls`, { to: "+15551234567" })).statusCode, 409);
  assert.equal((await call("POST", `/workspaces/${ws}/employees/${ava}/calls`, { to: "555-1234" })).statusCode, 400);
  placeFails = true;
  const failed = await call("POST", `/workspaces/${ws}/employees/${ava}/calls`, { to: "+15551234567" });
  assert.equal(failed.statusCode, 502);
  assert.match(failed.payload, /unverified number/);
  assert.equal(await prisma.call.count({ where: { organizationId: orgA, status: "FAILED" } }), 1);
});

test("phone numbers and calls: admins configure, members read, other organizations see nothing", async () => {
  assert.equal((await call("POST", `/workspaces/${ws}/phone-numbers`, { number: NUMBER, employeeId: ava })).statusCode, 409);
  assert.equal((await call("POST", `/workspaces/${ws}/phone-numbers`, { number: "+15550003333", employeeId: ava }, memberOf(orgA))).statusCode, 403);
  assert.equal((await call("POST", `/workspaces/${wsB}/phone-numbers`, { number: "+15550004444", employeeId: ava }, adminOf(orgB))).statusCode, 404);
  assert.equal((await call("GET", `/workspaces/${ws}/phone-numbers`, undefined, memberOf(orgA))).json<unknown[]>().length, 2);

  const calls = (await call("GET", `/workspaces/${ws}/calls?employeeId=${ava}`, undefined, memberOf(orgA))).json<CallSummary[]>();
  assert.ok(calls.length >= 5);
  assert.equal((await call("GET", `/workspaces/${ws}/calls/${calls[0]?.id}`, undefined, memberOf(orgB))).statusCode, 404);
  assert.deepEqual((await call("GET", `/workspaces/${wsB}/calls`, undefined, memberOf(orgB))).json(), []);

  // Without telephony configured, voice routes say what is missing.
  const bare = await buildApp({ authenticate: headerAuth, provider: model, logger: false, voice: { ...voice, telephony: [], publicUrl: null } });
  const res = await bare.inject({ method: "POST", url: `/workspaces/${ws}/employees/${ava}/calls`, headers: adminOf(orgA), payload: { to: "+15551234567" } });
  assert.equal(res.statusCode, 503);
  assert.match(res.payload, /TWILIO_ACCOUNT_SID.*PUBLIC_URL/);
  await bare.close();
});

test("Twilio signatures match Twilio's published example", () => {
  const params = { CallSid: "CA1234567890ABCDE", Caller: "+14158675309", Digits: "1234", From: "+14158675309", To: "+18005551212" };
  assert.equal(twilioSignature("12345", "https://mycompany.com/myapp.php?foo=1&bar=2", params), "RSOYDt4T1cUTdK1PDd93/VVr8B8=");
});

test("speech: text is cut into sentences as it streams, and formatting is not read out", async () => {
  const said: string[] = [];
  const speaker = new Speaker(tts, "en", { audio: (a) => said.push(a.toString()), mark: () => {}, clear: () => {} }, () => {});
  speaker.push("It costs 4.99 dollars. Want");
  speaker.push(" it? Great");
  speaker.end();
  await until(() => said.length === 3, "three sentences");
  assert.deepEqual(said, ["It costs 4.99 dollars.", "Want it?", "Great"]);
  assert.equal(forSpeech("**Book** it at [our site](https://x.y) #now"), "Book it at our site now");
});

test("Telnyx: a number is matched to the account that owns it, webhooks need the token, calls stream in Telnyx's format", async () => {
  const added = await call("POST", `/workspaces/${ws}/phone-numbers`, { number: TELNYX_NUMBER, employeeId: ava });
  assert.equal(added.statusCode, 201, added.payload);
  assert.equal((await prisma.phoneNumber.findUniqueOrThrow({ where: { number: TELNYX_NUMBER } })).provider, "telnyx");
  // A number neither account owns names both refusals.
  const unowned = await call("POST", `/workspaces/${ws}/phone-numbers`, { number: UNOWNED, employeeId: ava });
  assert.equal(unowned.statusCode, 502);
  assert.match(unowned.payload, /Twilio account.*Telnyx account/);

  const telnyxHook = (path: string, params: Record<string, string>, token = telnyxToken) =>
    app.inject({
      method: "POST",
      url: `${path}${path.includes("?") ? "&" : "?"}token=${token}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams(params).toString(),
    });
  const params = { CallSid: "v3:in-1", AccountSid: "acct", From: CALLER, To: TELNYX_NUMBER, CallStatus: "ringing" };
  assert.equal((await telnyxHook("/voice/telnyx/inbound", params, "wrong")).statusCode, 403);
  // The number belongs to Telnyx, so a Twilio webhook for it is turned away.
  assert.match((await webhook("/voice/twilio/inbound", params)).payload, /not in service/);
  const answer = await telnyxHook("/voice/telnyx/inbound", params);
  assert.equal(answer.statusCode, 200, answer.payload);
  assert.match(answer.payload, /<Stream url="wss:\/\/voice\.example\.test\/voice\/telnyx\/stream" bidirectionalMode="rtp" bidirectionalCodec="PCMU">/);
  const callId = /name="callId" value="([^"]+)"/.exec(answer.payload)?.[1] ?? "";
  const token = /name="token" value="([^"]+)"/.exec(answer.payload)?.[1] ?? "";
  assert.equal((await prisma.call.findUniqueOrThrow({ where: { id: callId } })).provider, "telnyx");

  // Telnyx's side of the media stream.
  const socket: WebSocket = await app.injectWS("/voice/telnyx/stream");
  const got: { event: string; stream_id?: string; media?: { payload: string } }[] = [];
  socket.on("message", (data) => got.push(JSON.parse(data.toString())));
  const send = (m: object) => socket.send(JSON.stringify(m));
  send({ event: "connected", version: "1.0.0" });
  send({ event: "start", sequence_number: "1", stream_id: "st-1", start: { call_control_id: "v3:in-1", custom_parameters: { callId, token } } });
  const heard = () => got.map((m) => Buffer.from(m.media?.payload ?? "", "base64").toString()).join(" ");
  await until(() => /How can I help you today\?/.test(heard()), "the greeting");
  assert.ok(got.every((m) => m.stream_id === undefined));
  send({ event: "stop", sequence_number: "2", stream_id: "st-1", stop: { call_control_id: "v3:in-1" } });
  await until(async () => (await prisma.call.findUniqueOrThrow({ where: { id: callId } })).endedAt !== null, "the end");
  socket.terminate();

  // Outbound from the Telnyx number: Telnyx gives no call id, the first status callback supplies it.
  const number = await prisma.phoneNumber.findUniqueOrThrow({ where: { number: TELNYX_NUMBER } });
  const res = await call("POST", `/workspaces/${ws}/employees/${ava}/calls`, { to: "+15551234567", phoneNumberId: number.id });
  assert.equal(res.statusCode, 201, res.payload);
  const out = res.json<CallSummary>();
  assert.equal(telnyxPlaced.length, 1);
  assert.equal(placed.length, 0);
  assert.equal(telnyxPlaced[0]?.statusCallbackUrl, `${PUBLIC}/voice/telnyx/status?callId=${out.id}`);
  assert.equal((await telnyxHook(`/voice/telnyx/status?callId=${out.id}`, { CallSid: "v3:out-1", CallStatus: "ringing" }, "wrong")).statusCode, 403);
  assert.equal((await telnyxHook(`/voice/telnyx/status?callId=${out.id}`, { CallSid: "v3:out-1", CallStatus: "ringing" })).statusCode, 204);
  let row = await prisma.call.findUniqueOrThrow({ where: { id: out.id } });
  assert.deepEqual([row.provider, row.providerCallId, row.status], ["telnyx", "v3:out-1", "RINGING"]);
  await telnyxHook(`/voice/telnyx/status?callId=${out.id}`, { CallSid: "v3:out-1", CallStatus: "no-answer", CallDuration: "0" });
  row = await prisma.call.findUniqueOrThrow({ where: { id: out.id } });
  assert.deepEqual([row.status, row.durationSec], ["NO_ANSWER", 0]);
});
