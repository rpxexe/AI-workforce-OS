// The one path from a user message to a saved reply. Every channel calls `runTurn`; none of
// them talks to a provider or writes conversation rows itself.
import { randomUUID } from "node:crypto";
import {
  AIProviderError,
  type AIProvider,
  type AIProviderErrorKind,
  type ChatMessage,
  type EmbeddingProvider,
  type ToolCall,
  type ToolSpec,
} from "@workforce/ai-provider";
import { prisma, type Prisma } from "@workforce/database";
import { retrieve } from "@workforce/knowledge";
import type { MemoryService } from "@workforce/memory";
import type { ConversationMessage, ConversationSummary, EmployeeConfig, MessageSource, MessageTool } from "@workforce/shared";
import type { ToolExecutor } from "@workforce/tools";
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
  /**
   * The customer the conversation is with, already identified. Their memory is recalled before
   * the reply and updated after it, in the background; `onError` hears about failed updates.
   */
  customer?: { id: string; memory: MemoryService; onError: (err: unknown) => void };
  /** The tools granted to the employee, described for the model. Omit when there are none. */
  tools?: { executor: ToolExecutor; specs: ToolSpec[] };
  /** test | voice | web_chat | whatsapp | email | workflow: sets the reply style, and is stored on new conversations. */
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

/** Model calls per turn. The last one is not offered tools, so it has to answer. */
const MAX_STEPS = 6;

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

// workingHours and escalation are JSON columns; employeeConfigSchema validated them on the way in.
/** The configuration stored in an employee version row. */
export const configOf = (v: Prisma.AiEmployeeVersionGetPayload<object>) =>
  ({
    name: v.name,
    description: v.description,
    role: v.role,
    personality: v.personality,
    systemInstructions: v.systemInstructions,
    goals: v.goals,
    language: v.language,
    avatar: v.avatar,
    workingHours: v.workingHours,
    escalation: v.escalation,
  }) as EmployeeConfig;

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
  tools: (m.tools as MessageTool[] | null) ?? [],
});

/**
 * Runs one turn: loads the history, recalls the customer, finds the knowledge relevant to the
 * message, streams the reply (calling tools through the executor as the model asks), then saves
 * the user message and the reply together and lets memory learn from the exchange. A turn that fails, times out or is cancelled saves nothing, so the stored
 * conversation only ever contains complete exchanges.
 */
export async function* runTurn(input: TurnInput): AsyncGenerator<TurnEvent> {
  const { provider, organizationId, workspaceId, employeeId, conversationId, userMessage, customer, tools } = input;
  const timeout = AbortSignal.timeout(input.timeoutMs);
  const signal = input.signal ? AbortSignal.any([timeout, input.signal]) : timeout;
  const startedAt = new Date();

  try {
    const [history, memory, matches] = await Promise.all([
      conversationId
        ? prisma.conversationMessage.findMany({
            where: { conversation: { id: conversationId, organizationId, workspaceId, employeeId } },
            orderBy: { createdAt: "asc" },
            select: { role: true, content: true },
          })
        : [],
      customer?.memory.recall({ organizationId, workspaceId, customerId: customer.id, conversationId }),
      input.knowledge ? retrieve({ organizationId, workspaceId, query: userMessage, signal, ...input.knowledge }) : [],
    ]);
    const context = buildContext(
      input.employee,
      history.map((m) => ({ role: m.role === "USER" ? "user" : "assistant", content: m.content })),
      userMessage,
      matches,
      memory,
      tools !== undefined,
      input.channel,
    );
    // One entry per document and page, in the order the excerpts ranked.
    const sources = [...new Map(matches.map((m) => [`${m.documentId}:${m.page}`, m])).values()].map(
      ({ documentId, documentName, sourceName, page }): MessageSource => ({ documentId, documentName, sourceName, page }),
    );

    // Known before saving, so tool audit rows and calendar events can point at it.
    const id = conversationId ?? randomUUID();
    const chat: ChatMessage[] = [...context.messages];
    const toolsUsed: MessageTool[] = [];
    const usage = { inputTokens: 0, outputTokens: 0 };
    let reply = "";
    for (let step = 1; step <= MAX_STEPS; step++) {
      const offered = step < MAX_STEPS ? tools?.specs : undefined;
      let stepText = "";
      let calls: ToolCall[] = [];
      let raw: { provider: string; data: unknown } | undefined;
      let finished = false;
      for await (const event of provider.stream({ system: context.system, messages: chat, tools: offered, signal })) {
        if (event.type === "text") {
          // Text from an earlier step stays in the reply, as its own paragraph.
          const text = stepText === "" && reply.trim() !== "" ? `\n\n${event.text}` : event.text;
          stepText += event.text;
          reply += text;
          yield { type: "text", text };
        } else {
          usage.inputTokens += event.inputTokens;
          usage.outputTokens += event.outputTokens;
          calls = event.toolCalls ?? [];
          raw = event.raw;
          finished = true;
        }
      }
      if (!finished) throw new AIProviderError("unavailable", "The provider stream ended early");
      if (calls.length === 0 || !tools || !offered) break;

      chat.push({ role: "assistant", content: stepText, toolCalls: calls, raw });
      const results = [];
      // One at a time, in order: calls can depend on each other and have side effects.
      for (const call of calls) {
        const outcome = await tools.executor.execute(
          call,
          {
            organizationId,
            workspaceId,
            employeeId,
            conversationId: id,
            customerId: customer?.id,
            timezone: input.employee.workingHours.timezone,
            allowedTools: tools.specs.map((s) => s.name),
          },
          signal,
        );
        toolsUsed.push({ executionId: outcome.executionId, tool: call.name, status: outcome.status });
        results.push(outcome.result);
      }
      chat.push({ role: "tool", results });
    }
    if (reply.trim() === "") throw new AIProviderError("unavailable", "The provider returned an empty reply");

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
        tools: toolsUsed,
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
            id,
            organizationId,
            workspaceId,
            employeeId,
            channel: input.channel,
            title: userMessage.slice(0, 80),
            createdBy: input.userId,
            messages: { create: messages },
            ...(customer && { customer: { create: { customerId: customer.id } } }),
          },
          include,
        });
    const [assistant, user] = saved.messages;
    if (!assistant || !user) throw new Error("Saved turn is missing its messages");
    // Not awaited: the reply is done, and a failed extraction loses only what this turn taught.
    customer?.memory
      .remember({ organizationId, workspaceId, customerId: customer.id, conversationId: saved.id, customerMessage: userMessage, reply, replyId: assistant.id })
      .catch(customer.onError);
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
