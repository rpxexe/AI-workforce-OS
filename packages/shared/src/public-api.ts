// Phase 17: the public API's contract. Customers' code depends on these shapes, so they are written here on purpose and
// never derived from internal types or database rows: the API maps internal data into them (apps/api/src/public), every
// response is parsed with its schema before it leaves (unknown fields are dropped), and the OpenAPI document and the
// SDK's types come from the same objects. Changing a shape here is a breaking change for customers: add fields, never
// rename or remove them within /v1.
import { z } from "zod";
import { MEMORY_CATEGORIES } from "./customer.ts";
import { API_SCOPES, WEBHOOK_EVENTS, WEBHOOK_TEST_EVENT, type ApiScope } from "./developer.ts";
import { LANGUAGES } from "./employee.ts";

const timestamp = z.iso.datetime();
const id = z.string();

// ---- Resources ----

export const publicEmployee = z.object({
  id,
  name: z.string(),
  role: z.string(),
  description: z.string(),
  status: z.enum(["draft", "active", "paused", "archived"]),
  language: z.string(),
  /** The version customers talk to; null until published. */
  publishedVersion: z.number().int().nullable(),
  latestVersion: z.number().int(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const publicMessage = z.object({
  id,
  conversationId: id,
  /** customer: the person the employee talks to; employee: the AI; agent: a person on the business's team. */
  role: z.enum(["customer", "employee", "agent"]),
  text: z.string(),
  createdAt: timestamp,
});

export const publicConversation = z.object({
  id,
  employeeId: id,
  /** test, api, web_chat, whatsapp, email, voice, workflow. */
  channel: z.string(),
  status: z.enum(["ai_active", "waiting_for_human", "human_active", "resolved", "reopened"]),
  title: z.string(),
  customerId: id.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  resolvedAt: timestamp.nullable(),
});
export const publicConversationDetail = publicConversation.extend({ messages: z.array(publicMessage) });

export const publicCustomer = z.object({
  id,
  /** What channels know the customer by: +digits phone, lower-case email, or the id your code gave. */
  externalId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  company: z.string().nullable(),
  createdAt: timestamp,
  lastSeenAt: timestamp,
});
export const publicMemory = z.object({ key: z.string(), category: z.string(), value: z.string(), confidence: z.number().nullable(), updatedAt: timestamp });
export const publicCustomerDetail = publicCustomer.extend({ memories: z.array(publicMemory) });

export const publicKnowledgeSource = z.object({ id, name: z.string(), description: z.string(), documentCount: z.number().int(), createdAt: timestamp });
export const publicKnowledgeDocument = z.object({
  id,
  name: z.string(),
  kind: z.string(),
  status: z.enum(["pending", "processing", "ready", "failed"]),
  error: z.string().nullable(),
  chunkCount: z.number().int(),
  createdAt: timestamp,
});
export const publicKnowledgeSourceDetail = publicKnowledgeSource.extend({ documents: z.array(publicKnowledgeDocument) });
export const publicKnowledgeMatch = z.object({
  content: z.string(),
  /** Cosine similarity, 0 to 1. */
  score: z.number(),
  page: z.number().int().nullable(),
  documentId: id,
  documentName: z.string(),
  sourceId: id,
  sourceName: z.string(),
});

export const publicWorkflow = z.object({
  id,
  name: z.string(),
  description: z.string(),
  status: z.enum(["draft", "active", "paused"]),
  publishedVersion: z.number().int().nullable(),
  latestVersion: z.number().int(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

const executionStatus = z.enum(["queued", "running", "waiting", "completed", "failed"]);
export const publicExecution = z.object({
  id,
  workflowId: id,
  version: z.number().int(),
  status: executionStatus,
  error: z.string().nullable(),
  /** api, webhook (the workflow's trigger URL) or dashboard. */
  startedBy: z.enum(["api", "webhook", "dashboard"]),
  createdAt: timestamp,
  finishedAt: timestamp.nullable(),
});
export const publicExecutionDetail = publicExecution.extend({
  input: z.record(z.string(), z.unknown()),
  steps: z.array(
    z.object({
      id,
      nodeId: z.string(),
      nodeType: z.string(),
      attempt: z.number().int(),
      status: z.enum(["running", "waiting", "succeeded", "failed"]),
      output: z.unknown().nullable(),
      error: z.string().nullable(),
      startedAt: timestamp,
      finishedAt: timestamp.nullable(),
    }),
  ),
});

export const publicTool = z.object({
  name: z.string(),
  title: z.string(),
  description: z.string(),
  /** JSON Schema of the arguments the employee passes. */
  inputSchema: z.record(z.string(), z.unknown()),
});
export const publicToolExecution = z.object({
  id,
  tool: z.string(),
  status: z.enum(["succeeded", "failed", "denied", "invalid"]),
  employeeId: id,
  conversationId: id.nullable(),
  customerId: id.nullable(),
  input: z.unknown(),
  output: z.unknown().nullable(),
  error: z.string().nullable(),
  attempts: z.number().int(),
  durationMs: z.number().int(),
  createdAt: timestamp,
});

const durationStats = z.object({ count: z.number().int(), averageMs: z.number().nullable(), medianMs: z.number().nullable(), p90Ms: z.number().nullable() });
export const publicAnalytics = z.object({
  from: timestamp,
  to: timestamp,
  conversations: z.object({ total: z.number().int(), byChannel: z.array(z.object({ channel: z.string(), count: z.number().int() })) }),
  messages: z.object({ customer: z.number().int(), employee: z.number().int(), agent: z.number().int() }),
  calls: z.object({ total: z.number().int(), completed: z.number().int(), minutes: z.number() }),
  toolExecutions: z.number().int(),
  workflowExecutions: z.number().int(),
  resolutions: z.number().int(),
  handoffs: z.number().int(),
  replyLatency: durationStats,
  /** What was billed for usage in the range, in USD. */
  billedUsd: z.number(),
  quality: z.object({ evaluations: z.number().int(), averageScore: z.number().nullable(), passRate: z.number().nullable() }),
  daily: z.array(z.object({ date: z.string(), conversations: z.number().int(), messages: z.number().int() })),
});

// Objects only webhooks carry.
export const publicRelease = z.object({
  employeeId: id,
  version: z.number().int(),
  previousVersion: z.number().int().nullable(),
  /** publish: a person published it; promote: a rollout's candidate went to everyone; rollback: back to an earlier version. */
  action: z.enum(["publish", "promote", "rollback"]),
  releasedAt: timestamp,
});
export const publicHandoff = z.object({ id, conversationId: id, employeeId: id, trigger: z.string(), reason: z.string(), requestedAt: timestamp });
export const publicCall = z.object({
  id,
  employeeId: id,
  conversationId: id.nullable(),
  direction: z.enum(["inbound", "outbound"]),
  status: z.enum(["completed", "busy", "no_answer", "failed", "canceled"]),
  from: z.string(),
  to: z.string(),
  durationSec: z.number().int().nullable(),
  createdAt: timestamp,
  endedAt: timestamp.nullable(),
});

export const publicError = z.object({
  error: z.object({
    /** invalid_request, authentication_failed, permission_denied, not_found, conflict, limit_reached, server_error. */
    type: z.string(),
    message: z.string(),
    issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});

/** A list answer: pass `nextCursor` back as `cursor` for the next page; null on the last one. */
const page = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item), nextCursor: z.string().nullable() });

// ---- Requests ----

const employeeFields = {
  name: z.string().trim().min(1).max(80),
  role: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500),
  personality: z.string().trim().max(2000),
  /** What the employee must do and must not do. */
  instructions: z.string().trim().max(20000),
  goals: z.array(z.string().trim().min(1).max(200)).max(20),
  language: z.enum(Object.keys(LANGUAGES) as [keyof typeof LANGUAGES, ...(keyof typeof LANGUAGES)[]]),
  /** IANA time zone (Asia/Kolkata): working hours and "tomorrow at 3 PM" are read in it. */
  timeZone: z.string().min(1).max(60),
};
/** A new employee. Settings the API does not expose (escalation, working days, avatar) start from the dashboard's defaults. */
export const createEmployeeBody = z.object({
  ...employeeFields,
  description: employeeFields.description.default(""),
  personality: employeeFields.personality.default(""),
  instructions: employeeFields.instructions.default(""),
  goals: employeeFields.goals.default([]),
  language: employeeFields.language.default("en"),
  timeZone: employeeFields.timeZone.default("UTC"),
});
/** A new version: the fields given replace the latest version's; everything else is kept. Nothing goes live until published. */
export const saveVersionBody = z.object(employeeFields).partial();

export const streamEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("done"),
    conversationId: id,
    status: z.enum(["answered", "held"]),
    handoff: z.boolean(),
    message: publicMessage,
    reply: publicMessage.nullable(),
  }),
  z.object({ type: z.literal("error"), error: z.object({ type: z.string(), message: z.string() }) }),
]);
const idParams = z.object({ id: z.string().min(1) });
const paging = { limit: z.coerce.number().int().min(1).max(100).default(20), cursor: z.string().min(1).optional() };

