-- Alone in its file: CONCURRENTLY cannot run inside a transaction, and one statement is sent as one.
-- A source's documents page newest first without sorting every document of the source.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "KnowledgeDocument_organizationId_workspaceId_sourceId_creat_idx" ON "KnowledgeDocument"("organizationId", "workspaceId", "sourceId", "createdAt");
