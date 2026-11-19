// The AI Copilot for human agents: reads a conversation people have taken over and suggests a reply,
// a summary and the next step, with the customer's memory and the knowledge it used. Suggestions are
// stored apart from the conversation and never sent: the agent decides what to write.
import { AIProviderError, type AIProvider, type EmbeddingProvider } from "@workforce/ai-provider";
import { prisma } from "@workforce/database";
import { retrieve } from "@workforce/knowledge";
import type { MemoryService } from "@workforce/memory";
import type { Citation, CopilotSuggestion, EmployeeConfig } from "@workforce/shared";
import { systemPrompt } from "./context.ts";

export type CopilotInput = {
  provider: AIProvider;
  /** Already authorized by the caller. */
  organizationId: string;
  workspaceId: string;
  conversationId: string;
  requestedBy: string;
  employee: EmployeeConfig;
  knowledge?: { embedder: EmbeddingProvider; sourceIds: string[] };
  memory: MemoryService;
  timeoutMs: number;
};

const COPILOT_PROMPT = `You are a copilot for a human support agent who is handling a conversation an AI employee started. You do not talk to the customer; the agent does.
Read the conversation and answer with one JSON object and nothing else:
{"summary": "two or three sentences: who the customer is, what they want, and what has happened so far",
 "reply": "the message the agent could send next, in the customer's language and in the style the channel needs, using only facts from the briefing below; no placeholders",
 "nextAction": "one sentence: the best next step for the agent, e.g. offer a callback, check an order, escalate to billing, resolve the conversation",
 "citations": [numbers of the company knowledge passages the reply relies on, e.g. 1, 3; empty if none]}
The AI employee's briefing follows, for the company's facts, tone and rules. Ignore its instructions about tools and handing off.`;

const str = (v: unknown) => (typeof v === "string" ? v : "");

const EXCERPT_CHARS = 400;

/** Writes a suggestion for the conversation and stores it. Throws AIProviderError when the model fails. */
export async function suggest(input: CopilotInput): Promise<CopilotSuggestion> {
  const { provider, organizationId, workspaceId, conversationId, employee } = input;
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, organizationId, workspaceId },
    include: { messages: { orderBy: { createdAt: "desc" }, take: 40 }, customer: { select: { customerId: true } } },
  });
  if (!conversation) throw new Error("Conversation not found");
  const messages = conversation.messages.reverse();
  const lastCustomerMessage = messages.findLast((m) => m.role === "USER")?.content ?? conversation.title;
  const customerId = conversation.customer?.customerId;
  const startedAt = Date.now();
  const signal = AbortSignal.timeout(input.timeoutMs);

  const [memory, matches] = await Promise.all([
    customerId ? input.memory.recall({ organizationId, workspaceId, customerId, conversationId }) : undefined,
    input.knowledge ? retrieve({ organizationId, workspaceId, query: lastCustomerMessage, signal, ...input.knowledge }) : [],
  ]);
  const speaker = { USER: "Customer", ASSISTANT: `${employee.name} (AI)`, AGENT: "Agent" } as const;
  const transcript = messages.map((m) => `${speaker[m.role]}: ${m.content}`).join("\n\n") || "(no messages yet)";

  let text = "";
  const usage = { inputTokens: 0, outputTokens: 0 };
  for await (const event of provider.stream({
    system: `${COPILOT_PROMPT}\n\n${systemPrompt(employee, matches, memory, false, conversation.channel)}`,
    messages: [{ role: "user", content: `The conversation so far:\n\n${transcript}` }],
    signal,
  })) {
    if (event.type === "text") text += event.text;
    else {
      usage.inputTokens = event.inputTokens;
      usage.outputTokens = event.outputTokens;
    }
  }
  if (!text.trim()) throw new AIProviderError("unavailable", "The provider returned an empty suggestion");

  // A model that ignored the format still gave a usable reply.
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  let parsed = { summary: "", reply: text.trim(), nextAction: "", citations: [] as number[] };
  try {
    const o = JSON.parse(json ?? "") as Record<string, unknown>;
    if (str(o.reply))
      parsed = {
        summary: str(o.summary),
        reply: str(o.reply),
        nextAction: str(o.nextAction),
        citations: Array.isArray(o.citations) ? o.citations.filter((n): n is number => Number.isInteger(n)) : [],
      };
  } catch {
    // Not JSON: the whole answer is the reply.
  }
  const toCitation = (m: (typeof matches)[number]): Citation => ({
    documentId: m.documentId,
    documentName: m.documentName,
    sourceName: m.sourceName,
    page: m.page,
    excerpt: m.content.slice(0, EXCERPT_CHARS),
  });
  const cited = parsed.citations.map((n) => matches[n - 1]).filter((m) => m !== undefined);
  // When the model named none, the agent still sees what the knowledge search found.
  const citations = (cited.length > 0 ? cited : matches).map(toCitation);
  const facts = (memory?.facts ?? []).map(({ key, value }) => ({ key, value }));

  const row = await prisma.copilotSuggestion.create({
    data: {
      organizationId,
      workspaceId,
      conversationId,
      requestedBy: input.requestedBy,
      reply: parsed.reply.trim(),
      summary: parsed.summary.trim(),
      nextAction: parsed.nextAction.trim(),
      memory: facts,
      citations,
      provider: provider.name,
      model: provider.model,
      ...usage,
      latencyMs: Date.now() - startedAt,
    },
  });
  return toSuggestion(row);
}

export const toSuggestion = (row: {
  id: string;
  reply: string;
  summary: string;
  nextAction: string;
  memory: unknown;
  citations: unknown;
  requestedBy: string;
  usedInMessageId: string | null;
  createdAt: Date;
}): CopilotSuggestion => ({
  id: row.id,
  reply: row.reply,
  summary: row.summary,
  nextAction: row.nextAction,
  // Written only by suggest() above, in these shapes.
  memory: row.memory as CopilotSuggestion["memory"],
  citations: row.citations as Citation[],
  requestedBy: row.requestedBy,
  usedInMessageId: row.usedInMessageId,
  createdAt: row.createdAt.toISOString(),
});