export const sendMessageBody = z.object({
  message: z.string().trim().min(1).max(8000),
  /** Continue a conversation; leave out to start one. */
  conversationId: z.string().min(1).optional(),
  /** Who is writing (email, phone or your own id), for a new conversation: the employee remembers them across channels. */
  customer: z.string().trim().min(1).max(200).optional(),
});
export const sendMessageResult = z.object({
  conversationId: id,
  /** answered: the employee replied; held: people have the conversation, the message was saved for them. */
  status: z.enum(["answered", "held"]),
  /** True when this reply handed the conversation to people. */
  handoff: z.boolean(),
  message: publicMessage,
  reply: publicMessage.nullable(),
});

// ---- Routes ----

type RouteSpec = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** OpenAPI style: /v1/employees/{id}. */
  path: string;
  scope: ApiScope;
  tag: string;
  summary: string;
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodObject;
  /** With `stream`: the schema of each server-sent event. */
  response: z.ZodType;
  status?: 200 | 201 | 202;
  /** Accepts an Idempotency-Key header: a retry with the same key returns the first answer instead of acting again. */
  idempotent?: boolean;
  /** Answers with server-sent events (`data: <json>`), one per `response` object. */
  stream?: boolean;
  /** Bytes; default 1 MB. */
  bodyLimit?: number;
};

