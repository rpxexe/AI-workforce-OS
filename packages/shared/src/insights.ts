// Conversation intelligence (Phase 15): what the deterministic analyzers in @workforce/agent-runtime
// report about a conversation, and the workspace overview. Languages are languages, never nationalities.
import type { HandoffTrigger } from "./inbox.ts";

/** Languages the analyzer tells apart. `hinglish` is Hindi in Roman script, usually mixed with English. */
export const DETECTED_LANGUAGES = {
  en: "English",
  hi: "Hindi",
  hinglish: "Hinglish",
  bn: "Bengali",
  pa: "Punjabi",
  gu: "Gujarati",
  or: "Odia",
  ta: "Tamil",
  te: "Telugu",
  kn: "Kannada",
  ml: "Malayalam",
  other: "Other language",
  unknown: "No words",
} as const;
export type DetectedLanguage = keyof typeof DETECTED_LANGUAGES;

export const INTENTS = {
  order_status: "Order status",
  delivery: "Delivery",
  cancellation: "Cancellation",
  refund: "Refund",
  return_exchange: "Return or exchange",
  payment: "Payment",
  pricing: "Pricing",
  booking: "Booking",
  complaint: "Complaint",
  technical_support: "Technical support",
  account: "Account",
  purchase: "Buying",
  general: "General",
} as const;
export type Intent = keyof typeof INTENTS;

export const ENTITY_TYPES = {
  person_name: "Name",
  phone: "Phone number",
  email: "Email",
  address: "Address",
  pincode: "PIN code",
  order_id: "Order / reference ID",
  date: "Date",
  time: "Time",
  amount: "Amount",
  payment_method: "Payment method",
  gstin: "GSTIN",
  ifsc: "IFSC",
  upi_id: "UPI ID",
  government_id: "Government ID (masked)",
} as const;
export type EntityType = keyof typeof ENTITY_TYPES;

export const SENTIMENTS = ["positive", "negative", "neutral", "mixed"] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

/** resolved: closed, or the customer said it is sorted; with_people: handed off and not back; open: neither. */
export const RESOLUTIONS = ["resolved", "with_people", "open"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

/**
 * `value` is normalized (phone +919876543210, date 2026-12-25, time 17:00, amount 150000);
 * `text` is what the customer wrote. Government IDs are masked in both.
 */
export type Entity = { type: EntityType; text: string; value: string; details?: Record<string, string>; messageIndex: number };

export type ConversationInsight = {
  primaryLanguage: DetectedLanguage;
  languages: { language: DetectedLanguage; messages: number }[];
  /** Times the customer's language changed from one message to the next. */
  switches: number;
  /** Customer messages mixing languages or scripts within themselves. */
  codeSwitchedMessages: number;
  /** One per customer message; `index` is the message's position in the conversation. */
  messages: { index: number; language: DetectedLanguage; codeSwitched: boolean }[];
  sentiment: Sentiment;
  sentimentIndicators: { polarity: "positive" | "negative"; phrase: string; messageIndex: number }[];
  intent: Intent;
  intents: Intent[];
  entities: Entity[];
  resolution: Resolution;
  resolutionSignals: string[];
  escalation: { escalated: boolean; handoffs: number; triggers: HandoffTrigger[]; signals: string[] };
};

export type InsightsOverview = {
  days: number;
  conversations: number;
  /** How many of them were analyzed (the newest ones, up to a cap). */
  analyzed: number;
  languages: { language: DetectedLanguage; conversations: number }[];
  codeSwitched: number;
  withSwitches: number;
  sentiment: Record<Sentiment, number>;
  intents: { intent: Intent; conversations: number }[];
  entities: { type: EntityType; count: number }[];
  resolution: Record<Resolution, number>;
  escalation: { conversations: number; rate: number | null; withSignals: number };
  /** Sentiment of the analyzed conversations, each dated by its last activity (UTC day), oldest first; days with none are left out. */
  sentimentDaily: ({ date: string } & Record<Sentiment, number>)[];
};

// Verhoeff check digit tables (Aadhaar numbers carry one).
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1], [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1], [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
export const verhoeffValid = (digits: string) =>
  [...digits].reverse().reduce((c, d, i) => D[c]![P[i % 8]![Number(d)]!]!, 0) === 0;

// Not after "+": +91 followed by a mobile number is a phone number, whatever its checksum says.
const AADHAAR = /(?<![\d+])[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}(?!\d)/g;
const PAN = /\b[A-Z]{3}[ABCFGHJLPT][A-Z]\d{4}[A-Z]\b/gi;

/** Aadhaar (checksum-valid) and PAN numbers in a text, with where they are. Never stored, only masked. */
export function governmentIds(text: string) {
  const found: { kind: "aadhaar" | "pan"; text: string; index: number; masked: string }[] = [];
  for (const m of text.matchAll(AADHAAR)) {
    const digits = m[0].replace(/\D/g, "");
    if (verhoeffValid(digits)) found.push({ kind: "aadhaar", text: m[0], index: m.index, masked: `XXXX XXXX ${digits.slice(-4)}` });
  }
  for (const m of text.matchAll(PAN)) found.push({ kind: "pan", text: m[0], index: m.index, masked: `XXXXXX${m[0].slice(-4).toUpperCase()}` });
  return found;
}
