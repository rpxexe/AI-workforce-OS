// Phase 15: India-first conversation intelligence. The analyzers (language, code-switching, entities,
// sentiment, intent, resolution, escalation) on English, Hindi, Hinglish and mixed-script examples; the
// reply-language and locale guidance in the system prompt; Hinglish handoff requests and lakh/crore
// amounts; memory refusing Aadhaar/PAN; voice formatting and speech-provider language mapping; and the
// API (conversation detail and workspace overview), with roles and tenant isolation.
// The API tests need the database from .env (pnpm infra:up && pnpm db:migrate).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  analyzeConversation,
  asksForHuman,
  detectLanguage,
  extractEntities,
  languageProfile,
  regionOf,
  systemPrompt,
  toNumber,
  type ExtractedEntity,
} from "@workforce/agent-runtime";
import { prisma } from "@workforce/database";
import { validFact } from "@workforce/memory";
import { defaultEmployeeConfig, type EmployeeConfig, type EmployeeDetail, type InboxConversation, type InsightsOverview, type Workspace } from "@workforce/shared";
import { deepgramProvider } from "@workforce/stt";
import { elevenLabsProvider } from "@workforce/tts";
import { analyzeInsights, quietInsights, refreshInsights } from "./inbox.ts";
import { adminOf, deleteOrgs, memberOf, newOrg, testApp } from "./testing.ts";
import { forSpeech, spokenRupees } from "./voice/speaker.ts";

const INDIA = { region: "IN", timezone: "Asia/Kolkata", now: new Date("2026-11-24T06:00:00Z") }; // Tuesday 24 Nov, 11:30 IST
const pick = (entities: ExtractedEntity[], type: ExtractedEntity["type"]) => entities.filter((e) => e.type === type).map((e) => e.value);

test("language: English, Hindi, Hinglish, mixed script and other Indian scripts", () => {
  const cases: [string, string, boolean][] = [
    ["Hello, I want to cancel my order", "en", false],
    ["Is it available in Pune?", "en", false],
    ["ok", "en", false],
    ["मेरा ऑर्डर कब आएगा?", "hi", false],
    ["मेरा ऑर्डर OD12345 कब आएगा", "hi", false], // an order id is not English
    ["aapka naam kya hai", "hinglish", false], // Hindi in Roman script
    ["theek hai", "hinglish", false],
    ["Mujhe refund chahiye", "hinglish", true],
    ["mera order kab aayega, tracking bhi nahi dikh raha", "hinglish", true],
    ["मेरा order कब आएगा", "hinglish", true], // Devanagari with English words
    ["ধন্যবাদ, আমার অর্ডার কোথায়?", "bn", false],
    ["என் ஆர்டர் எங்கே?", "ta", false],
    ["Hola, quiero cancelar mi pedido", "other", false],
    ["12345", "unknown", false],
  ];
  for (const [text, language, codeSwitched] of cases) assert.deepEqual(detectLanguage(text), { language, codeSwitched }, text);

  const profile = languageProfile(["Hi, my order is late", "kab tak aayega bhai?", "मुझे अभी चाहिए", "ok", "12345", "thik hai, thanks"]);
  assert.deepEqual(profile.guesses.map((g) => g.language), ["en", "hinglish", "hi", "en", "unknown", "hinglish"]);
  assert.equal(profile.switches, 4, "unknown messages do not count as a switch");
  assert.equal(profile.primaryLanguage, "en", "a tie goes to the language used first");
  assert.equal(profile.codeSwitchedMessages, 1);
});