export const PUBLIC_ROUTES = {
  listEmployees: {
    method: "GET", path: "/v1/employees", scope: "employees:read", tag: "Employees", summary: "List AI employees",
    query: z.object({ ...paging, status: publicEmployee.shape.status.optional() }), response: page(publicEmployee),
  },
  getEmployee: { method: "GET", path: "/v1/employees/{id}", scope: "employees:read", tag: "Employees", summary: "Get an AI employee", params: idParams, response: publicEmployee },
  createEmployee: {
    method: "POST", path: "/v1/employees", scope: "employees:write", tag: "Employees", summary: "Create an AI employee (version 1, not published)",
    body: createEmployeeBody, response: publicEmployee, status: 201, idempotent: true,
  },
  saveEmployeeVersion: {
    method: "POST", path: "/v1/employees/{id}/versions", scope: "employees:write", tag: "Employees",
    summary: "Save a new version from the latest one with the given fields changed (customers keep the published version)",
    params: idParams, body: saveVersionBody, response: publicEmployee, status: 201, idempotent: true,
  },
  publishEmployee: {
    method: "POST", path: "/v1/employees/{id}/publish", scope: "employees:write", tag: "Employees",
    summary: "Make a version live (default: the latest); 409 while a rollout runs",
    params: idParams, body: z.object({ version: z.number().int().positive().optional() }), response: publicEmployee,
  },
  sendMessage: {
    method: "POST", path: "/v1/employees/{id}/messages", scope: "conversations:write", tag: "Conversations",
    summary: "Send a message to an AI employee and get its reply (its published version answers)",
    params: idParams, body: sendMessageBody, response: sendMessageResult, idempotent: true,
  },
  streamMessage: {
    method: "POST", path: "/v1/employees/{id}/messages/stream", scope: "conversations:write", tag: "Conversations",
    summary: "Send a message and receive the reply as server-sent events: text pieces, then done (or error)",
    params: idParams, body: sendMessageBody, response: streamEvent, stream: true,
  },
  listConversations: {
    method: "GET", path: "/v1/conversations", scope: "conversations:read", tag: "Conversations", summary: "List conversations, newest first",
    query: z.object({
      ...paging,
      employeeId: z.string().optional(),
      customerId: z.string().optional(),
      channel: z.string().optional(),
      status: publicConversation.shape.status.optional(),
    }),
    response: page(publicConversation),
  },
  getConversation: {
    method: "GET", path: "/v1/conversations/{id}", scope: "conversations:read", tag: "Conversations", summary: "Get a conversation with its messages",
    params: idParams, response: publicConversationDetail,
  },
  resolveConversation: {
    method: "POST", path: "/v1/conversations/{id}/resolve", scope: "conversations:write", tag: "Conversations",
    summary: "Mark a conversation resolved (ends a handoff); writing to it again reopens it", params: idParams, response: publicConversation,
  },
  listCustomers: {
    method: "GET", path: "/v1/customers", scope: "customers:read", tag: "Customers", summary: "List customers, most recently seen first",
    query: z.object({ ...paging, externalId: z.string().optional() }), response: page(publicCustomer),
  },
  getCustomer: { method: "GET", path: "/v1/customers/{id}", scope: "customers:read", tag: "Customers", summary: "Get a customer with what the employees remember", params: idParams, response: publicCustomerDetail },
  setCustomerMemory: {
    method: "PUT", path: "/v1/customers/{id}/memories/{key}", scope: "customers:write", tag: "Customers",
    summary: "Set one remembered fact (snake_case key); identity keys name, email, phone, company update the profile. Card numbers and secrets are refused",
    params: z.object({ id: z.string().min(1), key: z.string().min(1).max(50) }),
    body: z.object({ value: z.string().trim().min(1).max(500), category: z.enum(MEMORY_CATEGORIES).optional() }),
    response: publicMemory,
  },
  deleteCustomerMemory: {
    method: "DELETE", path: "/v1/customers/{id}/memories/{key}", scope: "customers:write", tag: "Customers", summary: "Forget one fact",
    params: z.object({ id: z.string().min(1), key: z.string().min(1).max(50) }), response: z.object({ deleted: z.literal(true) }),
  },
  listKnowledgeSources: {
    method: "GET", path: "/v1/knowledge/sources", scope: "knowledge:read", tag: "Knowledge", summary: "List knowledge sources",
    query: z.object(paging), response: page(publicKnowledgeSource),
  },
  createKnowledgeSource: {
    method: "POST", path: "/v1/knowledge/sources", scope: "knowledge:write", tag: "Knowledge", summary: "Create a knowledge source (name unique in the workspace)",
    body: z.object({ name: z.string().trim().min(1).max(100), description: z.string().trim().max(500).default("") }),
    response: publicKnowledgeSource, status: 201, idempotent: true,
  },
  uploadDocument: {
    method: "POST", path: "/v1/knowledge/sources/{id}/documents", scope: "knowledge:write", tag: "Knowledge",
    summary: "Upload a PDF, DOCX, TXT or CSV file (base64, up to 10 MB); it is processed in the background (status pending -> ready)",
    params: idParams, body: z.object({ name: z.string().trim().min(1).max(200), contentBase64: z.string().min(1) }),
    response: publicKnowledgeDocument, status: 201, idempotent: true, bodyLimit: 15 * 1024 * 1024,
  },
  getKnowledgeSource: {
    method: "GET", path: "/v1/knowledge/sources/{id}", scope: "knowledge:read", tag: "Knowledge", summary: "Get a knowledge source with its documents",
    params: idParams, response: publicKnowledgeSourceDetail,
  },
  searchKnowledge: {
    method: "POST", path: "/v1/knowledge/search", scope: "knowledge:read", tag: "Knowledge", summary: "Search knowledge by meaning",
    body: z.object({ query: z.string().trim().min(1).max(1000), sourceIds: z.array(z.string()).optional(), limit: z.number().int().min(1).max(20).default(8) }),
    response: z.object({ data: z.array(publicKnowledgeMatch) }),
  },
  listWorkflows: {
    method: "GET", path: "/v1/workflows", scope: "workflows:read", tag: "Workflows", summary: "List workflows",
    query: z.object(paging), response: page(publicWorkflow),
  },
  getWorkflow: { method: "GET", path: "/v1/workflows/{id}", scope: "workflows:read", tag: "Workflows", summary: "Get a workflow", params: idParams, response: publicWorkflow },
  startExecution: {
    method: "POST", path: "/v1/workflows/{id}/executions", scope: "workflows:write", tag: "Workflows",
    summary: "Start a run of the workflow's published version; `input` is what {{trigger.*}} reads",
    params: idParams, body: z.object({ input: z.record(z.string(), z.unknown()).default({}) }), response: publicExecution, status: 202, idempotent: true,
  },
  listExecutions: {
    method: "GET", path: "/v1/executions", scope: "executions:read", tag: "Executions", summary: "List workflow runs, newest first",
    query: z.object({ ...paging, workflowId: z.string().optional(), status: executionStatus.optional() }), response: page(publicExecution),
  },
  getExecution: { method: "GET", path: "/v1/executions/{id}", scope: "executions:read", tag: "Executions", summary: "Get a workflow run with its steps", params: idParams, response: publicExecutionDetail },
  listTools: { method: "GET", path: "/v1/tools", scope: "tools:read", tag: "Tools", summary: "List the tools employees can be given", response: z.object({ data: z.array(publicTool) }) },
  listToolExecutions: {
    method: "GET", path: "/v1/tools/executions", scope: "tools:read", tag: "Tools", summary: "List tool calls employees made, newest first",
    query: z.object({ ...paging, employeeId: z.string().optional(), conversationId: z.string().optional() }), response: page(publicToolExecution),
  },
  getAnalytics: {
    method: "GET", path: "/v1/analytics", scope: "analytics:read", tag: "Analytics", summary: "Totals and a daily series for a date range (to is exclusive, at most 366 days)",
    query: z.object({ from: z.iso.date(), to: z.iso.date() }), response: publicAnalytics,
  },
} as const satisfies Record<string, RouteSpec>;

