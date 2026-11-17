// Customers and what AI employees remember about them.

/** What a remembered fact is about. Anything else the extractor returns is dropped. */
export const MEMORY_CATEGORIES = ["identity", "preference", "fact", "lead", "follow_up"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

// ---- API responses (dates are ISO strings) ----

export type CustomerMemoryItem = { category: MemoryCategory; key: string; value: string; updatedAt: string };

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

export type CustomerDetail = CustomerSummary & {
  memories: CustomerMemoryItem[];
  conversations: { id: string; employeeId: string; title: string; summary: string; updatedAt: string }[];
};
