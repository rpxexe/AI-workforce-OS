// The tools AI employees can use, and the settings an admin gives each one.
import { z } from "zod";

export const TOOL_NAMES = ["calendar_book_meeting", "send_email", "http_request", "send_webhook"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** A public domain name: no IP addresses, no "localhost", no single-label hosts. */
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** What an admin configures when granting a tool. The employee (and the model) cannot change it. */
export const toolConfigSchemas = {
  calendar_book_meeting: z.object({}),
  send_email: z.object({}),
  http_request: z.object({
    allowedHosts: z
      .array(z.string().trim().toLowerCase().regex(DOMAIN, "Enter a domain name such as api.example.com"))
      .min(1, "Add at least one host")
      .max(20),
  }),
  send_webhook: z.object({
    url: z.url({ protocol: /^https$/, hostname: DOMAIN, error: "Enter an https:// URL on a public domain" }),
  }),
} satisfies Record<ToolName, z.ZodType>;

export const setEmployeeToolsSchema = z.object({
  tools: z
    .array(z.object({ name: z.enum(TOOL_NAMES), config: z.record(z.string(), z.unknown()).default({}) }))
    .max(TOOL_NAMES.length),
});
export type SetEmployeeTools = z.infer<typeof setEmployeeToolsSchema>;

// ---- API responses (dates are ISO strings) ----

/** A tool in the catalog. */
export type ToolInfo = {
  name: ToolName;
  title: string;
  description: string;
  /** What granting it allows. A grant covers the permissions the tool had when it was granted. */
  permissions: string[];
  timeoutMs: number;
  retry: { attempts: number; backoffMs: number };
};

/** A tool granted to an employee. */
export type EmployeeTool = { name: ToolName; config: Record<string, unknown>; permissions: string[]; grantedAt: string };

export type ToolExecutionStatus = "SUCCEEDED" | "FAILED" | "DENIED" | "INVALID";

/** One audited tool call. */
export type ToolExecutionRecord = {
  id: string;
  tool: string;
  status: ToolExecutionStatus;
  employeeId: string;
  conversationId: string | null;
  input: unknown;
  output: unknown;
  error: string | null;
  attempts: number;
  durationMs: number;
  createdAt: string;
};

/** A tool call made while writing a reply, shown under it. */
export type MessageTool = { executionId: string; tool: string; status: ToolExecutionStatus };
