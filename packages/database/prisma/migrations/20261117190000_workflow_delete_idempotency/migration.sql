-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "idempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "Workflow" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Call_idempotencyKey_key" ON "Call"("idempotencyKey");

