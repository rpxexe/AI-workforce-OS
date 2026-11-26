-- The conversation's tenant on every message, backfilled from the conversation.
ALTER TABLE "ConversationMessage" ADD COLUMN "organizationId" TEXT,
ADD COLUMN "workspaceId" TEXT;

UPDATE "ConversationMessage" m SET "organizationId" = c."organizationId", "workspaceId" = c."workspaceId"
FROM "Conversation" c WHERE c.id = m."conversationId";

ALTER TABLE "ConversationMessage" ALTER COLUMN "organizationId" SET NOT NULL,
ALTER COLUMN "workspaceId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "ConversationMessage_tenant_createdAt_idx" ON "ConversationMessage"("organizationId", "workspaceId", "createdAt", "conversationId");
