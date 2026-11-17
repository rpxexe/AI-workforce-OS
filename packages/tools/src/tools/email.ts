import { toolConfigSchemas } from "@workforce/shared";
import { z } from "zod";
import { defineTool } from "../types.ts";

export const emailTool = defineTool({
  name: "send_email",
  title: "Email: send messages (test mode)",
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

  // shortcut: test mode, nothing is delivered; the message is kept only in the audit log (ToolExecution.input). Add a sender (and rules on who may be emailed) when an email provider is chosen
  async execute(_input, ctx) {
    return { status: "sent" as const, messageId: ctx.executionId, testMode: true };
  },
});
