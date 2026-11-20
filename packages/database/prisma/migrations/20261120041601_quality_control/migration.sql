-- CreateEnum
CREATE TYPE "EvaluationStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "Evaluator" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "key" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "currentVersionId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Evaluator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvaluatorVersion" (
    "id" TEXT NOT NULL,
    "evaluatorId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "passScore" INTEGER NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvaluatorVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evaluation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "employeeVersionId" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "workflowVersionId" TEXT,
    "trigger" TEXT NOT NULL,
    "autoKey" TEXT,
    "datasetRunId" TEXT,
    "caseId" TEXT,
    "status" "EvaluationStatus" NOT NULL DEFAULT 'PENDING',
    "score" DOUBLE PRECISION,
    "passed" BOOLEAN,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "messageCount" INTEGER NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "error" TEXT,
    "requestedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Evaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvaluationResult" (
    "id" TEXT NOT NULL,
    "evaluationId" TEXT NOT NULL,
    "evaluatorId" TEXT NOT NULL,
    "evaluatorVersionId" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "score" INTEGER,
    "passed" BOOLEAN,
    "reason" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvaluationResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvalDataset" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvalDataset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvalCase" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "conversationId" TEXT,
    "messages" JSONB NOT NULL,
    "expectations" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvalCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvalRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "employeeVersionId" TEXT NOT NULL,
    "status" "EvaluationStatus" NOT NULL DEFAULT 'PENDING',
    "score" DOUBLE PRECISION,
    "total" INTEGER NOT NULL,
    "passed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "EvalRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Evaluator_currentVersionId_key" ON "Evaluator"("currentVersionId");

-- CreateIndex
CREATE INDEX "Evaluator_organizationId_workspaceId_idx" ON "Evaluator"("organizationId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Evaluator_workspaceId_key_key" ON "Evaluator"("workspaceId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "EvaluatorVersion_evaluatorId_number_key" ON "EvaluatorVersion"("evaluatorId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Evaluation_autoKey_key" ON "Evaluation"("autoKey");

-- CreateIndex
CREATE INDEX "Evaluation_organizationId_workspaceId_createdAt_idx" ON "Evaluation"("organizationId", "workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "Evaluation_conversationId_createdAt_idx" ON "Evaluation"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "Evaluation_datasetRunId_idx" ON "Evaluation"("datasetRunId");

-- CreateIndex
CREATE INDEX "EvaluationResult_evaluationId_idx" ON "EvaluationResult"("evaluationId");

-- CreateIndex
CREATE INDEX "EvaluationResult_evaluatorId_createdAt_idx" ON "EvaluationResult"("evaluatorId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EvalDataset_workspaceId_name_key" ON "EvalDataset"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "EvalCase_datasetId_idx" ON "EvalCase"("datasetId");

-- CreateIndex
CREATE INDEX "EvalRun_datasetId_createdAt_idx" ON "EvalRun"("datasetId", "createdAt");

-- AddForeignKey
ALTER TABLE "Evaluator" ADD CONSTRAINT "Evaluator_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evaluator" ADD CONSTRAINT "Evaluator_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "EvaluatorVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluatorVersion" ADD CONSTRAINT "EvaluatorVersion_evaluatorId_fkey" FOREIGN KEY ("evaluatorId") REFERENCES "Evaluator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evaluation" ADD CONSTRAINT "Evaluation_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evaluation" ADD CONSTRAINT "Evaluation_employeeVersionId_fkey" FOREIGN KEY ("employeeVersionId") REFERENCES "AIEmployeeVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evaluation" ADD CONSTRAINT "Evaluation_workflowVersionId_fkey" FOREIGN KEY ("workflowVersionId") REFERENCES "WorkflowVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evaluation" ADD CONSTRAINT "Evaluation_datasetRunId_fkey" FOREIGN KEY ("datasetRunId") REFERENCES "EvalRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationResult" ADD CONSTRAINT "EvaluationResult_evaluationId_fkey" FOREIGN KEY ("evaluationId") REFERENCES "Evaluation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationResult" ADD CONSTRAINT "EvaluationResult_evaluatorId_fkey" FOREIGN KEY ("evaluatorId") REFERENCES "Evaluator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationResult" ADD CONSTRAINT "EvaluationResult_evaluatorVersionId_fkey" FOREIGN KEY ("evaluatorVersionId") REFERENCES "EvaluatorVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvalDataset" ADD CONSTRAINT "EvalDataset_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvalCase" ADD CONSTRAINT "EvalCase_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "EvalDataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvalRun" ADD CONSTRAINT "EvalRun_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "EvalDataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvalRun" ADD CONSTRAINT "EvalRun_employeeVersionId_fkey" FOREIGN KEY ("employeeVersionId") REFERENCES "AIEmployeeVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
