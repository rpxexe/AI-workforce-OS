// Memory extraction and validation. The model proposes facts; `parseExtraction` decides what is
// actually stored, so a careless or manipulated extraction cannot write junk or secrets.
import { MEMORY_CATEGORIES, type MemoryCategory } from "@workforce/shared";

/** `confidence` (0..1) is how sure the extractor was; absent when it did not say. */
export type Fact = { category: MemoryCategory; key: string; value: string; confidence?: number };

const MAX_FACTS = 20;
const MAX_VALUE = 200;
const MAX_SUMMARY = 500;
// Secrets never belong in memory, whatever the extractor says.
const SECRET_KEY = /password|passcode|otp|one_time|cvv|cvc|pin_?code|^pin$|card_number|iban|ssn|social_security|secret|token/;

export const EXTRACTION_PROMPT = `You maintain long-term memory about a customer of a business, for the business's AI employee. Read the latest exchange and return only information worth knowing in future conversations with this customer.

Remember:
- identity: name, email, phone, company, job title, location
- preference: how and when they like to be contacted, language, stable likes and dislikes
- fact: lasting facts about their situation (current provider, number of locations, team size)
- lead: product or plan they are interested in, budget, timeline, decision maker, objections
- follow_up: what was agreed to happen next, and when

Do not remember: greetings, small talk, the questions they asked, anything said only by the assistant, moods, one-off states ("I'm busy right now"), guesses, or anything the customer did not clearly state or confirm. Never remember passwords, one-time codes, card or bank numbers, or government ID numbers.

Keys are short snake_case English (name, budget, interest, follow_up_date). Reuse an existing key when the new information updates it. Values are short. Write amounts as plain digits without separators ("around 50,000" becomes "50000"); if a currency is stated, store it under its own key. Normalize vague plan names to the product word ("the enterprise plan" becomes "enterprise").

Rate each memory's confidence from 0 to 1: 1 when the customer stated it plainly, lower when it is implied or partly unclear.

Also write a summary: one or two sentences about this whole conversation so far, for the next conversation with this customer. Build on the previous summary if there is one. Refer to the customer by name or as "the customer", not with pronouns guessed from their name.

Reply with JSON only, no prose:
{"memories":[{"category":"identity|preference|fact|lead|follow_up","key":"...","value":"...","confidence":0.9}],"summary":"..."}
If nothing is worth remembering, return an empty memories list.`;

/** What the extractor is shown: what is already known, the summary so far, and the new exchange. */
export function extractionRequest(known: Fact[], summary: string, customerMessage: string, reply: string) {
  const system = [
    EXTRACTION_PROMPT,
    known.length > 0 ? `Already known:\n${known.map((f) => `- ${f.key} (${f.category}): ${f.value}`).join("\n")}` : "Nothing is known yet.",
    summary && `Summary of this conversation so far: ${summary}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  // One message holding the exchange, so the model reads it as material rather than continuing it.
  return { system, messages: [{ role: "user" as const, content: `Customer: ${customerMessage}\n\nAssistant: ${reply}` }] };
}

const normalizeKey = (key: string) =>
  key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

/** A 13 to 19 digit run that passes the Luhn check: a payment card number. */
const hasCardNumber = (value: string) =>
  (value.match(/\d[\d -]{11,}\d/g) ?? []).some((run) => {
    const digits = run.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) return false;
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
      sum += d;
    }
    return sum % 10 === 0;
  });

/** A safe, well-formed fact, or null. Also checks values people type in the dashboard. */
export function validFact(item: unknown): Fact | null {
  if (typeof item !== "object" || item === null) return null;
  const { category, key, value, confidence } = item as Record<string, unknown>;
  if (!MEMORY_CATEGORIES.includes(category as MemoryCategory) || typeof key !== "string") return null;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return null;
  const k = normalizeKey(key);
  const v = String(value).trim();
  if (k.length === 0 || k.length > 40 || v.length === 0 || v.length > MAX_VALUE) return null;
  if (SECRET_KEY.test(k) || hasCardNumber(v)) return null;
  const fact: Fact = { category: category as MemoryCategory, key: k, value: v };
  if (typeof confidence === "number" && confidence >= 0 && confidence <= 1) fact.confidence = confidence;
  return fact;
}

/** Keeps only well-formed, safe facts (one per key, at most 20) and the summary, if usable. */
export function parseExtraction(text: string): { facts: Fact[]; summary: string | null } {
  let parsed: unknown;
  try {
    // Models sometimes wrap JSON in a code fence or a sentence; take the outermost object.
    parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    return { facts: [], summary: null };
  }
  const { memories, summary } = (parsed ?? {}) as { memories?: unknown; summary?: unknown };
  const facts = new Map<string, Fact>();
  for (const item of Array.isArray(memories) ? memories : []) {
    const fact = validFact(item);
    if (fact) facts.set(fact.key, fact);
  }
  const s = typeof summary === "string" ? summary.trim() : "";
  return { facts: [...facts.values()].slice(0, MAX_FACTS), summary: s ? s.slice(0, MAX_SUMMARY) : null };
}
