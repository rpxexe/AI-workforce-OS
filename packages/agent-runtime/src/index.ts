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
import { Prisma, prisma } from "@workforce/database";
import { retrieve } from "@workforce/knowledge";
import type { MemoryService } from "@workforce/memory";
import {
  AI_ANSWERS,
  defaultEscalation,
  type ConversationMessage,
  type ConversationStatus,
  type ConversationSummary,
  type EmployeeConfig,
  type HandoffTrigger,
  type MessageSource,
  type MessageTool,
  type TurnHandoff,
} from "@workforce/shared";
import type { ToolExecutor } from "@workforce/tools";
import { buildContext } from "./context.ts";
import { DEFAULT_HANDOFF_MESSAGE, handoffBeforeReply, TRANSFER_TOOL, transferRequest, transferTool, type HandoffRequest } from "./handoff.ts";

export { buildContext, systemPrompt } from "./context.ts";
export { asksForHuman, DEFAULT_HANDOFF_MESSAGE, ruleMatches, startHandoff, toNumber, TRANSFER_TOOL, type HandoffRequest } from "./handoff.ts";
export { suggest, toSuggestion, type CopilotInput } from "./copilot.ts";
export { ROLLOUT_INCLUDE, rolloutBucket, servedVersion } from "./rollout.ts";

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
  /** Called (not awaited) after a turn hands the conversation to people. */
  onHandoff?: (notice: HandoffNotice) => void;
};

/** Told when a turn hands a conversation to people, so someone can be notified. */
export type HandoffNotice = {
  organizationId: string;
  workspaceId: string;
  employeeId: string;
  employeeName: string;
  conversationId: string;
  handoffId: string;
  trigger: HandoffTrigger;
  reason: string;
  /** The employee's escalation contact; empty when none is set. */
  contactEmail: string;
};

export type TurnEvent =
  | { type: "text"; text: string }
  /** `handoff`: this turn handed the conversation to people; the reply ends with the handoff message. */
  | { type: "done"; conversation: ConversationSummary; messages: [ConversationMessage, ConversationMessage]; handoff?: TurnHandoff }
  /** People have the conversation: the message was saved and the AI did not answer. */
  | { type: "held"; conversation: ConversationSummary; message: ConversationMessage }
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

/** A message safe to show for an error a provider call threw. */
export const errorMessage = (err: unknown) => MESSAGES[err instanceof AIProviderError ? err.kind : "internal"];

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
    // Versions saved before a setting existed get its default.
    escalation: { ...defaultEscalation(), ...(v.escalation as object) },
  }) as EmployeeConfig;

export const toMessage = (m: Prisma.ConversationMessageGetPayload<object>): ConversationMessage => ({
  id: m.id,
  role: m.role,
  content: m.content,
  createdAt: m.createdAt.toISOString(),
  authorId: m.authorId,
  employeeVersion: m.employeeVersion,
  model: m.model,
  inputTokens: m.inputTokens,
  outputTokens: m.outputTokens,
  // Written only by runTurn below, in this shape.
  sources: (m.sources as MessageSource[] | null) ?? [],
  tools: (m.tools as MessageTool[] | null) ?? [],
});

const toSummary = (c: { id: string; title: string; updatedAt: Date; status: ConversationStatus }): ConversationSummary => ({
  id: c.id,
  title: c.title,
  updatedAt: c.updatedAt.toISOString(),
  status: c.status,
});

/**
 * Runs one turn: loads the history, recalls the customer, finds the knowledge relevant to the
 * message, streams the reply (calling tools through the executor as the model asks), then saves
 * the user message and the reply together and lets memory learn from the exchange. A turn that
 * fails, times out or is cancelled saves nothing, so the stored conversation only ever contains
 * complete exchanges.
 *
 * Handoff: while people have the conversation (WAITING_FOR_HUMAN, HUMAN_ACTIVE) the message is saved
 * and nothing answers it (`held`). A turn that hands off (see handoff.ts) ends its reply with the
 * employee's handoff message and leaves the conversation waiting in the queue.
 */
