import type { ToolName } from "@workforce/shared";
import type { z } from "zod";

export type RetryPolicy = {
  /** Total tries, 1 = no retry. Only tools that are safe to repeat retry. */
  attempts: number;
  /** Wait before try n+1 is n × backoffMs. */
  backoffMs: number;
};

/** What a tool knows about the call. Everything here comes from the server, never from the model. */
export type ToolContext<Config> = {
  organizationId: string;
  workspaceId: string;
  employeeId: string;
  conversationId: string;
  customerId?: string;
  /** The employee's time zone (from its working hours), for anything said in local time. */
  timezone: string;
  /** Same on every retry of one call: use it as an idempotency key. */
  executionId: string;
  /** What the admin configured when granting the tool. */
  config: Config;
  /** Aborts on the tool's timeout or when the turn is abandoned. */
  signal: AbortSignal;
  /** The only way a tool reaches the network; refuses private addresses (see net.ts). */
  fetch: typeof fetch;
  /** Sends email through the organization's or the server's provider; absent or `testMode` when none is configured. */
  mailer?: Mailer;
};

/**
 * Sends one email through the provider that serves `scope` (Phase 14: workflow, employee, organization default, platform).
 * `testMode` when none is configured: nothing is delivered. Throws `ToolError` when the provider refuses.
 */
export interface Mailer {
  send(
    email: { to: string; subject: string; text: string; idempotencyKey: string },
    scope?: { organizationId: string; workspaceId?: string; employeeId?: string; workflowId?: string },
  ): Promise<{ messageId: string; testMode?: boolean }>;
}

/** Every tool is described by one of these. Nothing about it is provider-specific. */
export type ToolDefinition<Input = unknown, Output = unknown, Config = unknown> = {
  name: ToolName;
  /** For people: shown in the dashboard. */
  title: string;
  /** For the model: when to use the tool and what it does. */
  description: string;
  input: z.ZodType<Input>;
  output: z.ZodType<Output>;
  config: z.ZodType<Config>;
  /** What granting the tool allows, e.g. "calendar:write". */
  permissions: readonly string[];
  timeoutMs: number;
  retry: RetryPolicy;
  execute(input: Input, context: ToolContext<Config>): Promise<Output>;
};

// Each tool is typed by its own schemas; the registry holds them side by side.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDefinition<any, any, any>;

/**
 * A failure the tool expects. Its message is shown to the model, so keep it plain and free of
 * secrets. Anything else a tool throws reaches the model as "the tool failed".
 */
export class ToolError extends Error {
  /** Whether trying again might work (a timeout or 5xx, never a bad request). */
  retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.retryable = retryable;
  }
}

/** Defines a tool with its types inferred from its schemas. */
export const defineTool = <Input, Output, Config>(tool: ToolDefinition<Input, Output, Config>) => tool;