test("entities in English: name, order id, phone with +91, email", () => {
  const e = extractEntities("Hi, my name is Rahul Sharma. My order OD4312345678 hasn't arrived, call me on +91 98765 43210 or mail rahul.s@example.co.in", INDIA);
  assert.deepEqual(pick(e, "person_name"), ["Rahul Sharma"]);
  assert.deepEqual(pick(e, "order_id"), ["OD4312345678"]);
  assert.deepEqual(pick(e, "phone"), ["+919876543210"]);
  assert.deepEqual(pick(e, "email"), ["rahul.s@example.co.in"]);
  assert.deepEqual(pick(extractEntities("This is Priya from Pune. I am interested in the gold plan."), "person_name"), ["Priya"]);
  assert.deepEqual(pick(extractEntities("I am looking for a refund. This is Very urgent."), "person_name"), [], "not names");
});

test("entities in Hindi: Devanagari names, Hindi digits, months, kal by tense, shaam ke baje", () => {
  const e = extractEntities("मेरा नाम प्रिया वर्मा है। मेरा नंबर ९८७६५४३२१० है। डिलीवरी 5 दिसंबर को चाहिए, शाम 6 बजे", INDIA);
  assert.deepEqual(pick(e, "person_name"), ["प्रिया वर्मा"]);
  assert.deepEqual(pick(e, "phone"), ["+919876543210"], "Devanagari digits read as numbers");
  assert.deepEqual(pick(e, "date"), ["2026-12-05"]);
  assert.deepEqual(pick(e, "time"), ["18:00"]);
  assert.deepEqual(pick(extractEntities("मैं सुरेश बोल रहा हूँ, कल आऊँगा", INDIA), "date"), ["2026-11-25"], "kal, future: tomorrow");
  assert.deepEqual(pick(extractEntities("कल ऑर्डर किया था", INDIA), "date"), ["2026-11-23"], "kal, past: yesterday");
  assert.deepEqual(pick(extractEntities("₹2,500 का रिफंड चाहिए, 3 लाख का बजट है", INDIA), "amount"), ["2500", "300000"]);
});

test("entities in Hinglish: names, lakh, parso, baje, UPI, payment methods, past kal", () => {
  const e = extractEntities("mera naam amit kumar hai, budget around 5 lakh hai, delivery parso shaam 5 baje kar dena, payment GPay se karunga", INDIA);
  assert.deepEqual(pick(e, "person_name"), ["Amit Kumar"]);
  assert.deepEqual(pick(e, "amount"), ["500000"]);
  assert.equal(e.find((x) => x.type === "amount")?.details?.currency, "INR");
  assert.deepEqual(pick(e, "date"), ["2026-11-26"]);
  assert.deepEqual(pick(e, "time"), ["17:00"]);
  assert.deepEqual(pick(e, "payment_method"), ["Google Pay"]);

  const refund = extractEntities("mujhe refund chahiye 2,499 rupees ka, payment UPI se kiya tha kal, order #20451", INDIA);
  assert.deepEqual(pick(refund, "amount"), ["2499"]);
  assert.deepEqual(pick(refund, "date"), ["2026-11-23"], "kiya tha: kal is yesterday");
  assert.deepEqual(pick(refund, "order_id"), ["20451"]);
  assert.deepEqual(pick(extractEntities("main Suresh bol raha hoon, saade 3 baje aaunga, agle somvar", INDIA), "time"), ["03:30"]);
  assert.deepEqual(pick(extractEntities("agle somvar aana", INDIA), "date"), ["2026-11-30"], "next Monday");
  assert.deepEqual(pick(extractEntities("1.2 crore ka project hai, 50k advance", INDIA), "amount"), ["12000000", "50000"]);
});

