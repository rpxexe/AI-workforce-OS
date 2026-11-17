import type { ChatMessage } from "@workforce/ai-provider";
import { LANGUAGES, type EmployeeConfig, type KnowledgeMatch } from "@workforce/shared";

// shortcut: older turns are dropped, not summarized; add summarization when memory is built
const MAX_HISTORY_MESSAGES = 40;

/** Turns an employee's configuration into the instructions the model runs under. */
export function systemPrompt(employee: EmployeeConfig, knowledge: KnowledgeMatch[] = []) {
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
    "You have no tools and no memory of other conversations.",
  ];
  return sections.filter(Boolean).join("\n\n");
}

/** Everything the model sees for one turn: who it is, what was said, and the new message. */
export function buildContext(
  employee: EmployeeConfig,
  history: ChatMessage[],
  userMessage: string,
  knowledge: KnowledgeMatch[] = [],
) {
  const recent = history.slice(-MAX_HISTORY_MESSAGES);
  // Providers expect the conversation to open with the user.
  while (recent[0]?.role === "assistant") recent.shift();
  return { system: systemPrompt(employee, knowledge), messages: [...recent, { role: "user" as const, content: userMessage }] };
}
