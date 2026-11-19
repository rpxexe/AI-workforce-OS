import { z } from "zod";
import type { MessageSource } from "./knowledge.ts";
import type { ConversationStatus, HandoffTrigger } from "./inbox.ts";
import type { MessageTool } from "./tool.ts";

export const sendMessageSchema = z.object({
  /** Omit to start a new conversation. */
  conversationId: z.string().min(1).optional(),
  message: z.string().trim().min(1, "Write a message").max(8000),
  /**
   * Who the employee is talking to (email, phone, visitor id), so it remembers them across
   * conversations. Used when starting a conversation; later turns keep the conversation's customer.
   */
  customer: z.string().trim().min(1).max(200).optional(),
});
export type SendMessage = z.infer<typeof sendMessageSchema>;

// ---- API responses (dates are ISO strings) ----

export type ConversationMessage = {
  id: string;
  /** AGENT: a human agent, from the inbox. */
  role: "USER" | "ASSISTANT" | "AGENT";
  content: string;
  createdAt: string;
  /** AGENT messages: the Clerk user who wrote it. */
  authorId: string | null;
  /** Assistant messages only: the employee version that answered, and what the reply cost. */
  employeeVersion: number | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Knowledge documents the reply was given excerpts from; empty when none were used. */
  sources: MessageSource[];
  /** Tools the employee called while writing this reply; empty when none. */
  tools: MessageTool[];
};

export type ConversationSummary = { id: string; title: string; updatedAt: string; status: ConversationStatus };

/** A handoff the turn started: the reply is the employee's handoff message. */
export type TurnHandoff = { id: string; trigger: HandoffTrigger; reason: string };

export type ConversationDetail = ConversationSummary & {
  messages: ConversationMessage[];
  /** The customer's external id, when the conversation is with a known customer. */
  customer: string | null;
};

/**
 * What `POST .../employees/:id/messages` streams, one per server-sent event. A turn ends with
 * `done` (both messages are saved), `held` (a person handles the conversation: only the message
 * was saved, the AI did not answer) or `error` (nothing was saved).
 */
export type ChatStreamEvent =
  | { type: "text"; text: string }
  | { type: "done"; conversation: ConversationSummary; messages: [ConversationMessage, ConversationMessage]; handoff?: TurnHandoff }
  | { type: "held"; conversation: ConversationSummary; message: ConversationMessage }
  | { type: "error"; error: string };
