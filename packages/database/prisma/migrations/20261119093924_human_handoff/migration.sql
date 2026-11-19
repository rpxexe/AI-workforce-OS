-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('AI_ACTIVE', 'WAITING_FOR_HUMAN', 'HUMAN_ACTIVE', 'RESOLVED', 'REOPENED');

-- AlterEnum
ALTER TYPE "ChannelMessageStatus" ADD VALUE 'HELD';

-- AlterEnum
ALTER TYPE "MessageRole" ADD VALUE 'AGENT';

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "assignedTo" TEXT,
ADD COLUMN     "failedTurns" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "status" "ConversationStatus" NOT NULL DEFAULT 'AI_ACTIVE';

-- AlterTable
ALTER TABLE "ConversationMessage" ADD COLUMN     "authorId" TEXT;

-- CreateTable
CREATE TABLE "Handoff" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "assignedTo" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "firstResponseAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "outcome" TEXT,

    CONSTRAINT "Handoff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopilotSuggestion" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "reply" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "nextAction" TEXT NOT NULL,
    "memory" JSONB NOT NULL,
    "citations" JSONB NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "usedInMessageId" TEXT,
    "edited" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CopilotSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Handoff_organizationId_workspaceId_requestedAt_idx" ON "Handoff"("organizationId", "workspaceId", "requestedAt");

-- CreateIndex
CREATE INDEX "Handoff_conversationId_endedAt_idx" ON "Handoff"("conversationId", "endedAt");

-- CreateIndex
CREATE INDEX "CopilotSuggestion_conversationId_createdAt_idx" ON "CopilotSuggestion"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "Conversation_organizationId_workspaceId_status_updatedAt_idx" ON "Conversation"("organizationId", "workspaceId", "status", "updatedAt");

-- AddForeignKey
ALTER TABLE "Handoff" ADD CONSTRAINT "Handoff_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopilotSuggestion" ADD CONSTRAINT "CopilotSuggestion_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
