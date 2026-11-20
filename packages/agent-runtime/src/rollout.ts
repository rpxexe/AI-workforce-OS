// Which employee version answers a customer while a rollout (A/B test) runs. Every channel that serves the
// published version asks here, so a rollout reaches calls, WhatsApp, email, web chat and workflows alike.
import { createHash } from "node:crypto";
import type { Prisma } from "@workforce/database";

/** Include on an employee query: the active rollout and its candidate version. */
export const ROLLOUT_INCLUDE = {
  activeRollout: { select: { id: true, percent: true, candidateVersion: true } },
} satisfies Prisma.AiEmployeeInclude;

/**
 * Which of 100 buckets a customer is in for one rollout. Stable, so a customer keeps their version across
 * messages and channels, and raising the share keeps everyone who already had the candidate.
 */
export const rolloutBucket = (rolloutId: string, key: string) => createHash("sha256").update(`${rolloutId}:${key}`).digest().readUInt32BE(0) % 100;

/**
 * The version that answers: the rollout's candidate for its share of customers, else the published version.
 * `key` is the customer's identity (phone number, email, visitor id); without one the published version answers.
 */
export function servedVersion<V>(published: V, rollout: { id: string; percent: number; candidateVersion: V } | null | undefined, key: string | undefined): V {
  if (!rollout || !key) return published;
  return rolloutBucket(rollout.id, key) < rollout.percent ? rollout.candidateVersion : published;
}