test("addresses, PIN codes, business ids, masked Aadhaar and PAN, other phone formats", () => {
  const [address] = extractEntities("Address: Flat 12, Green Park Society, Baner Road, near Balewadi Phata, Pune 411045. Please deliver by Friday.", INDIA).filter(
    (x) => x.type === "address",
  );
  assert.equal(address?.value, "Flat 12, Green Park Society, Baner Road, near Balewadi Phata, Pune 411045");
  assert.deepEqual(address?.details, { pincode: "411045", landmark: "Balewadi Phata" });
  const hinglishAddress = extractEntities("mera pata hai H.No 45, Gali No 3, Shastri Nagar, Delhi 110052", INDIA).find((x) => x.type === "address");
  assert.equal(hinglishAddress?.details?.pincode, "110052");
  assert.deepEqual(pick(extractEntities("pincode 560001 pe deliver hota hai?", INDIA), "pincode"), ["560001"]);
  assert.deepEqual(pick(extractEntities("I have 560001 reasons"), "pincode"), [], "six digits alone are not a PIN code");

  const ids = extractEntities("Rs. 1,50,000 paid via NEFT on 25/12/2026 at 3:30 PM. GSTIN 27AAPFU0939F1ZV, IFSC HDFC0001234, UPI rahul@okicici", INDIA);
  assert.deepEqual(pick(ids, "amount"), ["150000"]);
  assert.deepEqual(pick(ids, "date"), ["2026-12-25"], "day first");
  assert.deepEqual(pick(ids, "time"), ["15:30"]);
  assert.deepEqual(pick(ids, "gstin"), ["27AAPFU0939F1ZV"]);
  assert.deepEqual(pick(ids, "ifsc"), ["HDFC0001234"]);
  assert.deepEqual(pick(ids, "upi_id"), ["rahul@okicici"]);
  assert.deepEqual(pick(ids, "payment_method"), ["NEFT", "UPI"]);

  const secret = extractEntities("My Aadhaar is 2345 6789 0124 and PAN ABCPE1234F");
  assert.deepEqual(pick(secret, "government_id"), ["XXXX XXXX 0124", "XXXXXX234F"]);
  assert.ok(!JSON.stringify(secret).includes("2345 6789"), "never unmasked, not even in text");
  assert.deepEqual(pick(extractEntities("call +919876543210"), "government_id"), [], "a +91 number is a phone, whatever its checksum");

  const phones = extractEntities("landline 011-2345 6789, toll free 1800 123 4567, US office +1 415 555 0100, ticket no 4567", INDIA);
  assert.deepEqual(pick(phones, "phone").sort(), ["+14155550100", "+911123456789", "18001234567"]);
  assert.deepEqual(pick(phones, "order_id"), ["4567"]);
});

test("the region is the business's setting, never inferred from the customer", () => {
  assert.equal(regionOf(defaultEmployeeConfig("Asia/Kolkata")), "IN");
  assert.equal(regionOf({ ...defaultEmployeeConfig("Europe/London"), language: "hi-en" }), "IN");
  assert.equal(regionOf({ ...defaultEmployeeConfig("America/New_York"), language: "hi" }), null, "Hindi alone does not make a business Indian");
  // A bare 10-digit number gets +91 only for a business operating in India; a stated +91 always counts.
  assert.deepEqual(pick(extractEntities("call 9876543210"), "phone"), ["9876543210"]);
  assert.deepEqual(pick(extractEntities("call 9876543210", { region: "IN" }), "phone"), ["+919876543210"]);
  assert.deepEqual(pick(extractEntities("call 09876543210"), "phone"), ["+919876543210"]);
  // Without a currency word, an amount is rupees only in India; lakh is rupees anywhere.
  assert.equal(extractEntities("budget 50000").find((x) => x.type === "amount")?.details, undefined);
  assert.equal(extractEntities("budget 50000", { region: "IN" }).find((x) => x.type === "amount")?.details?.currency, "INR");
  assert.equal(extractEntities("$500 budget").find((x) => x.type === "amount")?.details?.currency, "USD");
});

