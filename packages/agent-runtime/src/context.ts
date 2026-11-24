import type { ChatMessage } from "@workforce/ai-provider";
import type { Recalled } from "@workforce/memory";
import { LANGUAGES, type DetectedLanguage, type EmployeeConfig, type KnowledgeMatch } from "@workforce/shared";
import { regionOf } from "./entities.ts";
import { detectLanguage } from "./language.ts";

const CHANNEL_NAMES: Record<string, string> = {
  voice: "phone call",
  whatsapp: "WhatsApp",
  web_chat: "website chat",
  email: "email",
  test: "test chat",
  workflow: "automated workflow",
};

/** How replies must look on each channel, beyond what the employee's own instructions say. */
const CHANNEL_STYLE: Record<string, string> = {
  voice:
    "You are speaking with the customer on a phone call, and everything you write is read aloud. Answer in one to three short sentences. No lists, headings, markdown, emojis or links. Write numbers, times and prices the way a person says them. If you did not understand, ask the caller to repeat. Before an action that takes a moment, say a few words first, such as: One moment while I book that.",
  whatsapp:
    "You are chatting with the customer on WhatsApp. Keep replies short and conversational, like a text message: a few sentences, split into short paragraphs. WhatsApp does not render markdown: no headings, tables or [text](link) links; write links out in full, and use *bold* sparingly. You can read text, transcribed voice notes and documents the customer sends; you cannot see images or videos, so ask the customer to describe them.",
  web_chat:
    "You are chatting with a visitor in the chat widget on the company's website. Keep replies concise and easy to scan, in short paragraphs. Write plain text: markdown is shown as typed, so no asterisks, headings or [text](link) links; write links out in full.",
  email:
    "You are answering the customer by email. Write a complete, polite email body: a greeting, the answer, and a sign-off with your name. Plain text only, no markdown. Do not write a subject line.",
};

// shortcut: older turns are dropped, not summarized; summarize within a conversation when long ones matter
const MAX_HISTORY_MESSAGES = 40;