export type PublicRoutes = typeof PUBLIC_ROUTES;
export type OperationId = keyof PublicRoutes;
type Part<K extends OperationId, P extends "params" | "query" | "body", Mode extends "in" | "out"> = PublicRoutes[K] extends { [Q in P]: infer S extends z.ZodType }
  ? Mode extends "in" ? z.input<S> : z.output<S>
  : undefined;
/** What a handler receives, validated. */
export type OperationInput<K extends OperationId> = { params: Part<K, "params", "out">; query: Part<K, "query", "out">; body: Part<K, "body", "out"> };
/** What a caller sends (defaults may be left out). */
export type OperationRequest<K extends OperationId> = { params: Part<K, "params", "in">; query: Part<K, "query", "in">; body: Part<K, "body", "in"> };
export type OperationResult<K extends OperationId> = z.output<PublicRoutes[K]["response"]>;

export type PublicEmployee = z.output<typeof publicEmployee>;
export type PublicMessage = z.output<typeof publicMessage>;
export type PublicConversation = z.output<typeof publicConversation>;
export type PublicConversationDetail = z.output<typeof publicConversationDetail>;
export type PublicCustomer = z.output<typeof publicCustomer>;
export type PublicCustomerDetail = z.output<typeof publicCustomerDetail>;
export type PublicKnowledgeSource = z.output<typeof publicKnowledgeSource>;
export type PublicKnowledgeSourceDetail = z.output<typeof publicKnowledgeSourceDetail>;
export type PublicKnowledgeMatch = z.output<typeof publicKnowledgeMatch>;
export type PublicWorkflow = z.output<typeof publicWorkflow>;
export type PublicExecution = z.output<typeof publicExecution>;
export type PublicExecutionDetail = z.output<typeof publicExecutionDetail>;
export type PublicTool = z.output<typeof publicTool>;
export type PublicToolExecution = z.output<typeof publicToolExecution>;
export type PublicAnalytics = z.output<typeof publicAnalytics>;
export type PublicHandoff = z.output<typeof publicHandoff>;
export type PublicCall = z.output<typeof publicCall>;
export type PublicErrorBody = z.output<typeof publicError>;
export type SendMessageResult = z.output<typeof sendMessageResult>;
export type PublicMemory = z.output<typeof publicMemory>;
export type PublicRelease = z.output<typeof publicRelease>;
export type StreamEvent = z.output<typeof streamEvent>;