test("conversation analysis: a Hinglish complaint that escalates, and an English one resolved", () => {
  const at = (minutes: number) => new Date(INDIA.now.getTime() + minutes * 60_000);
  const complaint = analyzeConversation({
    messages: [
      { role: "USER", content: "Hi, my order OD4312345678 is late", createdAt: at(0) },
      { role: "ASSISTANT", content: "Sorry to hear that. Let me check.", createdAt: at(1) },
      { role: "USER", content: "bhai kab tak aayega? bahut bekaar service hai, abhi tak nahi aaya", createdAt: at(2) },
      { role: "ASSISTANT", content: "Main check kar raha hoon.", createdAt: at(3) },
      { role: "USER", content: "मुझे रिफंड चाहिए, वरना consumer court जाऊँगा", createdAt: at(4) },
    ],
    status: "WAITING_FOR_HUMAN",
    handoffs: [{ trigger: "customer_request" }],
    region: "IN",
    timezone: "Asia/Kolkata",
  });
  assert.equal(complaint.primaryLanguage, "hinglish");
  assert.deepEqual(complaint.messages.map((m) => [m.index, m.language]), [[0, "en"], [2, "hinglish"], [4, "hinglish"]]);
  assert.equal(complaint.switches, 1);
  assert.equal(complaint.codeSwitchedMessages, 2);
  assert.equal(complaint.sentiment, "negative");
  assert.ok(complaint.sentimentIndicators.some((s) => s.phrase === "bekaar" && s.messageIndex === 2));
  assert.equal(complaint.intent, "order_status");
  assert.ok(complaint.intents.includes("refund") && complaint.intents.includes("complaint"));
  assert.deepEqual(pick(complaint.entities as ExtractedEntity[], "order_id"), ["OD4312345678"]);
  assert.equal(complaint.resolution, "with_people");
  assert.deepEqual(complaint.escalation, { escalated: true, handoffs: 1, triggers: ["customer_request"], signals: ["consumer court"] });

  const happy = analyzeConversation({
    messages: [
      { role: "USER", content: "How much is the gold plan?", createdAt: at(0) },
      { role: "ASSISTANT", content: "It is ₹999 a month.", createdAt: at(1) },
      { role: "USER", content: "Great, got it. Thanks!", createdAt: at(2) },
    ],
    status: "AI_ACTIVE",
    handoffs: [],
  });
  assert.equal(happy.sentiment, "positive");
  assert.equal(happy.intent, "pricing");
  assert.equal(happy.resolution, "resolved");
  assert.deepEqual(happy.resolutionSignals, ["got it"]);
  assert.equal(happy.escalation.escalated, false);
  assert.equal(analyzeConversation({ messages: [{ role: "USER", content: "not happy with this", createdAt: at(0) }], status: "AI_ACTIVE", handoffs: [] }).sentiment, "negative");
  assert.equal(analyzeConversation({ messages: [], status: "AI_ACTIVE", handoffs: [] }).intent, "general");
});

