import { toolConfigSchemas } from "@workforce/shared";
import { z } from "zod";
import { defineTool } from "../types.ts";

export const emailTool = defineTool({
  name: "send_email",
  title: "Email: send messages",
  description:
    "Send an email, for example a meeting confirmation or the details a customer asked for. Only send what the customer asked for or agreed to.",
  input: z.object({
    to: z.email(),
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(5000),
  }),
  output: z.object({ status: z.literal("sent"), messageId: z.string(), testMode: z.boolean() }),
  config: toolConfigSchemas.send_email,
  permissions: ["email:send"],
  timeoutMs: 10_000,
  retry: { attempts: 1, backoffMs: 0 },

  // Sent from the server's sender (RESEND_FROM) through Resend. Without Resend, test mode: nothing is delivered and
  // the message is kept only in the audit log (ToolExecution.input).
  // shortcut: any address may be emailed; add rules on who may be emailed when admins need them
  async execute(input, ctx) {
    if (!ctx.mailer) return { status: "sent" as const, messageId: ctx.executionId, testMode: true };
    // The execution id is the idempotency key, so a retried call cannot send twice.
    const { messageId, testMode = false } = await ctx.mailer.send(
      { to: input.to, subject: input.subject, text: input.body, idempotencyKey: ctx.executionId },
      { organizationId: ctx.organizationId, workspaceId: ctx.workspaceId, employeeId: ctx.employeeId },
    );
    return { status: "sent" as const, messageId, testMode };
  },
});
