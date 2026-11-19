/*
  Warnings:

  - You are about to drop the column `transferredTo` on the `Call` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "CallTransferStatus" AS ENUM ('INITIATED', 'COMPLETED', 'NO_ANSWER', 'BUSY', 'CANCELED', 'FAILED');

-- AlterTable
ALTER TABLE "Call" DROP COLUMN "transferredTo";

-- CreateTable
CREATE TABLE "CallTransfer" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "conversationId" TEXT,
    "handoffId" TEXT,
    "to" TEXT NOT NULL,
    "status" "CallTransferStatus" NOT NULL DEFAULT 'INITIATED',
    "error" TEXT,
    "talkSec" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "CallTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CallTransfer_callId_idx" ON "CallTransfer"("callId");

-- CreateIndex
CREATE INDEX "CallTransfer_conversationId_idx" ON "CallTransfer"("conversationId");

-- AddForeignKey
ALTER TABLE "CallTransfer" ADD CONSTRAINT "CallTransfer_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE CASCADE ON UPDATE CASCADE;