export async function* runTurn(input: TurnInput): AsyncGenerator<TurnEvent> {
  const { provider, organizationId, workspaceId, employeeId, conversationId, userMessage, customer, tools } = input;
  const timeout = AbortSignal.timeout(input.timeoutMs);
  const signal = input.signal ? AbortSignal.any([timeout, input.signal]) : timeout;
  const startedAt = new Date();
  const escalation = input.employee.escalation;
  const tenant = { organizationId, workspaceId, employeeId };
  const include = {
    messages: { orderBy: { createdAt: "desc" }, take: 2 },
    handoffs: { where: { endedAt: null }, orderBy: { requestedAt: "desc" }, take: 1 },
  } satisfies Prisma.ConversationInclude;

  /** Saves only the customer's message: people are handling the conversation. */
  const hold = async (id: string): Promise<TurnEvent> => {
    const saved = await prisma.conversation.update({
      where: { id },
      data: { messages: { create: { role: "USER", content: userMessage, createdAt: startedAt } } },
      include: { messages: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    const [message] = saved.messages;
    if (!message) throw new Error("Saved message is missing");
    return { type: "held", conversation: toSummary(saved), message: toMessage(message) };
  };

  let conversation: { status: ConversationStatus; handoffs: HandoffRequest[] } | null = null;
  if (conversationId) {
    try {
      const row = await prisma.conversation.findFirst({
        where: { id: conversationId, ...tenant },
        select: { status: true, handoffs: { select: { trigger: true, reason: true } } },
      });
      conversation = row && { status: row.status, handoffs: row.handoffs as HandoffRequest[] };
      if (conversation?.status === "WAITING_FOR_HUMAN" || conversation?.status === "HUMAN_ACTIVE") {
        yield await hold(conversationId);
        return;
      }
    } catch (err) {
      yield { type: "error", kind: "internal", message: MESSAGES.internal, cause: err };
      return;
    }
  }
  // Known before saving, so tool audit rows and calendar events can point at it.
  const id = conversationId ?? randomUUID();
  const handoffLine = escalation.handoffMessage || DEFAULT_HANDOFF_MESSAGE;

  /** Saves the exchange, with the handoff it started if any; held instead if people took the conversation over meanwhile. */
  async function* save(
    reply: string,
    handoff: HandoffRequest | null,
    meta: Omit<Prisma.ConversationMessageCreateWithoutConversationInput, "role" | "content">,
  ): AsyncGenerator<TurnEvent> {
    // The reply is stamped at least 1 ms after the question so the pair always sorts in order.
    const finishedAt = new Date(Math.max(Date.now(), startedAt.getTime() + 1));
    const messages = [
      { role: "USER" as const, content: userMessage, createdAt: startedAt },
      { role: "ASSISTANT" as const, content: reply, createdAt: finishedAt, employeeVersion: input.employeeVersion, ...meta },
    ];
    const status: ConversationStatus | undefined = handoff ? "WAITING_FOR_HUMAN" : conversation?.status === "RESOLVED" ? "REOPENED" : undefined;
    const handoffs = handoff ? { create: { organizationId, workspaceId, employeeId, ...handoff, requestedAt: finishedAt } } : undefined;
    let saved;
    try {
      saved = conversationId
        ? await prisma.conversation.update({
            // Only while the AI still has it: an agent may have taken over during the turn.
            where: { id: conversationId, status: { in: [...AI_ANSWERS, "RESOLVED"] } },
            data: {
              updatedAt: finishedAt,
              failedTurns: 0,
              ...(status && { status, assignedTo: null }),
              messages: { create: messages },
              ...(handoffs && { handoffs }),
            },
            include,
          })
        : await prisma.conversation.create({
            data: {
              id,
              ...tenant,
              channel: input.channel,
              title: userMessage.slice(0, 80),
              createdBy: input.userId,
              ...(status && { status }),
              messages: { create: messages },
              ...(handoffs && { handoffs }),
              ...(customer && { customer: { create: { customerId: customer.id } } }),
            },
            include,
          });
    } catch (err) {
      if (conversationId && err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        yield await hold(conversationId);
        return;
      }
      throw err;
    }
    const [assistant, user] = saved.messages;
    if (!assistant || !user) throw new Error("Saved turn is missing its messages");
    // Not awaited: the reply is done, and a failed extraction loses only what this turn taught.
    customer?.memory
      .remember({ organizationId, workspaceId, customerId: customer.id, conversationId: saved.id, customerMessage: userMessage, reply, replyId: assistant.id })
      .catch(customer.onError);
    const started = handoff ? saved.handoffs[0] : undefined;
    if (handoff && started)
      try {
        input.onHandoff?.({
          ...tenant,
          employeeName: input.employee.name,
          conversationId: saved.id,
          handoffId: started.id,
          ...handoff,
          contactEmail: escalation.contactEmail,
        });
      } catch {
        // A failed notification must not lose the reply.
      }
    yield {
      type: "done",
      conversation: toSummary(saved),
      messages: [toMessage(user), toMessage(assistant)],
      ...(handoff && started && { handoff: { id: started.id, ...handoff } }),
    };
  }

  try {
    const [history, memory, matches] = await Promise.all([
      conversationId
        ? prisma.conversationMessage.findMany({
            where: { conversation: { id: conversationId, ...tenant } },
            orderBy: { createdAt: "asc" },
            select: { role: true, content: true },
          })
        : [],
      customer?.memory.recall({ organizationId, workspaceId, customerId: customer.id, conversationId }),
      input.knowledge ? retrieve({ organizationId, workspaceId, query: userMessage, signal, ...input.knowledge }) : [],
    ]);

    let handoff = handoffBeforeReply(escalation, userMessage, memory, conversation?.handoffs ?? []);
    if (handoff) {
      yield { type: "text", text: handoffLine };
      yield* save(handoffLine, handoff, {});
      return;
    }

    const context = buildContext(
      input.employee,
      history.map((m) => ({ role: m.role === "USER" ? "user" : "assistant", content: m.content })),
      userMessage,
      matches,
      memory,
      tools !== undefined,
      input.channel,
    );
    const transfer = transferTool(escalation);
    const system = [
      context.system,
      history.some((m) => m.role === "AGENT") &&
        "Part of this conversation was handled by a human colleague; their messages appear as yours. Continue from where they left off and keep any commitments they made.",
      transfer?.guidance,
    ]
      .filter(Boolean)
      .join("\n\n");
    const specs = [...(tools?.specs ?? []), ...(transfer ? [transfer.spec] : [])];
    // One entry per document and page, in the order the excerpts ranked.
    const sources = [...new Map(matches.map((m) => [`${m.documentId}:${m.page}`, m])).values()].map(
      ({ documentId, documentName, sourceName, page }): MessageSource => ({ documentId, documentName, sourceName, page }),
    );

    const chat: ChatMessage[] = [...context.messages];
    const toolsUsed: MessageTool[] = [];
    const usage = { inputTokens: 0, outputTokens: 0 };
    // Who wrote the reply: the router may answer a step with a fallback model, so this comes from each step's result.
    let handledBy = { provider: provider.name, model: provider.model };
    let reply = "";
    for (let step = 1; step <= MAX_STEPS; step++) {
      const offered = step < MAX_STEPS && specs.length > 0 ? specs : undefined;
      let stepText = "";
      let calls: ToolCall[] = [];
      let raw: { provider: string; data: unknown } | undefined;
      let finished = false;
      for await (const event of provider.stream({ system, messages: chat, tools: offered, signal })) {
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
          handledBy = { provider: event.provider ?? provider.name, model: event.model ?? provider.model };
          finished = true;
        }
      }
      if (!finished) throw new AIProviderError("unavailable", "The provider stream ended early");
      if (calls.length === 0 || !offered) break;
      // Handing off ends the turn: the colleague continues, not the model.
      const transferCall = calls.find((c) => c.name === TRANSFER_TOOL);
      if (transferCall) {
        handoff = transferRequest(transferCall.input, escalation);
        break;
      }

      chat.push({ role: "assistant", content: stepText, toolCalls: calls, raw });
      const results = [];
      // One at a time, in order: calls can depend on each other and have side effects.
      for (const call of calls) {
        if (!tools) {
          results.push({ callId: call.id, content: JSON.stringify({ error: `Unknown tool: ${call.name}` }), isError: true });
          continue;
        }
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
        // The model still answers (and explains the failure); people take over after this reply.
        if (outcome.status === "FAILED" && escalation.enabled && escalation.onToolFailure)
          handoff ??= { trigger: "tool_failure", reason: `The ${call.name} tool failed` };
      }
      chat.push({ role: "tool", results });
    }
    if (handoff) {
      const text = reply.trim() === "" ? handoffLine : `\n\n${handoffLine}`;
      reply += text;
      yield { type: "text", text };
    }
    if (reply.trim() === "") throw new AIProviderError("unavailable", "The provider returned an empty reply");

    yield* save(reply, handoff, {
      ...handledBy,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      latencyMs: Date.now() - startedAt.getTime(),
      sources,
      tools: toolsUsed,
    });
  } catch (err) {
    // The caller left: nobody is listening, and nothing was saved.
    if (input.signal?.aborted) return;
    const kind = timeout.aborted ? "timeout" : err instanceof AIProviderError ? err.kind : "internal";
    // Repeated failure: after the employee's limit of failed turns in a row, people take over.
    if (conversationId && conversation && escalation.enabled && escalation.afterFailedAttempts > 0) {
      let failedTurns = 0;
      try {
        ({ failedTurns } = await prisma.conversation.update({ where: { id: conversationId }, data: { failedTurns: { increment: 1 } } }));
      } catch {
        // Counting is best effort; the error below still reaches the caller.
      }
      if (failedTurns >= escalation.afterFailedAttempts) {
        try {
          yield { type: "text", text: handoffLine };
          yield* save(handoffLine, { trigger: "repeated_failure", reason: `${failedTurns} replies in a row failed (last: ${MESSAGES[kind]})` }, {});
          return;
        } catch (saveErr) {
          yield { type: "error", kind: "internal", message: MESSAGES.internal, cause: saveErr };
          return;
        }
      }
    }
    yield { type: "error", kind, message: MESSAGES[kind], cause: err };
  }
}
