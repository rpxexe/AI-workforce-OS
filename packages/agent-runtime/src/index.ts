// The one path from a user message to a saved reply. Every channel calls `runTurn`; none of
// them talks to a provider or writes conversation rows itself.
import {
  AIProviderError,
  type AIProvider,
  type AIProviderErrorKind,
  type EmbeddingProvider,
} from "@workforce/ai-provider";
import { prisma, type Prisma } from "@workforce/database";
import { retrieve } from "@workforce/knowledge";
import type { ConversationMessage, ConversationSummary, EmployeeConfig, MessageSource } from "@workforce/shared";
import { buildContext } from "./context.ts";

export { buildContext, systemPrompt } from "./context.ts";

export type TurnInput = {
  provider: AIProvider;
  /** Already authorized by the caller: the runtime trusts these ids. */
  organizationId: string;
  workspaceId: string;
  employeeId: string;
  userId: string;
  employee: EmployeeConfig;
  employeeVersion: number;
  /** Omit to start a new conversation. */
  conversationId?: string;
  /** The knowledge sources attached to the employee. Omit when there are none. */
  knowledge?: { embedder: EmbeddingProvider; sourceIds: string[] };
  channel: string;
  userMessage: string;
  timeoutMs: number;
  /** Aborts when the caller goes away. */
  signal?: AbortSignal;
};

export type TurnEvent =
  | { type: "text"; text: string }
  | { type: "done"; conversation: ConversationSummary; messages: [ConversationMessage, ConversationMessage] }
  /** `message` is safe to show; `cause` is for the server log. */
  | { type: "error"; kind: AIProviderErrorKind | "timeout" | "internal"; message: string; cause?: unknown };

const MESSAGES: Record<Extract<TurnEvent, { type: "error" }>["kind"], string> = {
  timeout: "The AI provider took too long to respond. Try again.",
  config: "The AI provider is not configured correctly on the server.",
  auth: "The AI provider's credentials are missing or invalid on the server.",
  billing: "The AI provider account is out of credits.",
  rate_limit: "The AI provider is rate limiting requests. Wait a moment and try again.",
  refused: "The model declined to answer this message.",
  invalid: "The AI provider rejected this request.",
  unavailable: "The AI provider is unavailable right now. Try again.",
  internal: "Something went wrong while answering. Try again.",
};

export const toMessage = (m: Prisma.ConversationMessageGetPayload<object>): ConversationMessage => ({
  id: m.id,
  role: m.role,
  content: m.content,
  createdAt: m.createdAt.toISOString(),
  employeeVersion: m.employeeVersion,
  model: m.model,
  inputTokens: m.inputTokens,
  outputTokens: m.outputTokens,
  // Written only by runTurn below, in this shape.
  sources: (m.sources as MessageSource[] | null) ?? [],
});

/**
 * Runs one turn: loads the history, finds the knowledge relevant to the message, streams the reply, then saves the user message and the
 * reply together. A turn that fails, times out or is cancelled saves nothing, so the stored
 * conversation only ever contains complete exchanges.
 */
export async function* runTurn(input: TurnInput): AsyncGenerator<TurnEvent> {
  const { provider, organizationId, workspaceId, employeeId, conversationId, userMessage } = input;
  const timeout = AbortSignal.timeout(input.timeoutMs);
  const signal = input.signal ? AbortSignal.any([timeout, input.signal]) : timeout;
  const startedAt = new Date();

  try {
    const history = conversationId
      ? await prisma.conversationMessage.findMany({
          where: { conversation: { id: conversationId, organizationId, workspaceId, employeeId } },
          orderBy: { createdAt: "asc" },
          select: { role: true, content: true },
        })
      : [];
    const matches = input.knowledge
      ? await retrieve({ organizationId, workspaceId, query: userMessage, signal, ...input.knowledge })
      : [];
    const context = buildContext(
      input.employee,
      history.map((m) => ({ role: m.role === "USER" ? "user" : "assistant", content: m.content })),
      userMessage,
      matches,
    );
    // One entry per document and page, in the order the excerpts ranked.
    const sources = [...new Map(matches.map((m) => [`${m.documentId}:${m.page}`, m])).values()].map(
      ({ documentId, documentName, sourceName, page }): MessageSource => ({ documentId, documentName, sourceName, page }),
    );

    let reply = "";
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    for await (const event of provider.stream({ ...context, signal })) {
      if (event.type === "text") {
        reply += event.text;
        yield event;
      } else usage = event;
    }
    if (!usage || reply.trim() === "") throw new AIProviderError("unavailable", "The provider returned an empty reply");

    // The reply is stamped at least 1 ms after the question so the pair always sorts in order.
    const finishedAt = new Date(Math.max(Date.now(), startedAt.getTime() + 1));
    const messages = [
      { role: "USER" as const, content: userMessage, createdAt: startedAt },
      {
        role: "ASSISTANT" as const,
        content: reply,
        createdAt: finishedAt,
        employeeVersion: input.employeeVersion,
        provider: provider.name,
        model: provider.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        latencyMs: finishedAt.getTime() - startedAt.getTime(),
        sources,
      },
    ];
    const include = { messages: { orderBy: { createdAt: "desc" }, take: 2 } } satisfies Prisma.ConversationInclude;
    const saved = conversationId
      ? await prisma.conversation.update({
          where: { id: conversationId },
          data: { updatedAt: finishedAt, messages: { create: messages } },
          include,
        })
      : await prisma.conversation.create({
          data: {
            organizationId,
            workspaceId,
            employeeId,
            channel: input.channel,
            title: userMessage.slice(0, 80),
            createdBy: input.userId,
            messages: { create: messages },
          },
          include,
        });
    const [assistant, user] = saved.messages;
    if (!assistant || !user) throw new Error("Saved turn is missing its messages");
    yield {
      type: "done",
      conversation: { id: saved.id, title: saved.title, updatedAt: saved.updatedAt.toISOString() },
      messages: [toMessage(user), toMessage(assistant)],
    };
  } catch (err) {
    // The caller left: nobody is listening, and nothing was saved.
    if (input.signal?.aborted) return;
    const kind = timeout.aborted ? "timeout" : err instanceof AIProviderError ? err.kind : "internal";
    yield { type: "error", kind, message: MESSAGES[kind], cause: err };
  }
}
