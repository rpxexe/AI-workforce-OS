import { toolConfigSchemas } from "@workforce/shared";
import { z } from "zod";
import { defineTool, ToolError } from "../types.ts";

export const webhookTool = defineTool({
  name: "send_webhook",
  title: "Webhook to your systems",
  description:
    "Notify the company's own systems that something happened, for example a qualified lead or a callback request. Name the event and include the details as data.",
  input: z.object({
    event: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_.-]{0,99}$/, "Use a short lowercase name such as lead.qualified")
      .describe("Event name, e.g. lead.qualified"),
    data: z.record(z.string(), z.unknown()),
  }),
  output: z.object({ delivered: z.literal(true), status: z.number() }),
  // The admin sets the URL; the model only chooses what to send.
  config: toolConfigSchemas.send_webhook,
  permissions: ["network:webhook"],
  timeoutMs: 10_000,
  // Safe to repeat: every try carries the same Idempotency-Key.
  retry: { attempts: 3, backoffMs: 1_000 },

  // shortcut: requests are not signed; add an HMAC signature header (with a secret stored outside the grant config) when a receiver needs to verify the sender
  async execute({ event, data }, ctx) {
    let res: Response;
    try {
      res = await ctx.fetch(ctx.config.url, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": ctx.executionId },
        body: JSON.stringify({
          id: ctx.executionId,
          event,
          data,
          employeeId: ctx.employeeId,
          conversationId: ctx.conversationId,
          customerId: ctx.customerId ?? null,
          sentAt: new Date().toISOString(),
        }),
        signal: ctx.signal,
      });
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError("The webhook endpoint could not be reached", true);
    }
    await res.body?.cancel();
    if (res.status >= 500 || res.status === 429) throw new ToolError(`The webhook endpoint answered ${res.status}`, true);
    if (res.status >= 300) throw new ToolError(`The webhook endpoint refused the event (${res.status})`);
    return { delivered: true as const, status: res.status };
  },
});
