-- Replaced by (organizationId, workspaceId, sourceId, createdAt), which serves the same lookups. Alone in its file
-- for CONCURRENTLY: no lock on document writes while it is dropped.
DROP INDEX CONCURRENTLY IF EXISTS "KnowledgeDocument_organizationId_workspaceId_sourceId_idx";
