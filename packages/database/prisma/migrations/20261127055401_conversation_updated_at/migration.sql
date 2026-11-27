-- Alone in its file: CONCURRENTLY cannot run inside a transaction, and one statement is sent as one.
-- Builds without blocking conversation writes on a large production table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Conversation_updatedAt_idx" ON "Conversation"("updatedAt");
