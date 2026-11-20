// Changes to the live employee version, in one place: publish, rollback and a promoted rollout all move the
// pointer and write a release row, so "roll back to the previous version" always knows what that was.
import { prisma, type Prisma } from "@workforce/database";
import type { ReleaseAction } from "@workforce/shared";
import { httpError } from "./auth.ts";

type Scope = { organizationId: string; workspaceId: string };

/**
 * Refuses a publish that would bypass the improvement process: while a rollout runs (promote or roll it back
 * instead), or of a version proposed by an improvement suggestion that no person has approved.
 */
export async function assertPublishable(employeeId: string, versionId: string) {
  const [rollout, suggestion] = await Promise.all([
    prisma.employeeRollout.findUnique({ where: { activeEmployeeId: employeeId }, select: { id: true } }),
    prisma.improvementSuggestion.findUnique({ where: { proposedVersionId: versionId }, select: { approval: true } }),
  ]);
  if (rollout) throw httpError(409, "A rollout is running for this employee. Promote it or roll it back first.");
  if (suggestion && suggestion.approval !== "approved")
    throw httpError(409, "This version comes from an improvement suggestion that has not been approved. Approve it first.");
}

/** Moves the live pointer and writes its release row. Run inside a transaction (with the rollout's own update, when promoting). */
export async function release(db: Prisma.TransactionClient, input: {
  scope: Scope;
  employee: { id: string; status: string; publishedVersion: { number: number } | null };
  version: { id: string; number: number };
  action: ReleaseAction;
  by: string;
  rolloutId?: string;
}) {
  const { employee, version } = input;
  await db.aiEmployee.update({
    where: { id: employee.id },
    data: { publishedVersionId: version.id, ...(employee.status === "DRAFT" && { status: "ACTIVE" }) },
  });
  await db.employeeRelease.create({
    data: {
      organizationId: input.scope.organizationId,
      workspaceId: input.scope.workspaceId,
      employeeId: employee.id,
      action: input.action,
      version: version.number,
      previousVersion: employee.publishedVersion?.number ?? null,
      rolloutId: input.rolloutId,
      by: input.by,
    },
  });
}

/**
 * The version a rollback publishes: the one live before the current version was last published (or promoted).
 * Rollbacks themselves are skipped, so rolling back twice goes back two versions rather than forward again.
 */
export async function rollbackTarget(employeeId: string, current: number | null) {
  if (current === null) return null;
  const release = await prisma.employeeRelease.findFirst({
    where: { employeeId, version: current, action: { not: "rollback" } },
    orderBy: { createdAt: "desc" },
    select: { previousVersion: true },
  });
  return release?.previousVersion ?? null;
}
