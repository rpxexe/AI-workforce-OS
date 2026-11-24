import { randomUUID } from "node:crypto";
import type { EmbeddingProvider } from "@workforce/ai-provider";
import { Prisma, prisma } from "@workforce/database";
import { retrieve } from "@workforce/knowledge";
import {
  MAX_UPLOAD_BYTES,
  employeeKnowledgeSchema,
  knowledgeKindOf,
  knowledgeSearchSchema,
  knowledgeSourceSchema,
  uploadQuerySchema,
  type KnowledgeDocument,
  type KnowledgeKind,
  type KnowledgeMatch,
  type KnowledgeSource,
  type KnowledgeSourceDetail,
  type UsageLimiter,
} from "@workforce/shared";
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { guards, httpError, type Authenticate } from "./auth.ts";
import { employeeParams, within } from "./employees.ts";
import type { ProviderService } from "./providers/service.ts";

const id = z.string().min(1);
const workspaceParams = z.object({ workspaceId: id });
const sourceParams = workspaceParams.extend({ sourceId: id });
const documentParams = workspaceParams.extend({ documentId: id });

// Never select `content` (the file's bytes) for a listing.
const documentSelect = {
  id: true,
  name: true,
  kind: true,
  sizeBytes: true,
  status: true,
  error: true,
  chunkCount: true,
  createdAt: true,
} satisfies Prisma.KnowledgeDocumentSelect;

const toDocument = (d: Prisma.KnowledgeDocumentGetPayload<{ select: typeof documentSelect }>): KnowledgeDocument => ({
  ...d,
  kind: d.kind as KnowledgeKind,
  createdAt: d.createdAt.toISOString(),
});

const sourceInclude = { _count: { select: { documents: true } } } satisfies Prisma.KnowledgeSourceInclude;
const toSource = (s: Prisma.KnowledgeSourceGetPayload<{ include: typeof sourceInclude }>): KnowledgeSource => ({
  id: s.id,
  name: s.name,
  description: s.description,
  documentCount: s._count.documents,
  updatedAt: s.updatedAt.toISOString(),
});

/**
 * Knowledge sources, their documents, search, and which sources an employee answers from.
 * Every query is scoped to the caller's organization and workspace; anything else is a 404.
 */
