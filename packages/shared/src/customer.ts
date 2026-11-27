// Customers and what AI employees remember about them.
import { z } from "zod";
import type { ConversationStatus } from "./inbox.ts";

/** What a remembered fact is about. Anything else the extractor returns is dropped. */
export const MEMORY_CATEGORIES = ["identity", "preference", "fact", "lead", "follow_up"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

// ---- API responses (dates are ISO strings) ----

// ---- Requests ----

export const CUSTOMER_FILTERS = ["all", "week", "email", "phone"] as const;
export type CustomerFilter = (typeof CUSTOMER_FILTERS)[number];

/**
 * ?q= search, ?filter= (seen in the last 7 days, has email, has phone), ?limit= rows newest first by last seen, and
 * ?cursor= from the previous page's nextCursor (only valid for the same search and filter).
 */
export const listCustomersQuery = z.object({
  q: z.string().trim().max(100).optional(),
  filter: z.enum(CUSTOMER_FILTERS).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(1000).optional(),
});

/** ?q= for the counts: the same search as the list, every filter counted at once. */
export const customerCountsQuery = z.object({ q: z.string().trim().max(100).optional() });

/** A person correcting a remembered value. The same safety checks as extraction apply on the server. */
export const updateMemorySchema = z.object({ value: z.string().trim().min(1, "Enter a value").max(200, "Keep it under 200 characters") });

export type CustomerMemoryItem = {
  id: string;
  category: MemoryCategory;
  key: string;
  value: string;
  /** 0..1 as the extractor rated it, 1 after a person edits it, null when not recorded. */
  confidence: number | null;
  /** The conversation it was last learned in; null when set by a workflow or a person. */
  conversationId: string | null;
  updatedAt: string;
};

export type CustomerSummary = {
  id: string;
  /** How the channel identifies them: email, phone, chat visitor id. */
  externalId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  lastSeenAt: string;
};

/** GET …/customers/counts: whole-workspace numbers for the tiles and filter chips; they follow ?q=, not ?filter= or paging. */
export type CustomerCounts = {
  total: number;
  seenThisWeek: number;
  withEmail: number;
  withPhone: number;
  /** Has an email or a phone number. */
  reachable: number;
  withCompany: number;
};

/** One page of the customer list; `nextCursor` asks for the page after it (null: the list ends here). Counts: GET …/customers/counts. */
export type CustomerPage = { data: CustomerSummary[]; nextCursor: string | null };

export type CustomerDetail = CustomerSummary & {
  memories: CustomerMemoryItem[];
  conversations: {
    id: string;
    employeeId: string;
    channel: string;
    status: ConversationStatus;
    title: string;
    summary: string;
    updatedAt: string;
  }[];
};

/** Everything kept about a customer, as downloaded by an admin. */
export type CustomerExport = {
  exportedAt: string;
  customer: CustomerSummary & { createdAt: string };
  memories: (CustomerMemoryItem & { createdAt: string })[];
  conversations: { id: string; employeeId: string; channel: string; title: string; summary: string; createdAt: string; updatedAt: string }[];
};
