-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "ChannelMessageStatus" AS ENUM ('RECEIVED', 'ANSWERED', 'REJECTED', 'PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateTable
CREATE TABLE "EmployeeChannel" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL,
    "allowedTools" JSONB,
    "secret" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelMessage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "channelId" TEXT,
    "channel" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "status" "ChannelMessageStatus" NOT NULL,
    "customerId" TEXT,
    "conversationId" TEXT,
    "providerMessageId" TEXT,
    "from" TEXT,
    "to" TEXT,
    "text" TEXT NOT NULL,
    "media" JSONB,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmployeeChannel_organizationId_workspaceId_idx" ON "EmployeeChannel"("organizationId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeChannel_kind_address_key" ON "EmployeeChannel"("kind", "address");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeChannel_employeeId_kind_key" ON "EmployeeChannel"("employeeId", "kind");

-- CreateIndex
CREATE INDEX "ChannelMessage_organizationId_workspaceId_createdAt_idx" ON "ChannelMessage"("organizationId", "workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "ChannelMessage_conversationId_idx" ON "ChannelMessage"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelMessage_channel_direction_providerMessageId_key" ON "ChannelMessage"("channel", "direction", "providerMessageId");

-- AddForeignKey
ALTER TABLE "EmployeeChannel" ADD CONSTRAINT "EmployeeChannel_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeChannel" ADD CONSTRAINT "EmployeeChannel_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "AIEmployee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelMessage" ADD CONSTRAINT "ChannelMessage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