export function knowledgeRoutes(
  app: FastifyInstance,
  authenticate: Authenticate,
  getEmbedder: () => EmbeddingProvider,
  /** Queues processing of a document (the knowledge/document.uploaded job). */
  queueProcessing: (documentId: string) => Promise<void>,
  /** Phase 14: the organization's default object storage, where new uploads go instead of Postgres when there is one. */
  files?: Pick<ProviderService, "storage" | "storageById">,
  /** Plan limits (Phase 16): knowledge storage. */
  planLimits?: UsageLimiter,
) {
  const { member, admin, inWorkspace } = guards(authenticate);
  const base = "/workspaces/:workspaceId/knowledge";
  /** Removes a deleted document's file from object storage; a failure leaves an orphan object, logged, never a failed delete. */
  const removeStored = (req: FastifyRequest, organizationId: string, doc: { storageConnectionId: string | null; storageKey: string | null }) => {
    if (!files || !doc.storageConnectionId || !doc.storageKey) return;
    const key = doc.storageKey;
    files
      .storageById(organizationId, doc.storageConnectionId)
      .then((storage) => storage.delete(key))
      .catch((err: unknown) => req.log.warn({ err, key }, "Removing a stored file failed"));
  };

  /** 503 with a plain message when the embedding provider is misconfigured; details go to the log. */
  const embedder = (log: FastifyBaseLogger) => {
    try {
      return getEmbedder();
    } catch (err) {
      log.error(err, "Embedding provider is misconfigured");
      throw httpError(503, "The embedding provider is not configured correctly on the server.");
    }
  };

  // Checked here so a misconfigured embedder is a 503 now, not a FAILED document later. Processing is a background job.
  const startProcessing = (req: FastifyRequest, documentId: string) => {
    embedder(req.log);
    queueProcessing(documentId).catch((err: unknown) => req.log.error({ err, documentId }, "Queueing document processing failed"));
  };

  app.get(`${base}/sources`, async (req): Promise<KnowledgeSource[]> => {
    const scope = await inWorkspace(member(req), workspaceParams.parse(req.params).workspaceId);
    const sources = await prisma.knowledgeSource.findMany({
      where: within(scope),
      orderBy: { name: "asc" },
      include: sourceInclude,
    });
    return sources.map(toSource);
  });

  app.post(`${base}/sources`, async (req, reply) => {
    const scope = await inWorkspace(admin(req), workspaceParams.parse(req.params).workspaceId);
    const data = knowledgeSourceSchema.parse(req.body);
    try {
      const source = await prisma.knowledgeSource.create({
        data: { ...data, ...within(scope), createdBy: scope.userId },
        include: sourceInclude,
      });
      return reply.code(201).send(toSource(source));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")
        throw httpError(409, "A knowledge source with this name already exists");
      throw err;
    }
  });

  app.get(`${base}/sources/:sourceId`, async (req): Promise<KnowledgeSourceDetail> => {
    const { workspaceId, sourceId } = sourceParams.parse(req.params);
    const scope = await inWorkspace(member(req), workspaceId);
    const source = await prisma.knowledgeSource.findFirst({
      where: { id: sourceId, ...within(scope) },
      include: { ...sourceInclude, documents: { select: documentSelect, orderBy: { createdAt: "desc" } } },
    });
    if (!source) throw httpError(404, "Knowledge source not found");
    return { ...toSource(source), documents: source.documents.map(toDocument) };
  });

  // Deleting a source removes its documents, chunks and embeddings, and detaches it from employees.
  app.delete(`${base}/sources/:sourceId`, async (req, reply) => {
    const { workspaceId, sourceId } = sourceParams.parse(req.params);
    const scope = await inWorkspace(admin(req), workspaceId);
    const stored = await prisma.knowledgeDocument.findMany({ where: { sourceId, ...within(scope), storageKey: { not: null } }, select: { storageConnectionId: true, storageKey: true } });
    const { count } = await prisma.knowledgeSource.deleteMany({ where: { id: sourceId, ...within(scope) } });
    if (count === 0) throw httpError(404, "Knowledge source not found");
    for (const doc of stored) removeStored(req, scope.organizationId, doc);
    return reply.code(204).send();
  });

  // The file is the request body (application/octet-stream); its name is in the query string.
  void app.register(async (upload) => {
    upload.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer", bodyLimit: MAX_UPLOAD_BYTES },
      (_req, body, done) => done(null, body),
    );
    upload.post(`${base}/sources/:sourceId/documents`, async (req, reply) => {
      const { workspaceId, sourceId } = sourceParams.parse(req.params);
      const scope = await inWorkspace(admin(req), workspaceId);
      const { name } = uploadQuerySchema.parse(req.query);
      const kind = knowledgeKindOf(name);
      if (!kind || !Buffer.isBuffer(req.body) || req.body.length === 0)
        throw httpError(400, "Send a non-empty PDF, DOCX, TXT or CSV file as the request body");
      const source = await prisma.knowledgeSource.findFirst({ where: { id: sourceId, ...within(scope) }, select: { id: true } });
      if (!source) throw httpError(404, "Knowledge source not found");
      embedder(req.log); // refuse the upload now rather than fail the document later
      const refused = await planLimits?.(scope.organizationId, ["storageMb"], { storageMb: req.body.length / 1_048_576 });
      if (refused) throw httpError(402, refused);

      // With object storage the file goes there first; a row is only written for a file that was stored.
      const storage = files ? await files.storage(scope.organizationId) : null;
      let stored: { storageConnectionId: string; storageKey: string } | null = null;
      if (storage) {
        const storageKey = `knowledge/${scope.workspaceId}/${randomUUID()}/${name.replace(/[^\w.-]+/g, "_")}`;
        try {
          await storage.storage.put(storageKey, req.body, "application/octet-stream");
        } catch (err) {
          req.log.error({ err }, "Storing an upload failed");
          throw httpError(502, `The file could not be stored in ${storage.storage.name}: ${err instanceof Error ? err.message : "unknown error"}`);
        }
        stored = { storageConnectionId: storage.connectionId, storageKey };
      }
      const document = await prisma.knowledgeDocument.create({
        data: {
          ...within(scope),
          sourceId,
          name,
          kind,
          sizeBytes: req.body.length,
          ...(stored ?? { content: new Uint8Array(req.body) }),
          createdBy: scope.userId,
        },
        select: documentSelect,
      });
      startProcessing(req, document.id);
      return reply.code(201).send(toDocument(document));
    });
  });

  app.delete(`${base}/documents/:documentId`, async (req, reply) => {
    const { workspaceId, documentId } = documentParams.parse(req.params);
    const scope = await inWorkspace(admin(req), workspaceId);
    const doc = await prisma.knowledgeDocument.findFirst({ where: { id: documentId, ...within(scope) }, select: { storageConnectionId: true, storageKey: true } });
    const { count } = await prisma.knowledgeDocument.deleteMany({ where: { id: documentId, ...within(scope) } });
    if (count === 0 || !doc) throw httpError(404, "Document not found");
    removeStored(req, scope.organizationId, doc);
    return reply.code(204).send();
  });

  // Parses, chunks and embeds the stored file again: after a failure, or a change of embedding model.
  app.post(`${base}/documents/:documentId/reprocess`, async (req): Promise<KnowledgeDocument> => {
    const { workspaceId, documentId } = documentParams.parse(req.params);
    const scope = await inWorkspace(admin(req), workspaceId);
    embedder(req.log);
    const { count } = await prisma.knowledgeDocument.updateMany({
      where: { id: documentId, ...within(scope) },
      data: { status: "PENDING", error: null },
    });
    if (count === 0) throw httpError(404, "Document not found");
    startProcessing(req, documentId);
    return toDocument(await prisma.knowledgeDocument.findUniqueOrThrow({ where: { id: documentId }, select: documentSelect }));
  });

  app.post(`${base}/search`, async (req): Promise<KnowledgeMatch[]> => {
    const scope = await inWorkspace(member(req), workspaceParams.parse(req.params).workspaceId);
    const { query, sourceIds } = knowledgeSearchSchema.parse(req.body);
    // Ids are only a filter: `retrieve` still limits results to this organization and workspace.
    const sources = await prisma.knowledgeSource.findMany({
      where: { ...within(scope), ...(sourceIds && { id: { in: sourceIds } }) },
      select: { id: true },
    });
    return retrieve({ ...within(scope), sourceIds: sources.map((s) => s.id), query, embedder: embedder(req.log), limit: 8 });
  });

  // ---- Which sources an employee answers from ----

  const attached = async (employeeId: string) => {
    const rows = await prisma.employeeKnowledgeSource.findMany({
      where: { employeeId },
      orderBy: { source: { name: "asc" } },
      include: { source: { include: sourceInclude } },
    });
    return rows.map((r) => toSource(r.source));
  };

  const employeeBase = "/workspaces/:workspaceId/employees/:id/knowledge";

  app.get(employeeBase, async (req): Promise<KnowledgeSource[]> => {
    const params = employeeParams.parse(req.params);
    const scope = await inWorkspace(member(req), params.workspaceId);
    const employee = await prisma.aiEmployee.findFirst({ where: { id: params.id, ...within(scope) }, select: { id: true } });
    if (!employee) throw httpError(404, "Employee not found");
    return attached(employee.id);
  });

  // Replaces the whole set, so attach and detach are the same call.
  app.put(employeeBase, async (req): Promise<KnowledgeSource[]> => {
    const params = employeeParams.parse(req.params);
    const scope = await inWorkspace(admin(req), params.workspaceId);
    const sourceIds = [...new Set(employeeKnowledgeSchema.parse(req.body).sourceIds)];
    const employee = await prisma.aiEmployee.findFirst({ where: { id: params.id, ...within(scope) }, select: { id: true } });
    if (!employee) throw httpError(404, "Employee not found");
    // A source from another workspace or organization does not exist as far as this caller can tell.
    const found = await prisma.knowledgeSource.count({ where: { id: { in: sourceIds }, ...within(scope) } });
    if (found !== sourceIds.length) throw httpError(404, "Knowledge source not found");
    await prisma.$transaction([
      prisma.employeeKnowledgeSource.deleteMany({ where: { employeeId: employee.id, sourceId: { notIn: sourceIds } } }),
      prisma.employeeKnowledgeSource.createMany({
        data: sourceIds.map((sourceId) => ({ employeeId: employee.id, sourceId })),
        skipDuplicates: true,
      }),
    ]);
    return attached(employee.id);
  });
}
