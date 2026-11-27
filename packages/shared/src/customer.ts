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

/** ?q= search, ?filter= (seen in the last 7 days, has email, has phone), and ?page= (from 1) of ?limit= newest first by last seen. */
export const listCustomersQuery = z.object({
  q: z.string().trim().max(100).optional(),
  filter: z.enum(CUSTOMER_FILTERS).default("all"),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

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

/** Whole-workspace counts for the list's tiles and filters; they follow ?q= but not ?filter= or paging. */
export type CustomerCounts = {
  total: number;
  seenThisWeek: number;
  withEmail: number;
  withPhone: number;
  /** Has an email or a phone number. */
  reachable: number;
  withCompany: number;
};

/** One page of the customer list; `total` is how many match the search and filter, for the page count. */
export type CustomerPage = { data: CustomerSummary[]; total: number; counts: CustomerCounts };

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
