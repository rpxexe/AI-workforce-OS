// The AI employee tool system. The model never touches the server or the network directly: it
// can only name a registered tool, and `ToolExecutor` checks permission, validates the input,
// runs the tool with a timeout and retry policy, and writes an audit row.
import { createToolRegistry } from "./registry.ts";
import { calendarTool } from "./tools/calendar.ts";
import { emailTool } from "./tools/email.ts";
import { httpRequestTool } from "./tools/http-request.ts";
import { webhookTool } from "./tools/webhook.ts";

export { createToolExecutor, type ToolExecutor, type ToolOutcome, type ToolScope } from "./executor.ts";
export { isPrivateAddress, safeFetch } from "./net.ts";
export { createToolRegistry, type ToolRegistry } from "./registry.ts";
export { localTime, zonedTime } from "./tools/calendar.ts";
export { defineTool, ToolError, type AnyTool, type Mailer, type RetryPolicy, type ToolContext, type ToolDefinition } from "./types.ts";

/** Every tool the platform offers. */
export const toolRegistry = createToolRegistry([calendarTool, emailTool, httpRequestTool, webhookTool]);
