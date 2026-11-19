// When the AI hands a conversation to people. Some triggers are checked in code before the model is
// called (an explicit request, a high-value customer, configured conditions); the model reports the
// ones only it can judge (low confidence, policy risk) through the transfer_to_human tool; the turn
// itself notices tool failures and repeated failures.
import type { ToolSpec } from "@workforce/ai-provider";
import { prisma } from "@workforce/database";
import type { Recalled } from "@workforce/memory";
import { AI_ANSWERS, type ConversationStatus, type EmployeeConfig, type HandoffRule, type HandoffTrigger } from "@workforce/shared";

export type HandoffRequest = { trigger: HandoffTrigger; reason: string };
type Escalation = EmployeeConfig["escalation"];

export const DEFAULT_HANDOFF_MESSAGE = "I'm passing you to a member of our team. They will get back to you shortly.";
export const TRANSFER_TOOL = "transfer_to_human";

// English only; the model's transfer tool covers other languages and other phrasings.
const ASKS_FOR_HUMAN = [
  /\b(speak|talk|chat|connect|transfer|put)\b[^.?!\n]{0,30}\b(human|real person|person|agent|representative|operator|someone|somebody|staff|manager)\b/i,
  /^\W*(a\s+)?(human|agent|representative|operator|real person)(\s+please)?\W*$/i,
];
export const asksForHuman = (text: string) => ASKS_FOR_HUMAN.some((r) => r.test(text));

/** "$50,000" -> 50000; NaN when there is no number. */
export const toNumber = (value: string) => {
  const digits = value.replace(/[^0-9.-]/g, "");
  return digits === "" ? NaN : Number(digits);
};

const describe = (r: HandoffRule) =>
  `${r.field === "message" ? "message" : r.key} ${r.operator.replace("_", " ")} "${r.value}"`;

export function ruleMatches(rule: HandoffRule, message: string, facts: Map<string, string>) {
  const subject = rule.field === "message" ? message : facts.get(rule.key);
  if (subject === undefined) return false;
  switch (rule.operator) {
    case "contains":
      return subject.toLowerCase().includes(rule.value.toLowerCase());
    case "equals":
      return subject.trim().toLowerCase() === rule.value.toLowerCase();
    case "at_least":
    case "at_most": {
      const n = toNumber(subject);
      if (Number.isNaN(n)) return false;
      return rule.operator === "at_least" ? n >= Number(rule.value) : n <= Number(rule.value);
    }
  }
}

/**
 * Triggers decided in code, before the model is asked. `earlier` are the conversation's past handoffs:
 * a high-value customer or a configured condition hands a conversation off once, so handing it back
 * to the AI sticks. An explicit request for a person always counts.
 */
export function handoffBeforeReply(escalation: Escalation, message: string, memory: Recalled | undefined, earlier: HandoffRequest[]): HandoffRequest | null {
  if (!escalation.enabled) return null;
  if (escalation.onCustomerRequest && asksForHuman(message)) return { trigger: "customer_request", reason: "The customer asked for a person" };
  const facts = new Map((memory?.facts ?? []).map((f) => [f.key, f.value]));
  if (escalation.highValueKey) {
    const value = facts.get(escalation.highValueKey);
    if (value !== undefined && toNumber(value) >= escalation.highValueMinimum && !earlier.some((e) => e.trigger === "high_value_customer"))
      return { trigger: "high_value_customer", reason: `${escalation.highValueKey} is ${value}` };
  }
  for (const rule of escalation.rules) {
    const reason = `Condition: ${describe(rule)}`;
    if (ruleMatches(rule, message, facts) && !earlier.some((e) => e.trigger === "workflow_condition" && e.reason === reason))
      return { trigger: "workflow_condition", reason };
  }
  return null;
}

type TransferReason = Extract<HandoffTrigger, "customer_request" | "low_confidence" | "policy_risk">;

const transferReasons = (e: Escalation): TransferReason[] =>
  e.enabled
    ? [e.onCustomerRequest && ("customer_request" as const), e.onLowConfidence && ("low_confidence" as const), e.onPolicyRisk && ("policy_risk" as const)].filter(
        (r) => r !== false,
      )
    : [];

const GUIDANCE: Record<TransferReason, string> = {
  customer_request: "- customer_request: the customer asks to speak with a person.",
  low_confidence: "- low_confidence: you cannot answer reliably from your instructions, knowledge and tools. Hand off instead of guessing.",
  policy_risk:
    "- policy_risk: answering could break the company's policy or the law: legal, medical or financial advice, refunds, discounts or exceptions you are not authorised to give, complaints that threaten legal action, abuse, or a safety concern.",
};

/** The tool the model hands off with, and the instructions for it; null when the employee hands nothing off this way. */
export function transferTool(escalation: Escalation): { spec: ToolSpec; guidance: string } | null {
  const reasons = transferReasons(escalation);
  if (reasons.length === 0) return null;
  return {
    spec: {
      name: TRANSFER_TOOL,
      description: "Hand this conversation to a human colleague, who continues it with the customer. The customer is told a colleague is coming.",
      inputSchema: {
        type: "object",
        properties: {
          reason: { type: "string", enum: reasons },
          note: { type: "string", description: "One sentence for the colleague: what the customer needs." },
        },
        required: ["reason", "note"],
        additionalProperties: false,
      },
    },
    guidance: [
      `You can hand the conversation to a human colleague by calling ${TRANSFER_TOOL}. Call it, with the matching reason, when:`,
      ...reasons.map((r) => GUIDANCE[r]),
      "Otherwise keep helping the customer yourself. Do not promise what the colleague will do.",
    ].join("\n"),
  };
}

/** What the model asked for when it called the transfer tool; anything malformed counts as low confidence. */
export function transferRequest(input: unknown, escalation: Escalation): HandoffRequest {
  const { reason, note } = (input ?? {}) as { reason?: unknown; note?: unknown };
  const allowed = transferReasons(escalation) as string[];
  const trigger = (typeof reason === "string" && allowed.includes(reason) ? reason : "low_confidence") as TransferReason;
  return { trigger, reason: typeof note === "string" && note.trim() ? note.trim().slice(0, 500) : "The employee asked for a person" };
}

/** Statuses a conversation can be handed to people from (a resolved one is reopened by it). */
const HANDABLE: ConversationStatus[] = [...AI_ANSWERS, "RESOLVED"];

/**
 * Hands a conversation to people outside a turn (an agent in the inbox, a workflow step). Returns
 * null if people already have it. `assignedTo` with `accept` means that person is answering now.
 */
export async function startHandoff(
  conversation: { id: string; organizationId: string; workspaceId: string },
  request: HandoffRequest,
  options: { assignedTo?: string | null; accept?: boolean } = {},
) {
  const now = new Date();
  const assignedTo = options.assignedTo ?? null;
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.conversation.updateMany({
      where: { ...conversation, status: { in: HANDABLE } },
      data: { status: options.accept ? "HUMAN_ACTIVE" : "WAITING_FOR_HUMAN", assignedTo, resolvedAt: null },
    });
    if (count === 0) return null;
    const { employeeId } = await tx.conversation.findUniqueOrThrow({ where: { id: conversation.id }, select: { employeeId: true } });
    return tx.handoff.create({
      data: {
        organizationId: conversation.organizationId,
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        employeeId,
        ...request,
        assignedTo,
        requestedAt: now,
        acceptedAt: options.accept ? now : null,
      },
    });
  });
}
