-- Alone in its file: CONCURRENTLY cannot run inside a transaction, and one statement is sent as one.
-- The inbox's All view pages newest first without sorting the whole workspace (11 ms at 11k rows, growing; 0.2 ms with it).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Conversation_organizationId_workspaceId_updatedAt_idx" ON "Conversation"("organizationId", "workspaceId", "updatedAt");
