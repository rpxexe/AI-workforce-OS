import type { ChatMessage } from "@workforce/ai-provider";
import type { Recalled } from "@workforce/memory";
import { LANGUAGES, type EmployeeConfig, type KnowledgeMatch } from "@workforce/shared";

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

/**
 * Turns an employee's configuration into the instructions the model runs under. `memory` is
 * given when the conversation is with a known customer.
 */
export function systemPrompt(
  employee: EmployeeConfig,
  knowledge: KnowledgeMatch[] = [],
  memory?: Recalled,
  hasTools = false,
  channel = "test",
  now = new Date(),
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
    `Reply in ${LANGUAGES[employee.language]} unless the person writes in another language.`,
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
  return { system: systemPrompt(employee, knowledge, memory, hasTools, channel), messages };
}
