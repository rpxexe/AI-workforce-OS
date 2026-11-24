// Phase 17: API keys and outgoing webhooks, as the dashboard manages them. The public API's own contract (what
// customers' code sees) is in public-api.ts.
import { z } from "zod";

/** What an API key may do. Each public route needs exactly one. */
export const API_SCOPES = [
  "employees:read",
  "employees:write",
  "conversations:read",
  "conversations:write",
  "customers:read",
  "customers:write",
  "knowledge:read",
  "knowledge:write",
  "workflows:read",
  "workflows:write",
  "executions:read",
  "tools:read",
  "analytics:read",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const API_SCOPE_LABELS: Record<ApiScope, string> = {
  "employees:read": "Read AI employees",
  "employees:write": "Create AI employees, save and publish versions",
  "conversations:read": "Read conversations and messages",
  "conversations:write": "Send messages to AI employees, resolve conversations",
  "customers:read": "Read customers and their memory",
  "customers:write": "Set and delete what employees remember about customers",
  "knowledge:read": "Read and search knowledge",
  "knowledge:write": "Create knowledge sources and upload documents",
  "workflows:read": "Read workflows",
  "workflows:write": "Start workflow runs",
  "executions:read": "Read workflow runs",
  "tools:read": "Read the tool catalog and tool executions",
  "analytics:read": "Read analytics",
};

/** Events an endpoint can subscribe to. */
export const WEBHOOK_EVENTS = [
  "conversation.started",
  "conversation.completed",
  "message.received",
  "message.sent",
  "workflow.started",
  "workflow.completed",
  "workflow.failed",
  "human.handoff",
  "call.completed",
  "employee.published",
  "customer.updated",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_EVENT_LABELS: Record<WebhookEventType, string> = {
  "conversation.started": "A conversation started",
  "conversation.completed": "A conversation was resolved",
  "message.received": "A customer sent a message",
  "message.sent": "The employee or an agent replied",
  "workflow.started": "A workflow run started",
  "workflow.completed": "A workflow run finished",
  "workflow.failed": "A workflow run failed",
  "human.handoff": "A conversation was handed to people",
  "call.completed": "A phone call ended",
  "employee.published": "A version went live (publish, promote or rollback)",
  "customer.updated": "What employees remember about a customer changed",
};

/** Sent by "Send test event"; not subscribable. */
export const WEBHOOK_TEST_EVENT = "webhook.test";

/** How long a rotated key keeps working, so deployments can switch over. 0 = revoked at once. */
export const ROTATION_GRACE_HOURS = [0, 1, 24, 168] as const;

/** An address or range a key may be used from: 203.0.113.7, 203.0.113.0/24, 2001:db8::/32. */
const ipOrRange = z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()], { error: "Enter an IP address or a range like 203.0.113.0/24" });

const keySettings = {
  /** Requests per minute; a burst over it gets 429 with Retry-After. */
  rateLimitPerMinute: z.number().int().min(1).max(10_000).default(600),
  /** Empty: any address. */
  allowedIps: z.array(z.string().trim().pipe(ipOrRange)).max(20).default([]),
};

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1, "Give the key a name").max(100),
  workspaceId: z.string().min(1, "Choose a workspace"),
  scopes: z.array(z.enum(API_SCOPES)).min(1, "Choose at least one permission"),
  /** The key stops working after this many days; leave out for no expiry. */
  expiresInDays: z.number().int().min(1).max(365).optional(),
  ...keySettings,
});
export type CreateApiKeyInput = z.input<typeof createApiKeySchema>;

/** Name, rate limit and addresses change in place; scopes and workspace need a new key. */
export const updateApiKeySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  rateLimitPerMinute: keySettings.rateLimitPerMinute.optional(),
  allowedIps: z.array(z.string().trim().pipe(ipOrRange)).max(20).optional(),
});
export const rotateApiKeySchema = z.object({ expireOldInHours: z.number().int().min(0).max(168).default(24) });

/** The old signing secret keeps signing (next to the new one) for this long, so receivers can switch. */
export const rotateWebhookSecretSchema = z.object({ keepOldForHours: z.number().int().min(0).max(168).default(24) });

export const deliveriesQuerySchema = z.object({
  status: z.enum(["pending", "succeeded", "failed"]).optional(),
  event: z.string().max(50).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});

export const webhookEndpointSchema = z.object({
  url: z.url({ protocol: /^https$/, error: "Enter an https:// address" }).max(2000),
  description: z.string().trim().max(200).default(""),
  workspaceId: z.string().min(1, "Choose a workspace"),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1, "Choose at least one event"),
});
export type WebhookEndpointInput = z.input<typeof webhookEndpointSchema>;

/** The workspace of an endpoint never changes (its deliveries belong to it). */
export const updateWebhookEndpointSchema = webhookEndpointSchema.omit({ workspaceId: true }).partial().extend({ enabled: z.boolean().optional() });

// ---- Dashboard responses (dates are ISO strings) ----

export type ApiKeyStatus = "active" | "expiring" | "expired" | "revoked";

export type ApiKeyInfo = {
  id: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
  /** The public part of the key (`wfk_<prefix>_...`): enough to recognise it, never enough to use it. */
  prefix: string;
  scopes: ApiScope[];
  status: ApiKeyStatus;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  /** Set at creation, or by a rotation's grace period. */
  expiresAt: string | null;
  rateLimitPerMinute: number;
  allowedIps: string[];
  revokedAt: string | null;
  /** The key that replaced this one. */
  replacedById: string | null;
};

/** The only response that carries a key's secret. It is not stored and cannot be shown again. */
export type CreatedApiKey = { key: ApiKeyInfo; secret: string };

export type WebhookEndpointInfo = {
  id: string;
  url: string;
  description: string;
  workspaceId: string;
  workspaceName: string;
  events: WebhookEventType[];
  enabled: boolean;
  createdAt: string;
  /** Deliveries waiting for a retry, and those that gave up, in the last 7 days. */
  pending: number;
  failed: number;
  /** While a secret rotation's grace period runs: requests carry both signatures until then. */
  previousSecretUntil: string | null;
};

/** The only response that carries an endpoint's signing secret (`whsec_...`). */
export type CreatedWebhookEndpoint = { endpoint: WebhookEndpointInfo; secret: string };

export type WebhookAttempt = { at: string; statusCode: number | null; error: string | null; durationMs: number };

export type WebhookDeliveryRecord = {
  id: string;
  endpointId: string;
  eventId: string;
  event: WebhookEventType | typeof WEBHOOK_TEST_EVENT;
  status: "pending" | "succeeded" | "failed";
  attempts: number;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  /** Every attempt, oldest first. */
  log: WebhookAttempt[];
  /** The JSON body sent, exactly as signed. */
  payload: unknown;
};

export type WebhookDeliveryPage = { data: WebhookDeliveryRecord[]; nextCursor: string | null };

export type DeveloperAuditEntry = {
  id: string;
  /** A Clerk user id. */
  actorId: string;
  action: string;
  targetId: string;
  /** Names, scopes, addresses: never secrets. */
  detail: Record<string, unknown>;
  createdAt: string;
};
