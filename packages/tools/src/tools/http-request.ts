import { toolConfigSchemas } from "@workforce/shared";
import { z } from "zod";
import { defineTool, ToolError } from "../types.ts";

const MAX_BODY = 4000;

/** Response text for the model, cut to a size it can read. */
export async function readBody(res: Response) {
  const text = await res.text().catch(() => "");
  return { body: text.slice(0, MAX_BODY), truncated: text.length > MAX_BODY };
}

export const httpRequestTool = defineTool({
  name: "http_request",
  title: "HTTP request to approved APIs",
  description:
    "Call an HTTPS API on one of the hosts the company approved, to look something up (GET) or submit data (POST). Other hosts are refused.",
  input: z.object({
    method: z.enum(["GET", "POST"]),
    url: z.url().describe("Full https:// URL on an approved host"),
    body: z.record(z.string(), z.unknown()).optional().describe("JSON body, POST only"),
  }),
  output: z.object({
    status: z.number(),
    contentType: z.string().nullable(),
    body: z.string(),
    truncated: z.boolean(),
  }),
  config: toolConfigSchemas.http_request,
  permissions: ["network:http"],
  timeoutMs: 10_000,
  // Only GET is retried (see execute): repeating a POST could act twice.
  retry: { attempts: 2, backoffMs: 500 },

  async execute({ method, url, body }, ctx) {
    const target = new URL(url);
    if (target.protocol !== "https:") throw new ToolError("Only https:// URLs are allowed");
    if (!ctx.config.allowedHosts.includes(target.hostname.toLowerCase()))
      throw new ToolError(`${target.hostname} is not an approved host. Approved: ${ctx.config.allowedHosts.join(", ")}`);
    if (method === "GET" && body) throw new ToolError("A GET request cannot have a body");

    let res: Response;
    try {
      res = await ctx.fetch(target, {
        method,
        headers: { accept: "application/json, text/plain;q=0.9, */*;q=0.1", ...(body && { "content-type": "application/json" }) },
        body: body && JSON.stringify(body),
        signal: ctx.signal,
      });
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError(`${target.hostname} could not be reached`, method === "GET");
    }
    if (res.status >= 500) throw new ToolError(`${target.hostname} answered ${res.status}`, method === "GET");
    return { status: res.status, contentType: res.headers.get("content-type"), ...(await readBody(res)) };
  },
});
