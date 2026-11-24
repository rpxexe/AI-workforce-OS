// The only code that runs a tool. Every call the model makes goes through `execute`:
//
//   registry lookup -> permission check -> input validation -> run (timeout, retries)
//   -> output validation -> audit row -> result for the model
//
// Nothing here throws for a bad call: the model gets an error result it can act on.
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { ToolCall, ToolResult } from "@workforce/ai-provider";
import { prisma, type Prisma } from "@workforce/database";
import type { ToolExecutionStatus, UsageLimiter } from "@workforce/shared";
import { safeFetch } from "./net.ts";
import type { ToolRegistry } from "./registry.ts";
import { ToolError, type Mailer } from "./types.ts";

/** Already authorized by the caller: the executor trusts these ids and filters on them. */
export type ToolScope = {
  organizationId: string;
  workspaceId: string;
  employeeId: string;
  conversationId: string;
  customerId?: string;
  timezone: string;
  /** The tools offered for this turn (a channel may allow fewer than are granted); others are denied. Omit to allow every granted tool. */
  allowedTools?: readonly string[];
  /** The audit row id, also the webhook idempotency key. Workflows pass a stable one so a step run twice is recognised. */
  executionId?: string;
};

export type ToolOutcome = { executionId: string; status: ToolExecutionStatus; result: ToolResult };

export interface ToolExecutor {
  execute(call: ToolCall, scope: ToolScope, signal: AbortSignal): Promise<ToolOutcome>;
}

/** Stops waiting when `signal` aborts, even if the tool ignores it. */
const abortable = <T>(work: Promise<T>, signal: AbortSignal) =>
  new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    work.then(resolve, reject);
  });

/**
 * `fetch` is the network access tools get (tests pass a fake). `onError` hears about failures
 * that are bugs rather than expected tool errors; the model only sees "the tool failed".
 */
export function createToolExecutor(
  registry: ToolRegistry,
  options: {
    fetch?: typeof fetch;
    mailer?: Mailer;
    onError?: (err: unknown, tool: string) => void;
    /** Plan limits (Phase 16): a tool call over the plan's limit is DENIED, and DENIED calls are not billed. */
    planLimits?: UsageLimiter;
  } = {},
): ToolExecutor {
  const fetchForTools = options.fetch ?? safeFetch;

  return {
    async execute(call, scope, signal) {
      const executionId = scope.executionId ?? randomUUID();
      const startedAt = Date.now();
      let attempts = 0;

      const finish = async (status: ToolExecutionStatus, outcome: { output: unknown } | { error: string }) => {
        await prisma.toolExecution.create({
          data: {
            id: executionId,
            organizationId: scope.organizationId,
            workspaceId: scope.workspaceId,
            employeeId: scope.employeeId,
            conversationId: scope.conversationId,
            customerId: scope.customerId,
            tool: call.name.slice(0, 100),
            status,
            input: (call.input ?? null) as Prisma.InputJsonValue,
            ...("output" in outcome ? { output: outcome.output as Prisma.InputJsonValue } : { error: outcome.error }),
            attempts,
            durationMs: Date.now() - startedAt,
          },
        });
        const ok = "output" in outcome;
        return {
          executionId,
          status,
          result: { callId: call.id, content: JSON.stringify(ok ? outcome.output : { error: outcome.error }), isError: !ok },
        };
      };

      const tool = registry.get(call.name);
      if (!tool) return finish("DENIED", { error: `There is no tool named "${call.name}".` });
      if (scope.allowedTools && !scope.allowedTools.includes(tool.name))
        return finish("DENIED", { error: `${tool.name} is not available in this conversation.` });

      // Checked on every call, against the database, so a revoked grant stops the next call.
      const grant = await prisma.toolPermission.findFirst({
        where: {
          employeeId: scope.employeeId,
          tool: tool.name,
          employee: { organizationId: scope.organizationId, workspaceId: scope.workspaceId },
        },
      });
      if (!grant || !tool.permissions.every((p) => grant.permissions.includes(p)))
        return finish("DENIED", { error: `You are not permitted to use ${tool.name}.` });
      const config = tool.config.safeParse(grant.config);
      if (!config.success)
        return finish("FAILED", { error: `${tool.name} is not set up correctly. An admin needs to fix its settings.` });

      const refused = await options.planLimits?.(scope.organizationId, ["toolCalls"]);
      if (refused) return finish("DENIED", { error: refused });

      const input = tool.input.safeParse(call.input);
      if (!input.success) {
        const issues = input.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
        return finish("INVALID", { error: `Invalid input, nothing was done. ${issues}` });
      }

      let error = `${tool.name} failed.`;
      for (attempts = 1; attempts <= tool.retry.attempts; attempts++) {
        const timeout = AbortSignal.timeout(tool.timeoutMs);
        const callSignal = AbortSignal.any([timeout, signal]);
        try {
          const output = await abortable(
            tool.execute(input.data, { ...scope, executionId, config: config.data, signal: callSignal, fetch: fetchForTools, mailer: options.mailer }),
            callSignal,
          );
          const checked = tool.output.safeParse(output);
          if (checked.success) return await finish("SUCCEEDED", { output: checked.data });
          options.onError?.(checked.error, tool.name);
          error = `${tool.name} returned an unexpected result.`;
          break;
        } catch (err) {
          if (signal.aborted) {
            error = "Cancelled: the conversation ended.";
            break;
          }
          // Timeouts are not retried: the first try may still have acted.
          if (timeout.aborted) {
            error = `${tool.name} timed out after ${tool.timeoutMs / 1000} seconds.`;
            break;
          }
          if (!(err instanceof ToolError)) {
            options.onError?.(err, tool.name);
            break;
          }
          error = err.message;
          if (!err.retryable || attempts === tool.retry.attempts) break;
          await sleep(tool.retry.backoffMs * attempts, undefined, { signal }).catch(() => {});
        }
      }
      return finish("FAILED", { error });
    },
  };
}
