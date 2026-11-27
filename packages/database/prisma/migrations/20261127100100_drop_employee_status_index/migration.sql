-- Replaced by (organizationId, workspaceId, status, updatedAt), which serves the same lookups. Alone in its file
-- for CONCURRENTLY: no lock on employee writes while it is dropped.
DROP INDEX CONCURRENTLY IF EXISTS "AIEmployee_organizationId_workspaceId_status_idx";
