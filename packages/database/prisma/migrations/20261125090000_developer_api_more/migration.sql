-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "allowedIps" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "rateLimitPerMinute" INTEGER NOT NULL DEFAULT 600;

-- AlterTable
ALTER TABLE "WebhookEndpoint" ADD COLUMN     "previousEncryptedSecret" TEXT,
ADD COLUMN     "previousSecretExpiresAt" TIMESTAMP(3),
ADD COLUMN     "scannedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DeveloperAuditLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeveloperAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeveloperAuditLog_organizationId_createdAt_idx" ON "DeveloperAuditLog"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "DeveloperAuditLog" ADD CONSTRAINT "DeveloperAuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