test("system prompt: follows the customer's language and script; Indian conventions only for businesses operating in India", () => {
  const india: EmployeeConfig = { ...defaultEmployeeConfig("Asia/Kolkata"), name: "Ava", role: "Support" };
  const us: EmployeeConfig = { ...defaultEmployeeConfig("America/New_York"), name: "Ava", role: "Support" };
  const hinglish = systemPrompt(india, [], undefined, false, "whatsapp", new Date(), "mera order kab aayega?");
  assert.match(hinglish, /latest message is Hinglish/);
  assert.match(hinglish, /Roman letters, not Devanagari/);
  assert.match(hinglish, /rupees \(₹\) with Indian digit grouping/);
  assert.match(hinglish, /Never assume a customer's nationality/);
  assert.match(systemPrompt(india, [], undefined, false, "voice", new Date(), "मेरा ऑर्डर कब आएगा?"), /Hindi in Devanagari[\s\S]*one lakh fifty thousand rupees/);
  // A +91 caller writing English to a US business: no Indian conventions, no language note.
  const american = systemPrompt(us, [], undefined, false, "voice", new Date(), "Where is my order? My number is +91 98765 43210");
  assert.doesNotMatch(american, /operates in India|latest message is/);
  assert.match(american, /Never assume a customer's nationality/);
  assert.match(systemPrompt({ ...us, language: "hi-en" }, [], undefined), /Reply in Hinglish \(Hindi and English mixed, in Roman script\)/);
});

test("handoff: requests for a person in Hinglish and Hindi; amounts in lakh and crore", () => {
  for (const text of ["kisi insaan se baat karni hai", "please agent se baat karao", "मुझे किसी इंसान से बात करनी है", "Can I talk to a human?"]) assert.ok(asksForHuman(text), text);
  assert.ok(!asksForHuman("mujhe refund chahiye"));
  assert.equal(toNumber("5 lakh"), 500000);
  assert.equal(toNumber("₹1,50,000"), 150000);
  assert.equal(toNumber("1.2 crore"), 12000000);
  assert.equal(toNumber("$80,000"), 80000);
  assert.ok(Number.isNaN(toNumber("enterprise")));
});

test("memory refuses Aadhaar and PAN, keeps postal codes and Hindi values", () => {
  assert.equal(validFact({ category: "identity", key: "id_number", value: "2345 6789 0124" }), null);
  assert.equal(validFact({ category: "identity", key: "tax_id", value: "ABCPE1234F" }), null);
  assert.equal(validFact({ category: "identity", key: "aadhaar", value: "on file" }), null);
  assert.equal(validFact({ category: "identity", key: "pan_number", value: "on file" }), null);
  assert.deepEqual(validFact({ category: "identity", key: "postal_code", value: "411045" }), { category: "identity", key: "postal_code", value: "411045" });
  assert.deepEqual(validFact({ category: "identity", key: "name", value: "प्रिया वर्मा" }), { category: "identity", key: "name", value: "प्रिया वर्मा" });
  assert.ok(validFact({ category: "identity", key: "phone", value: "+919876543210" }));
});

test("voice: rupees said in lakh and crore, phone numbers digit by digit, Hinglish speech settings", async () => {
  assert.equal(spokenRupees(150000), "1 lakh 50 thousand rupees");
  assert.equal(spokenRupees(12345678.5), "1 crore 23 lakh 45 thousand 678 rupees and 50 paise");
  assert.equal(forSpeech("Your refund of ₹1,50,000 is approved."), "Your refund of 1 lakh 50 thousand rupees is approved.");
  assert.equal(forSpeech("Total: Rs. 999/- only"), "Total: 999 rupees only");
  assert.equal(forSpeech("It costs ₹2 crore"), "It costs 2 crore rupees");
  assert.equal(forSpeech("Call +91 98765 43210."), "Call plus 9 1, 9 8 7 6 5, 4 3 2 1 0.");

  // Deepgram listens for Hindi and English together for Hinglish; other languages pass through.
  const urls: string[] = [];
  const fakeDeepgram = (async (url: string) => {
    urls.push(url);
    return Response.json({ results: { channels: [{ alternatives: [{ transcript: "haan ji" }] }] } });
  }) as typeof fetch;
  const dg = deepgramProvider({ apiKey: "k", fetch: fakeDeepgram });
  await dg.transcribe!(Buffer.from("x"), { mimeType: "audio/ogg", language: "hi-en" });
  await dg.transcribe!(Buffer.from("x"), { mimeType: "audio/ogg", language: "en-IN" });
  assert.deepEqual(urls.map((u) => new URL(u).searchParams.get("language")), ["multi", "en-IN"]);

  // ElevenLabs: en-IN -> en; Hinglish leaves the language to the model.
  const bodies: Record<string, unknown>[] = [];
  const fakeEleven = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(new Uint8Array([1, 2]));
  }) as typeof fetch;
  const tts = elevenLabsProvider({ apiKey: "k", voiceId: "v", fetch: fakeEleven });
  for (const language of ["en-IN", "hi-en", "hi"])
    for await (const chunk of tts.synthesize("namaste", { language, signal: AbortSignal.timeout(5000) })) assert.ok(chunk.length > 0);
  assert.deepEqual(bodies.map((b) => b.language_code), ["en", undefined, "hi"]);
});

// ---- through the API ----

