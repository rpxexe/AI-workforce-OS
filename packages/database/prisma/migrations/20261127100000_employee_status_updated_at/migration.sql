-- Alone in its file: CONCURRENTLY cannot run inside a transaction, and one statement is sent as one.
-- The Archived tab pages newest change first without sorting every archived employee.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AIEmployee_organizationId_workspaceId_status_updatedAt_idx" ON "AIEmployee"("organizationId", "workspaceId", "status", "updatedAt");
