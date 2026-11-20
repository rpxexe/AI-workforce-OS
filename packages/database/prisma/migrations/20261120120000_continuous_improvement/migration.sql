-- AlterTable
ALTER TABLE "EvalDataset" ADD COLUMN     "employeeId" TEXT;

-- CreateTable
CREATE TABLE "ImprovementSuggestion" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "baseVersionId" TEXT NOT NULL,
    "evaluatorId" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "change" JSONB NOT NULL,
    "kpi" TEXT NOT NULL,
    "proposedVersionId" TEXT,
    "baselineRunId" TEXT,
    "candidateRunId" TEXT,
    "approval" TEXT NOT NULL DEFAULT 'pending',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImprovementSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeRollout" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "activeEmployeeId" TEXT,
    "controlVersionId" TEXT NOT NULL,
    "candidateVersionId" TEXT NOT NULL,
    "suggestionId" TEXT,
    "percent" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "kpi" TEXT NOT NULL,
    "startedBy" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedBy" TEXT,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "EmployeeRollout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeRelease" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "previousVersion" INTEGER,
    "rolloutId" TEXT,
    "by" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeRelease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ImprovementSuggestion_proposedVersionId_key" ON "ImprovementSuggestion"("proposedVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "ImprovementSuggestion_baselineRunId_key" ON "ImprovementSuggestion"("baselineRunId");

-- CreateIndex
CREATE UNIQUE INDEX "ImprovementSuggestion_candidateRunId_key" ON "ImprovementSuggestion"("candidateRunId");

-- CreateIndex
CREATE INDEX "ImprovementSuggestion_organizationId_workspaceId_createdAt_idx" ON "ImprovementSuggestion"("organizationId", "workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ImprovementSuggestion_baseVersionId_evaluatorId_key" ON "ImprovementSuggestion"("baseVersionId", "evaluatorId");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeRollout_activeEmployeeId_key" ON "EmployeeRollout"("activeEmployeeId");

-- CreateIndex
CREATE INDEX "EmployeeRollout_employeeId_startedAt_idx" ON "EmployeeRollout"("employeeId", "startedAt");

-- CreateIndex
CREATE INDEX "EmployeeRelease_employeeId_createdAt_idx" ON "EmployeeRelease"("employeeId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EvalDataset_employeeId_key" ON "EvalDataset"("employeeId");

-- AddForeignKey
ALTER TABLE "EvalDataset" ADD CONSTRAINT "EvalDataset_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "AIEmployee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImprovementSuggestion" ADD CONSTRAINT "ImprovementSuggestion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImprovementSuggestion" ADD CONSTRAINT "ImprovementSuggestion_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "AIEmployee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImprovementSuggestion" ADD CONSTRAINT "ImprovementSuggestion_baseVersionId_fkey" FOREIGN KEY ("baseVersionId") REFERENCES "AIEmployeeVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImprovementSuggestion" ADD CONSTRAINT "ImprovementSuggestion_proposedVersionId_fkey" FOREIGN KEY ("proposedVersionId") REFERENCES "AIEmployeeVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImprovementSuggestion" ADD CONSTRAINT "ImprovementSuggestion_baselineRunId_fkey" FOREIGN KEY ("baselineRunId") REFERENCES "EvalRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImprovementSuggestion" ADD CONSTRAINT "ImprovementSuggestion_candidateRunId_fkey" FOREIGN KEY ("candidateRunId") REFERENCES "EvalRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeRollout" ADD CONSTRAINT "EmployeeRollout_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeRollout" ADD CONSTRAINT "EmployeeRollout_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "AIEmployee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeRollout" ADD CONSTRAINT "EmployeeRollout_activeEmployeeId_fkey" FOREIGN KEY ("activeEmployeeId") REFERENCES "AIEmployee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeRollout" ADD CONSTRAINT "EmployeeRollout_controlVersionId_fkey" FOREIGN KEY ("controlVersionId") REFERENCES "AIEmployeeVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeRollout" ADD CONSTRAINT "EmployeeRollout_candidateVersionId_fkey" FOREIGN KEY ("candidateVersionId") REFERENCES "AIEmployeeVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeRollout" ADD CONSTRAINT "EmployeeRollout_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "ImprovementSuggestion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeRelease" ADD CONSTRAINT "EmployeeRelease_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeRelease" ADD CONSTRAINT "EmployeeRelease_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "AIEmployee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