// ---- Webhooks ----

/** The `data` of each event. */
export const WEBHOOK_EVENT_DATA = {
  "conversation.started": publicConversation,
  "conversation.completed": publicConversation,
  "message.received": publicMessage,
  "message.sent": publicMessage,
  "workflow.started": publicExecution,
  "workflow.completed": publicExecution,
  "workflow.failed": publicExecution,
  "human.handoff": publicHandoff,
  "call.completed": publicCall,
  "employee.published": publicRelease,
  "customer.updated": publicCustomer,
  [WEBHOOK_TEST_EVENT]: z.object({ endpointId: id, message: z.string() }),
} as const satisfies Record<(typeof WEBHOOK_EVENTS)[number] | typeof WEBHOOK_TEST_EVENT, z.ZodType>;
type EventData = typeof WEBHOOK_EVENT_DATA;

/** The JSON body of every webhook request. `id` is also the `webhook-id` header: the same on every retry. */
export type WebhookEvent = {
  [T in keyof EventData]: { id: string; type: T; createdAt: string; workspaceId: string; data: z.output<EventData[T]> };
}[keyof EventData];

const webhookEnvelope = (type: string, data: z.ZodType) =>
  z.object({ id: z.string(), type: z.literal(type), createdAt: timestamp, workspaceId: z.string(), data });

