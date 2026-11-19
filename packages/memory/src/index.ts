// Persistent customer memory: who a customer is and what matters about them, carried from one
// conversation to the next.
//
//   conversation -> extraction (model) -> validation (parseExtraction) -> storage
//   next conversation -> recall -> system prompt
import type { AIProvider } from "@workforce/ai-provider";
import { prisma } from "@workforce/database";
import type { MemoryCategory } from "@workforce/shared";
import { extractionRequest, parseExtraction, type Fact } from "./extract.ts";

export { EXTRACTION_PROMPT, extractionRequest, parseExtraction, type Fact } from "./extract.ts";

/** Already authorized by the caller: the service trusts these ids and filters every query on them. */
export type CustomerScope = { organizationId: string; workspaceId: string };

export type Recalled = {
  /** Most recently learned first. */
  facts: Fact[];
  /** Summaries of the customer's other conversations, newest first. */
  previous: { summary: string; at: Date; channel: string }[];
};

export interface MemoryService {
  /** The customer the channel knows by `externalId`, created on first contact. Returns its id. */
  identify(scope: CustomerScope, externalId: string): Promise<string>;
  /** What to tell the employee about the customer. `conversationId` is left out of `previous`. */
  recall(scope: CustomerScope & { customerId: string; conversationId?: string }): Promise<Recalled>;
  /** Extracts what is worth keeping from one exchange, validates it and stores it. Returns what was stored. */
  remember(
    scope: CustomerScope & {
      customerId: string;
      conversationId: string;
      customerMessage: string;
      reply: string;
      /** The saved reply's id, so a queued job can load the exchange instead of carrying its text. */
      replyId?: string;
    },
  ): Promise<Fact[]>;
}

// shortcut: recall sends every fact (newest 50); rank by relevance when customers collect hundreds
const RECALL_FACTS = 50;
const RECALL_CONVERSATIONS = 5;
const PROFILE_KEYS = ["name", "email", "phone", "company"] as const;

const customerIn = (scope: CustomerScope & { customerId: string }) => ({
  id: scope.customerId,
  organizationId: scope.organizationId,
  workspaceId: scope.workspaceId,
});

/** The customer known by `externalId` in the workspace, created on first contact. Returns its id. */
export async function identifyCustomer({ organizationId, workspaceId }: CustomerScope, externalId: string) {
  // Create-if-missing without upsert, which is not atomic (see DECISIONS.md).
  await prisma.customer.createMany({ data: [{ organizationId, workspaceId, externalId }], skipDuplicates: true });
  const customer = await prisma.customer.update({
    where: { workspaceId_externalId: { workspaceId, externalId }, organizationId },
    data: { lastSeenAt: new Date() },
    select: { id: true },
  });
  return customer.id;
}

/**
 * The writes that store `facts` for a customer, for one transaction: new keys are inserted, then
 * every key is overwritten (last writer wins, no upsert race), and identity keys update the profile.
 */
export function factWrites(customerId: string, facts: Fact[], conversationId: string | null) {
  const profile = Object.fromEntries(
    facts.filter((f) => f.category === "identity" && (PROFILE_KEYS as readonly string[]).includes(f.key)).map((f) => [f.key, f.value]),
  );
  return [
    prisma.customerMemory.createMany({ data: facts.map((f) => ({ customerId, conversationId, ...f })), skipDuplicates: true }),
    ...facts.map((f) =>
      prisma.customerMemory.updateMany({ where: { customerId, key: f.key }, data: { category: f.category, value: f.value, conversationId } }),
    ),
    prisma.customerProfile.createMany({ data: [{ customerId, ...profile }], skipDuplicates: true }),
    prisma.customerProfile.update({ where: { customerId }, data: profile }),
  ];
}

/** Memory stored in Postgres, with `provider` doing the extraction. */
export function memoryService(provider: AIProvider, timeoutMs: number): MemoryService {
  return {
    identify: identifyCustomer,

    async recall(scope) {
      const customer = await prisma.customer.findFirst({
        where: customerIn(scope),
        select: {
          memories: { orderBy: { updatedAt: "desc" }, take: RECALL_FACTS },
          conversations: {
            where: { conversationId: { not: scope.conversationId }, summary: { not: "" } },
            orderBy: { updatedAt: "desc" },
            take: RECALL_CONVERSATIONS,
            include: { conversation: { select: { channel: true } } },
          },
        },
      });
      return {
        facts: (customer?.memories ?? []).map((m) => ({ category: m.category as MemoryCategory, key: m.key, value: m.value })),
        previous: (customer?.conversations ?? []).map((c) => ({ summary: c.summary, at: c.updatedAt, channel: c.conversation.channel })),
      };
    },

    async remember(scope) {
      const { customerId, conversationId } = scope;
      const customer = await prisma.customer.findFirst({
        where: customerIn(scope),
        select: { memories: true, conversations: { where: { conversationId }, select: { summary: true } } },
      });
      if (!customer) throw new Error("Customer not found");
      const known = customer.memories.map((m) => ({ category: m.category as MemoryCategory, key: m.key, value: m.value }));

      let text = "";
      const request = extractionRequest(known, customer.conversations[0]?.summary ?? "", scope.customerMessage, scope.reply);
      for await (const event of provider.stream({ ...request, signal: AbortSignal.timeout(timeoutMs) }))
        if (event.type === "text") text += event.text;
      const { facts, summary } = parseExtraction(text);

      await prisma.$transaction([
        ...factWrites(customerId, facts, conversationId),
        ...(summary ? [prisma.customerConversation.updateMany({ where: { conversationId, customerId }, data: { summary } })] : []),
      ]);
      return facts;
    },
  };
}
