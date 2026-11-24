// Conversation intelligence: language, code-switching, sentiment indicators, intent, entities,
// resolution and escalation for one conversation, from its messages. Phrase lists in English, Hindi
// (Devanagari) and Hinglish; no model, so it runs on every read and the results can be explained.
import type { ConversationInsight, ConversationStatus, Entity, HandoffTrigger, Intent, Resolution, Sentiment } from "@workforce/shared";
import { extractEntities, type ExtractContext } from "./entities.ts";
import { languageProfile } from "./language.ts";

/** Phrases as alternations; Latin ones match whole words, Devanagari ones anywhere. */
const phrases = (list: string) => {
  const items = list.split("|").map((p) => p.trim()).filter(Boolean);
  const latin = items.filter((p) => /^[\x20-\x7e]+$/.test(p)).map((p) => p.replace(/[.*+?^${}()[\]\\]/g, "\\$&").replace(/ /g, "\\s+"));
  const other = items.filter((p) => !/^[\x20-\x7e]+$/.test(p));
  return new RegExp([latin.length && `(?<![a-z])(?:${latin.join("|")})(?![a-z])`, other.length && other.join("|")].filter(Boolean).join("|"), "gi");
};

const POSITIVE = phrases(
  `thank you|thanks|thank u|thx|great|excellent|awesome|perfect|helpful|happy|satisfied|good service|nice|love it|appreciate|wonderful|
  shukriya|dhanyavad|dhanyavaad|dhanyawad|bahut accha|bahut achha|bahut acha|badhiya|mast|zabardast|sahi hai|khush|
  शुक्रिया|धन्यवाद|बहुत अच्छा|बढ़िया|खुश|बहुत बढ़िया`,
);
const NEGATIVE = phrases(
  `worst|terrible|horrible|pathetic|useless|disappointed|angry|frustrated|annoyed|fed up|unacceptable|fraud|scam|cheated|cheat|
  rubbish|nonsense|not happy|very bad|poor service|ridiculous|waste of|still waiting|no response|
  bakwas|bakwaas|bekaar|bekar|ghatiya|faltu|dhokha|pareshan|pareshaan|gussa|naraz|naraaz|kab tak|abhi tak nahi|ab tak nahi|kitni baar|
  बकवास|बेकार|घटिया|धोखा|परेशान|गुस्सा|नाराज़|नाराज|कब तक|अभी तक नहीं|कितनी बार`,
);
// "not good", "accha nahi": a positive word negated counts as negative.
const NEGATED = /(?:\b(?:not|no|never|isn't|wasn't|don't)\s+(?:\w+\s+)?$)/i;
const NEGATED_AFTER = /^\s*(?:nahi|nahin|nhi|नहीं)/i;

const INTENT_PHRASES: [Intent, RegExp][] = [
  ["order_status", phrases(`order status|where is my order|track|tracking|kab aayega|kab ayega|kab milega|kab tak aayega|abhi tak nahi aaya|not received|not delivered|dispatch|dispatched|shipped|awb|order kaha|कब आएगा|कब मिलेगा|अभी तक नहीं आया|ऑर्डर`)],
  ["delivery", phrases(`delivery|deliver|courier|shipping|serviceable|pincode|delivery charge|डिलीवरी|पहुंचा`)],
  ["cancellation", phrases(`cancel|cancellation|cancel karna|cancel kar do|रद्द|कैंसिल`)],
  ["refund", phrases(`refund|money back|paise wapas|paisa wapas|paise vapas|रिफंड|पैसे वापस`)],
  ["return_exchange", phrases(`return|exchange|replace|replacement|wapas karna|badalna|badal do|बदलना|बदल दो|वापस करना`)],
  ["payment", phrases(`payment|paid|pay|upi|gpay|phonepe|paytm|emi|transaction failed|amount deducted|paise kat gaye|paisa kat gaya|cod|invoice|gst|bill|पेमेंट|भुगतान`)],
  ["pricing", phrases(`how much|price|cost|rate|quotation|quote|discount|offer|kitne ka|kitne ki|kitna hai|kya rate|daam|kimat|keemat|कीमत|दाम|कितने का|कितने की`)],
  ["booking", phrases(`book|booking|appointment|schedule|slot|reservation|book karna|demo|site visit|बुक|अपॉइंटमेंट`)],
  ["complaint", phrases(`complaint|complain|shikayat|consumer court|consumer forum|escalate|शिकायत`)],
  ["technical_support", phrases(`not working|error|kaam nahi kar raha|chal nahi raha|band ho gaya|login|otp nahi aaya|crash|bug|काम नहीं कर रहा|चल नहीं रहा`)],
  ["account", phrases(`account|password|kyc|profile|number change|address change|खाता|अकाउंट`)],
  ["purchase", phrases(`buy|purchase|interested|lena hai|kharidna|enquiry|inquiry|details chahiye|information|खरीदना|लेना है`)],
];

// The customer pressing for escalation: authorities, public complaints, a manager, a person.
const ESCALATION = phrases(
  `consumer court|consumer forum|legal action|lawyer|police|social media|twitter|manager|senior se baat|higher authority|escalate|
  complaint karunga|complaint karungi|human se baat|insaan se baat|agent se baat|kisi se baat karao|customer care se baat|
  शिकायत करूंगा|शिकायत करूँगा|इंसान से बात|मैनेजर|उपभोक्ता`,
);
// The customer saying it is sorted.
const RESOLVED = phrases(
  `that's all|that is all|problem solved|issue resolved|it worked|works now|resolved|got it|all good|sorted|
  ho gaya|ho gya|mil gaya|mil gya|samajh gaya|samajh gayi|ab theek hai|हो गया|मिल गया|समझ गया|ठीक है अब`,
);

const allMatches = (re: RegExp, text: string) => [...text.matchAll(re)];

export type InsightMessage = { role: "USER" | "ASSISTANT" | "AGENT"; content: string; createdAt: Date };
export type InsightInput = {
  messages: InsightMessage[];
  status: ConversationStatus;
  handoffs: { trigger: string }[];
} & Pick<ExtractContext, "region" | "timezone">;

export function analyzeConversation({ messages, status, handoffs, region, timezone }: InsightInput): ConversationInsight {
  const customer = messages.map((m, index) => ({ ...m, index })).filter((m) => m.role === "USER");
  const profile = languageProfile(customer.map((m) => m.content));

  const sentimentIndicators: ConversationInsight["sentimentIndicators"] = [];
  const intentScores = new Map<Intent, { score: number; first: number }>();
  const entities: Entity[] = [];
  const escalationSignals = new Set<string>();
  for (const m of customer) {
    for (const hit of allMatches(POSITIVE, m.content)) {
      const negated = NEGATED.test(m.content.slice(0, hit.index)) || NEGATED_AFTER.test(m.content.slice(hit.index + hit[0].length));
      sentimentIndicators.push({ polarity: negated ? "negative" : "positive", phrase: negated ? `not ${hit[0]}` : hit[0], messageIndex: m.index });
    }
    for (const hit of allMatches(NEGATIVE, m.content)) sentimentIndicators.push({ polarity: "negative", phrase: hit[0], messageIndex: m.index });
    for (const [intent, re] of INTENT_PHRASES) {
      const n = allMatches(re, m.content).length;
      if (n === 0) continue;
      const seen = intentScores.get(intent);
      intentScores.set(intent, { score: (seen?.score ?? 0) + n, first: seen?.first ?? m.index });
    }
    for (const e of extractEntities(m.content, { region, timezone, now: m.createdAt }))
      if (!entities.some((x) => x.type === e.type && x.value === e.value)) entities.push({ ...e, messageIndex: m.index });
    for (const hit of allMatches(ESCALATION, m.content)) escalationSignals.add(hit[0].toLowerCase());
  }

  const positive = sentimentIndicators.filter((s) => s.polarity === "positive").length;
  const negative = sentimentIndicators.length - positive;
  // One side at least twice the other decides; otherwise the conversation went both ways.
  const sentiment: Sentiment =
    positive + negative === 0 ? "neutral" : positive >= negative * 2 ? "positive" : negative >= positive * 2 ? "negative" : "mixed";

  const intents = [...intentScores].sort((a, b) => b[1].score - a[1].score || a[1].first - b[1].first).map(([intent]) => intent);

  // Resolution: the conversation's state first; otherwise the customer's own words in their last two messages.
  const resolutionSignals = [...new Set(customer.slice(-2).flatMap((m) => allMatches(RESOLVED, m.content).map((h) => h[0].toLowerCase())))];
  const withPeople = status === "WAITING_FOR_HUMAN" || status === "HUMAN_ACTIVE";
  const resolution: Resolution = status === "RESOLVED" ? "resolved" : withPeople ? "with_people" : resolutionSignals.length > 0 ? "resolved" : "open";

  return {
    primaryLanguage: profile.primaryLanguage,
    languages: profile.languages,
    switches: profile.switches,
    codeSwitchedMessages: profile.codeSwitchedMessages,
    messages: customer.map((m, i) => ({ index: m.index, language: profile.guesses[i]!.language, codeSwitched: profile.guesses[i]!.codeSwitched })),
    sentiment,
    sentimentIndicators,
    intent: intents[0] ?? "general",
    intents,
    entities,
    resolution,
    resolutionSignals,
    escalation: {
      escalated: handoffs.length > 0,
      handoffs: handoffs.length,
      triggers: [...new Set(handoffs.map((h) => h.trigger as HandoffTrigger))],
      signals: [...escalationSignals],
    },
  };
}