/** What the employee knows about the customer from earlier conversations. */
function memorySection({ facts, previous }: Recalled) {
  if (facts.length === 0 && previous.length === 0)
    return "You have not met this customer before, or know nothing about them yet.";
  return [
    "What you remember about this customer from earlier conversations. Use it naturally, do not recite it, and if they correct something, trust the correction.",
    facts.length > 0 && facts.map((f) => `- ${f.key}: ${f.value}`).join("\n"),
    previous.length > 0 &&
      `Earlier conversations, on any channel:\n${previous.map((p) => `- ${p.at.toISOString().slice(0, 10)}, ${CHANNEL_NAMES[p.channel] ?? p.channel}: ${p.summary}`).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const SCRIPT_NAMES: Partial<Record<DetectedLanguage, string>> = { bn: "Bengali", pa: "Punjabi", gu: "Gujarati", or: "Odia", ta: "Tamil", te: "Telugu", kn: "Kannada", ml: "Malayalam" };

/**
 * Which language to answer in: the employee's own, unless the customer's latest message is in another
 * one, in which case follow the customer, script included (Hinglish in Roman letters stays Roman).
 */
function languageSection(employee: EmployeeConfig, customerMessage?: string) {
  const own = employee.language === "hi-en" ? "Hinglish (Hindi and English mixed, in Roman script)" : LANGUAGES[employee.language];
  const lines = [`Reply in ${own} unless the customer writes in another language; then reply in theirs. Customers may switch languages mid-conversation: follow their latest message.`];
  const latest = customerMessage ? detectLanguage(customerMessage).language : undefined;
  if (latest === "hinglish")
    lines.push("The customer's latest message is Hinglish: Hindi and English mixed, written in Roman letters. Reply the same way, in Roman letters, not Devanagari, keeping the English words they use.");
  else if (latest === "hi")
    lines.push("The customer's latest message is in Hindi (Devanagari). Reply in Hindi in Devanagari; keep product names, numbers and any English terms they used as they wrote them.");
  else if (latest && SCRIPT_NAMES[latest]) lines.push(`The customer's latest message is in ${SCRIPT_NAMES[latest]}. Reply in ${SCRIPT_NAMES[latest]}.`);
  return lines.join(" ");
}

/**
 * Formatting conventions of the business's own operating region (from its settings, not from the
 * customer), and the rule that a customer's background is never inferred.
 */
function localeSection(employee: EmployeeConfig, channel: string) {
  const lines = ["Never assume a customer's nationality, region, religion or background from their name, language or phone number."];
  if (regionOf(employee) === "IN") {
    lines.push(
      "This business operates in India. Write amounts in rupees (₹) with Indian digit grouping (₹1,50,000) and lakh or crore where natural, dates day first (25 December 2026 or 25/12/2026), times in 12-hour form (3:30 PM, IST unless said otherwise), and Indian phone numbers as +91 98765 43210. Customers may use terms such as UPI, COD, GST, EMI, NEFT, PIN code, lakh and crore; understand them without asking.",
    );
    if (channel === "voice") lines.push('On calls, say amounts the way people in India do ("one lakh fifty thousand rupees") and read phone numbers and order ids digit by digit.');
  }
  return lines.join(" ");
}

/**
 * Turns an employee's configuration into the instructions the model runs under. `memory` is
 * given when the conversation is with a known customer; `customerMessage` (the latest one) steers the reply language.
 */
export function systemPrompt(
  employee: EmployeeConfig,
  knowledge: KnowledgeMatch[] = [],
  memory?: Recalled,
  hasTools = false,
  channel = "test",
  now = new Date(),
  customerMessage?: string,
) {
  const { timezone } = employee.workingHours;
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "long" }).format(now);
  const clock = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, dateStyle: "short", timeStyle: "short" }).format(now);
  const sections = [
    `You are ${employee.name}, an AI employee working as: ${employee.role}.`,
    employee.description && `About you: ${employee.description}`,
    employee.personality && `Personality and tone:\n${employee.personality}`,
    employee.goals.length > 0 && `Your goals:\n${employee.goals.map((g) => `- ${g}`).join("\n")}`,
    employee.systemInstructions && `Instructions:\n${employee.systemInstructions}`,
    languageSection(employee, customerMessage),
    localeSection(employee, channel),
    knowledge.length > 0
      ? [
          "Company knowledge relevant to the latest message is below. Base your answer on it and prefer it over what you otherwise believe. If it does not contain the answer, say you do not have that information; do not guess.",
          ...knowledge.map((k, i) => `[${i + 1}] From "${k.documentName}"${k.page ? `, page ${k.page}` : ""}:\n${k.content}`),
        ].join("\n\n")
      : "You have no company documents to consult. If you cannot help with something, say so plainly.",
    memory ? memorySection(memory) : "You have no memory of other conversations.",
    hasTools
      ? "You can act for the customer with the tools you have. Use a tool only when the customer asks for that action or clearly agrees to it. Say an action is done only if the tool result says it succeeded; if it failed, tell the customer plainly. Do not mention tool names or internal ids."
      : "You have no tools: you cannot book, send or change anything. Say so if asked.",
    `It is now ${weekday}, ${clock} (${timezone}).`,
    CHANNEL_STYLE[channel],
  ];
  return sections.filter(Boolean).join("\n\n");
}

/** Everything the model sees for one turn: who it is, what was said, and the new message. */
export function buildContext(
  employee: EmployeeConfig,
  history: ChatMessage[],
  userMessage: string,
  knowledge: KnowledgeMatch[] = [],
  memory?: Recalled,
  hasTools = false,
  channel = "test",
) {
  const recent = history.slice(-MAX_HISTORY_MESSAGES);
  // Providers expect the conversation to open with the user.
  while (recent[0]?.role === "assistant") recent.shift();
  // Messages the customer sent while a person had the conversation, or an agent's message after the
  // AI's, follow one another: join them so the roles alternate.
  const messages: ChatMessage[] = [];
  for (const m of [...recent, { role: "user" as const, content: userMessage }]) {
    const last = messages.at(-1);
    if (last && last.role === m.role && (m.role === "user" || m.role === "assistant") && !("toolCalls" in last && last.toolCalls))
      messages[messages.length - 1] = { ...last, content: `${(last as { content: string }).content}\n\n${m.content}` } as ChatMessage;
    else messages.push(m);
  }
  return { system: systemPrompt(employee, knowledge, memory, hasTools, channel, new Date(), userMessage), messages };
}
