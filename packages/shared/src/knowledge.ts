import { z } from "zod";

export const KNOWLEDGE_KINDS = ["pdf", "docx", "txt", "csv"] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** The kind of a file, from its extension; undefined when it is not one we can read. */
export const knowledgeKindOf = (fileName: string) =>
  KNOWLEDGE_KINDS.find((kind) => fileName.toLowerCase().endsWith(`.${kind}`));

export const knowledgeSourceSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  description: z.string().trim().max(500).default(""),
});

export const uploadQuerySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((name) => knowledgeKindOf(name) !== undefined, "Upload a PDF, DOCX, TXT or CSV file"),
});

export const KNOWLEDGE_SOURCE_FILTERS = ["all", "filled", "empty"] as const;
export type KnowledgeSourceFilter = (typeof KNOWLEDGE_SOURCE_FILTERS)[number];

/** ?q= searches source names and descriptions; ?filter= keeps sources with documents (filled) or without (empty). Paging fields are added by the API. */
export const listKnowledgeSourcesQuery = z.object({
  q: z.string().trim().max(100).optional(),
  filter: z.enum(KNOWLEDGE_SOURCE_FILTERS).default("all"),
});

/** Replaces the set of sources an employee answers from. */
export const employeeKnowledgeSchema = z.object({ sourceIds: z.array(z.string().min(1)).max(20) });

export const knowledgeSearchSchema = z.object({
  query: z.string().trim().min(1, "Enter something to search for").max(1000),
  /** Limit the search to these sources; omit to search the whole workspace. */
  sourceIds: z.array(z.string().min(1)).max(50).optional(),
});

// ---- API responses (dates are ISO strings) ----

export type DocumentStatus = "PENDING" | "PROCESSING" | "READY" | "FAILED";

export type KnowledgeDocument = {
  id: string;
  name: string;
  kind: KnowledgeKind;
  sizeBytes: number;
  status: DocumentStatus;
  /** Why processing failed, in words a person can act on. */
  error: string | null;
  chunkCount: number;
  createdAt: string;
};

export type KnowledgeSource = {
  id: string;
  name: string;
  description: string;
  documentCount: number;
  updatedAt: string;
};

/** A source in the list, with its documents counted by status (processing includes pending). */
export type KnowledgeSourceSummary = KnowledgeSource & { readyDocuments: number; processingDocuments: number; failedDocuments: number };

/** One page of sources, by name; `nextCursor` opens the next page, null on the last. */
export type KnowledgeSourcePage = { data: KnowledgeSourceSummary[]; nextCursor: string | null };

/** Headline numbers over every source matching the search (processing includes pending). */
export type KnowledgeSourceCounts = {
  sources: number;
  emptySources: number;
  documents: number;
  readyDocuments: number;
  processingDocuments: number;
  failedDocuments: number;
};

export type KnowledgeSourceDetail =KnowledgeSource & { documents: KnowledgeDocument[] };

/** One excerpt found by a search, with enough to trace it back to where it came from. */
export type KnowledgeMatch = {
  chunkId: string;
  content: string;
  /** Cosine similarity to the query: 1 is identical in meaning, 0 is unrelated. */
  score: number;
  page: number | null;
  documentId: string;
  documentName: string;
  sourceId: string;
  sourceName: string;
};

/** A document (and page) a reply was given excerpts from. */
export type MessageSource = Pick<KnowledgeMatch, "documentId" | "documentName" | "sourceName" | "page">;
