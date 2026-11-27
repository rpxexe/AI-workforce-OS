-- Alone in its file: CONCURRENTLY cannot run inside a transaction, and one statement is sent as one.
-- Builds without blocking webhook delivery writes on a large production table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "WebhookDelivery_endpointId_createdAt_idx" ON "WebhookDelivery"("endpointId", "createdAt");
