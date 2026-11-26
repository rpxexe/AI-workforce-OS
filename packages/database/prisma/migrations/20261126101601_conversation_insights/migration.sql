-- CreateTable
CREATE TABLE "ConversationInsight" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "primaryLanguage" TEXT NOT NULL,
    "codeSwitchedMessages" INTEGER NOT NULL,
    "switches" INTEGER NOT NULL,
    "sentiment" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "entityTypes" TEXT[],
    "resolution" TEXT NOT NULL,
    "escalated" BOOLEAN NOT NULL,
    "escalationSignals" INTEGER NOT NULL,
    "activityAt" TIMESTAMP(3) NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationInsight_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConversationInsight_conversationId_key" ON "ConversationInsight"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationInsight_organizationId_workspaceId_conversation_key" ON "ConversationInsight"("organizationId", "workspaceId", "conversationId");

-- CreateIndex
CREATE INDEX "Conversation_organizationId_workspaceId_createdAt_idx" ON "Conversation"("organizationId", "workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "UsageEvent_organizationId_workspaceId_occurredAt_idx" ON "UsageEvent"("organizationId", "workspaceId", "occurredAt");

-- AddForeignKey
ALTER TABLE "ConversationInsight" ADD CONSTRAINT "ConversationInsight_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
