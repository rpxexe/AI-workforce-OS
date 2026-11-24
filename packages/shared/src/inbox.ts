// Human + AI collaboration: handoff states and triggers, the agents' inbox, the AI Copilot, handoff analytics.
import { z } from "zod";
import type { ConversationMessage } from "./conversation.ts";
import type { MessageSource } from "./knowledge.ts";
import type { ConversationInsight } from "./insights.ts";
import type { CallTransferRecord } from "./voice.ts";

export const CONVERSATION_STATUSES = ["AI_ACTIVE", "WAITING_FOR_HUMAN", "HUMAN_ACTIVE", "RESOLVED", "REOPENED"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];
/** The AI answers only in these; in the others a person has the conversation. */
export const AI_ANSWERS: readonly ConversationStatus[] = ["AI_ACTIVE", "REOPENED"];

export const CONVERSATION_STATUS_LABELS: Record<ConversationStatus, string> = {
  AI_ACTIVE: "AI active",
  WAITING_FOR_HUMAN: "Waiting for human",
  HUMAN_ACTIVE: "Human active",
  RESOLVED: "Resolved",
  REOPENED: "Reopened",
};

export const HANDOFF_TRIGGERS = [
  "customer_request",
  "low_confidence",
  "policy_risk",
  "repeated_failure",
  "high_value_customer",
  "workflow_condition",
  "tool_failure",
  /** A person took over or assigned it from the inbox. */
  "agent",
] as const;
export type HandoffTrigger = (typeof HANDOFF_TRIGGERS)[number];

export const HANDOFF_TRIGGER_LABELS: Record<HandoffTrigger, string> = {
  customer_request: "Customer asked for a person",
  low_confidence: "Low confidence",
  policy_risk: "Policy risk",
  repeated_failure: "Repeated failure",
  high_value_customer: "High-value customer",
  workflow_condition: "Configured condition",
  tool_failure: "Tool failure",
  agent: "Taken over by an agent",
};

/** Inbox views: queue = waiting with no one assigned; mine = assigned to the caller and still open. */
export const INBOX_VIEWS = ["queue", "mine", "waiting", "human_active", "ai_active", "reopened", "resolved", "all"] as const;
export type InboxView = (typeof INBOX_VIEWS)[number];

export const inboxQuerySchema = z.object({
  view: z.enum(INBOX_VIEWS).default("queue"),
  employeeId: z.string().min(1).optional(),
});

/** What an agent can do to a conversation from the inbox. */
export const conversationActionSchema = z.discriminatedUnion("action", [
  /** Assign to the caller and answer as a person from now on. */
  z.object({ action: z.literal("take_over") }),
  /** Assign to someone (a Clerk user id), or back to the unassigned queue with null. Hands off an AI conversation. */
  z.object({ action: z.literal("assign"), userId: z.string().min(1).max(100).nullable() }),
  /** Hand the conversation back to the AI, which answers the customer's next message. */
  z.object({ action: z.literal("return_to_ai") }),
  z.object({ action: z.literal("resolve") }),
  z.object({ action: z.literal("reopen") }),
]);
export type ConversationAction = z.infer<typeof conversationActionSchema>;

export const agentMessageSchema = z.object({
  text: z.string().trim().min(1, "Write a message").max(4000),
  /** The Copilot suggestion the message started from, if any. */
  suggestionId: z.string().min(1).optional(),
});

export const analyticsQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

// ---- API responses (dates are ISO strings) ----

export type HandoffRecord = {
  id: string;
  trigger: HandoffTrigger;
  reason: string;
  assignedTo: string | null;
  requestedAt: string;
  acceptedAt: string | null;
  firstResponseAt: string | null;
  endedAt: string | null;
  outcome: "resolved" | "returned_to_ai" | null;
};

export type InboxItem = {
  id: string;
  title: string;
  channel: string;
  status: ConversationStatus;
  assignedTo: string | null;
  employee: { id: string; name: string };
  customer: { id: string; externalId: string; name: string | null } | null;
  lastMessage: Pick<ConversationMessage, "role" | "content" | "createdAt"> | null;
  /** The open handoff, if the conversation is with people. */
  handoff: Pick<HandoffRecord, "trigger" | "reason" | "requestedAt"> | null;
  updatedAt: string;
};

export type InboxResponse = { items: InboxItem[]; counts: Record<InboxView, number> };

export type Citation = MessageSource & { excerpt: string };

export type CopilotSuggestion = {
  id: string;
  reply: string;
  summary: string;
  nextAction: string;
  memory: { key: string; value: string }[];
  citations: Citation[];
  requestedBy: string;
  usedInMessageId: string | null;
  createdAt: string;
};

export type InboxConversation = Omit<InboxItem, "lastMessage" | "handoff"> & {
  messages: ConversationMessage[];
  handoffs: HandoffRecord[];
  /** Newest first. */
  suggestions: CopilotSuggestion[];
  /** Phone calls only: live transfers to a person. */
  transfers: CallTransferRecord[];
  /** Whether an agent's message can reach the customer on this channel (not on voice or workflow conversations). */
  canReply: boolean;
  /** Language, sentiment, intent, entities, resolution and escalation, worked out from the messages (Phase 15). */
  insight: ConversationInsight;
};

/** Durations are milliseconds; null when nothing was measured. */
export type DurationStats = { count: number; average: number | null; median: number | null; p90: number | null };

export type HandoffAnalytics = {
  days: number;
  conversations: number;
  handoffs: number;
  /** Share of conversations handed to people at least once, 0..1. */
  handoffRate: number | null;
  byTrigger: { trigger: HandoffTrigger; count: number }[];
  outcomes: { resolved: number; returnedToAi: number; open: number };
  /** Now, whatever the period. */
  open: { queue: number; assigned: number; humanActive: number };
  /** Requested -> a person took it over. */
  timeToAccept: DurationStats;
  /** Requested -> a person's first message. */
  timeToFirstResponse: DurationStats;
  /** Requested -> resolved by people. */
  timeToResolve: DurationStats;
  /** Customer message -> the next reply, by who replied. */
  replyTime: { ai: DurationStats; human: DurationStats };
  byAgent: { agentId: string; handoffs: number; resolved: number; firstResponse: DurationStats }[];
  suggestions: { total: number; used: number };
};