const orgA = newOrg();
const orgB = newOrg();
let app: Awaited<ReturnType<typeof testApp>>;
let wsA: string;
let conversationId: string;

before(async () => {
  app = await testApp();
  const [ws] = (await app.inject({ method: "GET", url: "/workspaces", headers: adminOf(orgA) })).json<Workspace[]>();
  wsA = ws!.id;
  await app.inject({ method: "GET", url: "/workspaces", headers: adminOf(orgB) });
  const employee = (
    await app.inject({
      method: "POST",
      url: `/workspaces/${wsA}/employees`,
      headers: adminOf(orgA),
      payload: { ...defaultEmployeeConfig("Asia/Kolkata"), name: "Ava", role: "Support", language: "hi-en" },
    })
  ).json<EmployeeDetail>();
  const scope = { organizationId: orgA, workspaceId: wsA, employeeId: employee.id, createdBy: "test" };
  const t0 = Date.now() - 60_000;
  const conversation = await prisma.conversation.create({
    data: {
      ...scope,
      channel: "whatsapp",
      title: "Late order",
      status: "WAITING_FOR_HUMAN",
      messages: {
        create: [
          { organizationId: orgA, workspaceId: wsA, role: "USER", content: "mera order OD4312345678 kab aayega? 3 din ho gaye", createdAt: new Date(t0) },
          { organizationId: orgA, workspaceId: wsA, role: "ASSISTANT", content: "Main check karta hoon.", createdAt: new Date(t0 + 1000) },
          { organizationId: orgA, workspaceId: wsA, role: "USER", content: "bahut ghatiya service. Call me on 9876543210", createdAt: new Date(t0 + 2000) },
        ],
      },
    },
  });
  conversationId = conversation.id;
  await prisma.handoff.create({ data: { organizationId: orgA, workspaceId: wsA, conversationId, employeeId: employee.id, trigger: "customer_request", reason: "asked" } });
  await prisma.conversation.create({
    data: {
      ...scope,
      channel: "web_chat",
      title: "Price",
      status: "RESOLVED",
      messages: { create: [{ organizationId: orgA, workspaceId: wsA, role: "USER", content: "गोल्ड प्लान की कीमत क्या है?" }, { organizationId: orgA, workspaceId: wsA, role: "ASSISTANT", content: "₹999 प्रति माह।" }] },
    },
  });
  // Regression replays are not customer conversations.
  await prisma.conversation.create({ data: { ...scope, channel: "evaluation", title: "Replay", messages: { create: [{ organizationId: orgA, workspaceId: wsA, role: "USER", content: "refund chahiye" }] } } });
});
after(async () => {
  await deleteOrgs(orgA, orgB);
  await app.close();
});

test("API: the conversation detail carries its insight, for members too", async () => {
  const res = await app.inject({ method: "GET", url: `/workspaces/${wsA}/conversations/${conversationId}`, headers: memberOf(orgA) });
  assert.equal(res.statusCode, 200);
  const { insight } = res.json<InboxConversation>();
  assert.equal(insight.primaryLanguage, "hinglish");
  assert.equal(insight.sentiment, "negative");
  assert.equal(insight.intent, "order_status");
  assert.equal(insight.resolution, "with_people");
  assert.deepEqual(insight.escalation.triggers, ["customer_request"]);
  // The employee operates in India (Asia/Kolkata, Hinglish), so the bare number is read as an Indian mobile.
  assert.deepEqual(insight.entities.map((e) => [e.type, e.value, e.messageIndex]), [
    ["order_id", "OD4312345678", 0],
    ["phone", "+919876543210", 2],
  ]);
});

