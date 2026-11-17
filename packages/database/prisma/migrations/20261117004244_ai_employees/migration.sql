-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "AIEmployee" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedVersionId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AIEmployee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIEmployeeVersion" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "personality" TEXT NOT NULL,
    "systemInstructions" TEXT NOT NULL,
    "goals" TEXT[],
    "language" TEXT NOT NULL,
    "avatar" TEXT NOT NULL,
    "workingHours" JSONB NOT NULL,
    "escalation" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIEmployeeVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AIEmployee_publishedVersionId_key" ON "AIEmployee"("publishedVersionId");

-- CreateIndex
CREATE INDEX "AIEmployee_organizationId_workspaceId_status_idx" ON "AIEmployee"("organizationId", "workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AIEmployeeVersion_employeeId_number_key" ON "AIEmployeeVersion"("employeeId", "number");

-- AddForeignKey
ALTER TABLE "AIEmployee" ADD CONSTRAINT "AIEmployee_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIEmployee" ADD CONSTRAINT "AIEmployee_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIEmployee" ADD CONSTRAINT "AIEmployee_publishedVersionId_fkey" FOREIGN KEY ("publishedVersionId") REFERENCES "AIEmployeeVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIEmployeeVersion" ADD CONSTRAINT "AIEmployeeVersion_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "AIEmployee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
