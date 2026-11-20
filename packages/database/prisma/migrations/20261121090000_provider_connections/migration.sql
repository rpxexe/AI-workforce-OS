-- DropForeignKey
ALTER TABLE "AiCredential" DROP CONSTRAINT "AiCredential_organizationId_fkey";

-- AlterTable
ALTER TABLE "AIEmployee" ADD COLUMN     "providerOverrides" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "AiUsage" ADD COLUMN     "characters" INTEGER,
ADD COLUMN     "employeeId" TEXT,
ADD COLUMN     "operation" TEXT,
ADD COLUMN     "providerType" TEXT NOT NULL DEFAULT 'llm',
ADD COLUMN     "seconds" DOUBLE PRECISION,
ADD COLUMN     "workflowId" TEXT;

-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "connectionId" TEXT,
ADD COLUMN     "workflowId" TEXT;

-- AlterTable
ALTER TABLE "KnowledgeDocument" ADD COLUMN     "storageConnectionId" TEXT,
ADD COLUMN     "storageKey" TEXT,
ALTER COLUMN "content" DROP NOT NULL;

-- AlterTable
ALTER TABLE "PhoneNumber" ADD COLUMN     "connectionId" TEXT;

-- AlterTable
ALTER TABLE "Workflow" ADD COLUMN     "providerOverrides" JSONB NOT NULL DEFAULT '{}';


-- CreateTable
CREATE TABLE "ProviderConnection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "providerType" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "encryptedCredentials" TEXT NOT NULL,
    "credentialHints" JSONB NOT NULL DEFAULT '{}',
    "configuration" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'active',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "lastTestedAt" TIMESTAMP(3),
    "lastTestStatus" TEXT,
    "lastTestError" TEXT,
    "rotatedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderAuditLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectionId" TEXT,
    "providerType" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProviderConnection_organizationId_providerType_idx" ON "ProviderConnection"("organizationId", "providerType");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderConnection_organizationId_displayName_key" ON "ProviderConnection"("organizationId", "displayName");

-- CreateIndex
CREATE INDEX "ProviderAuditLog_organizationId_createdAt_idx" ON "ProviderAuditLog"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "AiUsage_organizationId_providerType_createdAt_idx" ON "AiUsage"("organizationId", "providerType", "createdAt");

-- AddForeignKey
ALTER TABLE "ProviderConnection" ADD CONSTRAINT "ProviderConnection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderAuditLog" ADD CONSTRAINT "ProviderAuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Phase 13 keys become "llm" connections with the same ids, so model policies (credentialId) and usage rows keep
-- pointing at them. The sealed key moves as it is (format v1 = a bare API key; new connections seal JSON as v2).
INSERT INTO "ProviderConnection" ("id", "organizationId", "providerType", "providerId", "displayName", "encryptedCredentials",
  "credentialHints", "configuration", "status", "isDefault", "createdBy", "createdAt", "updatedAt")
SELECT "id", "organizationId", 'llm', "kind", "name", "secret",
  jsonb_build_object('apiKey', "keyHint"),
  CASE WHEN "baseUrl" IS NULL THEN jsonb_build_object('models', "models")
       ELSE jsonb_build_object('models', "models", 'baseUrl', "baseUrl") END,
  'active', false, "createdBy", "createdAt", "updatedAt"
FROM "AiCredential";

-- DropTable
DROP TABLE "AiCredential";
