import { z } from "zod";
import type { MessageSource } from "./knowledge.ts";

export const sendMessageSchema = z.object({
  /** Omit to start a new conversation. */
  conversationId: z.string().min(1).optional(),
  message: z.string().trim().min(1, "Write a message").max(8000),
});
export type SendMessage = z.infer<typeof sendMessageSchema>;

// ---- API responses (dates are ISO strings) ----

export type ConversationMessage = {
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  createdAt: string;
  /** Assistant messages only: the employee version that answered, and what the reply cost. */
  employeeVersion: number | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Knowledge documents the reply was given excerpts from; empty when none were used. */
  sources: MessageSource[];
};

export type ConversationSummary = { id: string; title: string; updatedAt: string };

export type ConversationDetail = ConversationSummary & { messages: ConversationMessage[] };

/**
 * What `POST .../employees/:id/messages` streams, one per server-sent event. A turn ends with
 * `done` (both messages are saved) or `error` (nothing was saved).
 */
export type ChatStreamEvent =
  | { type: "text"; text: string }
  | { type: "done"; conversation: ConversationSummary; messages: [ConversationMessage, ConversationMessage] }
  | { type: "error"; error: string };