test("API: the workspace overview counts languages, sentiment, intents, entities, resolution, escalation", async () => {
  const res = await app.inject({ method: "GET", url: `/workspaces/${wsA}/insights?days=7`, headers: memberOf(orgA) });
  assert.equal(res.statusCode, 200);
  const o = res.json<InsightsOverview>();
  assert.equal(o.conversations, 2, "the evaluation replay is left out");
  assert.equal(o.analyzed, 2);
  assert.deepEqual(o.languages.map((l) => `${l.language}:${l.conversations}`).sort(), ["hi:1", "hinglish:1"]);
  assert.equal(o.codeSwitched, 1);
  assert.equal(o.withSwitches, 0, "each customer kept to one language");
  assert.deepEqual(o.sentiment, { positive: 0, negative: 1, neutral: 1, mixed: 0 });
  assert.deepEqual(o.intents.map((i) => i.intent).sort(), ["order_status", "pricing"]);
  assert.deepEqual(o.entities.map((e) => e.type).sort(), ["order_id", "phone"]);
  assert.deepEqual(o.resolution, { resolved: 1, with_people: 1, open: 0 });
  assert.deepEqual(o.escalation, { conversations: 1, rate: 0.5, withSignals: 0 });
  const daily = o.sentimentDaily.reduce((t, d) => ({ positive: t.positive + d.positive, negative: t.negative + d.negative, neutral: t.neutral + d.neutral, mixed: t.mixed + d.mixed }), { positive: 0, negative: 0, neutral: 0, mixed: 0 });
  assert.deepEqual(daily, o.sentiment, "the days add up to the period");
  // Stored per conversation; a conversation that moves on is analyzed again on the next read.
  const stored = await prisma.conversationInsight.findMany({ where: { organizationId: orgA, workspaceId: wsA } });
  assert.equal(stored.length, 2);
  const target = stored.find((s) => s.resolution === "with_people") ?? stored[0]!;
  await prisma.conversation.update({ where: { id: target.conversationId }, data: { status: "RESOLVED" } });
  const again = (await app.inject({ method: "GET", url: `/workspaces/${wsA}/insights?days=7`, headers: memberOf(orgA) })).json<InsightsOverview>();
  assert.deepEqual(again.resolution, { resolved: 2, with_people: 0, open: 0 });
  assert.equal((await prisma.conversationInsight.findUniqueOrThrow({ where: { conversationId: target.conversationId } })).resolution, "resolved");
});

test("the insights job analyzes quiet conversations, so the read has nothing left to do", async () => {
  const scope = { organizationId: orgA, workspaceId: wsA };
  const employeeId = (await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).employeeId;
  const quiet = await prisma.conversation.create({
    data: { ...scope, employeeId, createdBy: "test", channel: "web_chat", title: "Thanks", messages: { create: [{ ...scope, role: "USER", content: "got it, thank you so much" }] } },
  });
  await prisma.conversation.update({ where: { id: quiet.id }, data: { updatedAt: new Date(Date.now() - 20 * 60_000) } });
  const due = await quietInsights({ idleMs: 10 * 60_000, organizationId: orgA });
  assert.deepEqual(due.map((d) => d.conversationId), [quiet.id], "only the quiet one; the others are fresh or still active");
  assert.equal(await analyzeInsights(scope, [quiet.id]), 1);
  assert.equal(await analyzeInsights({ organizationId: orgB, workspaceId: wsA }, [quiet.id]), 0, "never another organization's conversation");
  assert.equal(await refreshInsights(scope, new Date(Date.now() - 7 * 86_400_000)), 0, "nothing missing or stale for the read");
  const res = (await app.inject({ method: "GET", url: `/workspaces/${wsA}/insights?days=7`, headers: memberOf(orgA) })).json<InsightsOverview>();
  assert.equal(res.analyzed, 3);
  assert.equal(res.resolution.resolved, 3);
});

test("API: other organizations get 404, signed-out 401", async () => {
  assert.equal((await app.inject({ method: "GET", url: `/workspaces/${wsA}/insights`, headers: adminOf(orgB) })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `/workspaces/${wsA}/conversations/${conversationId}`, headers: adminOf(orgB) })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `/workspaces/${wsA}/insights` })).statusCode, 401);
});