// ---- OpenAPI ----

const jsonSchema = (schema: z.ZodType, io: "input" | "output" = "output") => {
  const out = z.toJSONSchema(schema, { io, unrepresentable: "any" }) as Record<string, unknown>;
  delete out.$schema;
  return out;
};

/** The OpenAPI 3.1 document of the public API, built from the route table above. */
export function openApiDocument(serverUrl?: string) {
  const errorRef = { $ref: "#/components/schemas/Error" };
  const errors = Object.fromEntries(
    (
      [
        [400, "The request is invalid (see issues)"],
        [401, "The API key is missing, wrong, expired or revoked"],
        [403, "The key lacks the scope this route needs"],
        [404, "Not found in the key's workspace"],
        [409, "Conflicts with the current state (see message)"],
        [429, "Over the key's requests per minute (see Retry-After)"],
      ] as const
    ).map(([code, description]) => [code, { description, content: { "application/json": { schema: errorRef } } }]),
  );
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [operationId, spec] of Object.entries(PUBLIC_ROUTES) as [string, RouteSpec][]) {
    const parameters = [
      ...Object.entries(spec.params?.shape ?? {}).map(([name, s]) => ({ name, in: "path", required: true, schema: jsonSchema(s as z.ZodType, "input") })),
      ...Object.entries(spec.query?.shape ?? {}).map(([name, s]) => ({
        name,
        in: "query",
        required: !(s as z.ZodType).safeParse(undefined).success,
        schema: jsonSchema(s as z.ZodType, "input"),
      })),
      ...(spec.idempotent ? [{ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", maxLength: 200 } }] : []),
    ];
    (paths[spec.path] ??= {})[spec.method.toLowerCase()] = {
      operationId,
      tags: [spec.tag],
      summary: spec.summary,
      "x-scope": spec.scope,
      security: [{ apiKey: [] }],
      ...(parameters.length > 0 && { parameters }),
      ...(spec.body && { requestBody: { required: true, content: { "application/json": { schema: jsonSchema(spec.body, "input") } } } }),
      responses: {
        [spec.status ?? 200]: {
          description: spec.stream ? "Server-sent events, each `data:` line one of these objects" : "OK",
          content: { [spec.stream ? "text/event-stream" : "application/json"]: { schema: jsonSchema(spec.response) } },
        },
        ...errors,
      },
    };
  }
  const webhooks = Object.fromEntries(
    Object.entries(WEBHOOK_EVENT_DATA).map(([type, data]) => [
      type,
      {
        post: {
          summary: `${type} (signed: webhook-id, webhook-timestamp, webhook-signature)`,
          requestBody: { content: { "application/json": { schema: jsonSchema(webhookEnvelope(type, data)) } } },
          responses: { 200: { description: "Any 2xx acknowledges the event; anything else is retried" } },
        },
      },
    ]),
  );
  return {
    openapi: "3.1.0",
    info: {
      title: "AI Workforce API",
      version: "1",
      description:
        "Authenticate with `Authorization: Bearer <API key>`. A key belongs to one workspace and carries scopes. Lists page with `limit` and `cursor`. " +
        "Webhooks follow the Standard Webhooks signature scheme: HMAC-SHA256 of `<webhook-id>.<webhook-timestamp>.<body>` with the endpoint's secret.",
    },
    ...(serverUrl && { servers: [{ url: serverUrl }] }),
    paths,
    webhooks,
    components: {
      securitySchemes: { apiKey: { type: "http", scheme: "bearer", description: `An API key; scopes: ${API_SCOPES.join(", ")}` } },
      schemas: { Error: jsonSchema(publicError) },
    },
  };
}
