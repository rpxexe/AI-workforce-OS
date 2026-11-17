// Company knowledge: turning uploaded files into searchable chunks, and finding the chunks that
// answer a question. The only code that touches the vector column.
import { randomUUID } from "node:crypto";
import { AIProviderError, EMBEDDING_DIMENSIONS, type EmbeddingProvider } from "@workforce/ai-provider";
import { Prisma, prisma } from "@workforce/database";
import type { KnowledgeKind, KnowledgeMatch } from "@workforce/shared";
import { chunkSections } from "./chunk.ts";
import { parseDocument } from "./parse.ts";

export { chunkSections } from "./chunk.ts";
export { parseDocument } from "./parse.ts";

const EMBED_BATCH = 64;
const INSERT_BATCH = 50;

/** pgvector's text form of a vector. */
const literal = (vector: number[]) => `[${vector.join(",")}]`;

async function embedAll(embedder: EmbeddingProvider, texts: string[], signal?: AbortSignal) {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH)
    vectors.push(...(await embedder.embed(texts.slice(i, i + EMBED_BATCH), signal)));
  const wrong = vectors.find((v) => v.length !== EMBEDDING_DIMENSIONS);
  if (wrong)
    throw new AIProviderError(
      "config",
      `${embedder.model} produces ${wrong.length}-dimension vectors; the database stores ${EMBEDDING_DIMENSIONS}`,
    );
  return vectors;
}

/** A reason a person can act on, for the document's status. Details go to the caller's log. */
const reason = (err: unknown) =>
  err instanceof EmptyDocument
    ? err.message
    : err instanceof AIProviderError
      ? `The embedding provider failed (${err.kind}). Check the server's AI settings, then reprocess.`
      : "This file could not be read. Check that it is a valid, text-based file of its type.";

class EmptyDocument extends Error {}

/**
 * Parses, chunks and embeds one document, replacing whatever was stored for it before, and
 * records READY or FAILED on the document. Never throws: the outcome is the document's status.
 */
export async function processDocument(
  documentId: string,
  embedder: EmbeddingProvider,
  onError: (err: unknown) => void = () => {},
) {
  try {
    const doc = await prisma.knowledgeDocument.update({
      where: { id: documentId },
      data: { status: "PROCESSING", error: null },
    });
    try {
      const chunks = chunkSections(await parseDocument(doc.kind as KnowledgeKind, doc.content)).map((chunk, index) => ({
        ...chunk,
        index,
        id: randomUUID(),
      }));
      if (chunks.length === 0)
        throw new EmptyDocument("No text was found in this file. Scanned or image-only documents cannot be read yet.");
      const vectors = await embedAll(
        embedder,
        chunks.map((c) => c.content),
      );

      const embeddingRows = chunks.map((c, i) => Prisma.sql`(${c.id}, ${embedder.model}, ${literal(vectors[i] ?? [])}::vector)`);
      const inserts = [];
      for (let i = 0; i < embeddingRows.length; i += INSERT_BATCH)
        inserts.push(
          prisma.$executeRaw`INSERT INTO "Embedding" ("chunkId", "model", "vector") VALUES ${Prisma.join(embeddingRows.slice(i, i + INSERT_BATCH))}`,
        );
      // One transaction, so a search never sees a half-replaced document.
      await prisma.$transaction([
        prisma.knowledgeChunk.deleteMany({ where: { documentId } }),
        prisma.knowledgeChunk.createMany({
          data: chunks.map((c) => ({
            ...c,
            documentId,
            organizationId: doc.organizationId,
            workspaceId: doc.workspaceId,
            sourceId: doc.sourceId,
          })),
        }),
        ...inserts,
        prisma.knowledgeDocument.update({
          where: { id: documentId },
          data: { status: "READY", chunkCount: chunks.length, processedAt: new Date() },
        }),
      ]);
    } catch (err) {
      onError(err);
      await prisma.knowledgeDocument.update({ where: { id: documentId }, data: { status: "FAILED", error: reason(err) } });
    }
  } catch (err) {
    // The document was deleted while it was being processed: nothing left to record.
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025")) onError(err);
  }
}

export type RetrieveInput = {
  /** Tenant scope, from the verified session. Chunks outside it are never returned. */
  organizationId: string;
  workspaceId: string;
  sourceIds: string[];
  query: string;
  embedder: EmbeddingProvider;
  limit?: number;
  signal?: AbortSignal;
};

/** The chunks closest in meaning to `query`, best first. */
export async function retrieve(input: RetrieveInput): Promise<KnowledgeMatch[]> {
  const { organizationId, workspaceId, sourceIds, embedder } = input;
  if (sourceIds.length === 0) return [];
  const [vector] = await embedAll(embedder, [input.query], input.signal);
  const query = literal(vector ?? []);
  // shortcut: every match is returned however weak; add a score floor once real usage shows a sensible one
  return prisma.$queryRaw<KnowledgeMatch[]>`
    SELECT c."id" AS "chunkId", c."content", c."page", (1 - (e."vector" <=> ${query}::vector))::float8 AS "score",
           d."id" AS "documentId", d."name" AS "documentName", s."id" AS "sourceId", s."name" AS "sourceName"
    FROM "Embedding" e
    JOIN "KnowledgeChunk" c ON c."id" = e."chunkId"
    JOIN "KnowledgeDocument" d ON d."id" = c."documentId"
    JOIN "KnowledgeSource" s ON s."id" = c."sourceId"
    WHERE c."organizationId" = ${organizationId}
      AND c."workspaceId" = ${workspaceId}
      AND c."sourceId" = ANY(${sourceIds})
      -- Vectors from another model are not comparable.
      AND e."model" = ${embedder.model}
    ORDER BY e."vector" <=> ${query}::vector
    LIMIT ${input.limit ?? 5}`;
}
