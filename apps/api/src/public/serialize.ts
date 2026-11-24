// Phase 17: internal rows -> the public contract (packages/shared/src/public-api.ts). This file is the only place that
// knows both sides: internal refactors change these functions, never what customers receive.
import type { Prisma } from "@workforce/database";
import type {
  PublicCall,
  PublicConversation,
  PublicCustomer,
  PublicEmployee,
  PublicExecution,
  PublicHandoff,
  PublicMessage,
  PublicToolExecution,
  PublicWorkflow,
} from "@workforce/shared";

const lower = <T extends string>(value: string) => value.toLowerCase() as T;
const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => d?.toISOString() ?? null;

export const employeeInclude = {
  versions: { orderBy: { number: "desc" }, take: 1 },
  publishedVersion: { select: { number: true } },
} satisfies Prisma.AiEmployeeInclude;

export const toEmployee = (e: Prisma.AiEmployeeGetPayload<{ include: typeof employeeInclude }>): PublicEmployee => {
  const latest = e.versions[0];
  return {
    id: e.id,
    name: latest?.name ?? "",
    role: latest?.role ?? "",
    description: latest?.description ?? "",
    status: lower(e.status),
    language: latest?.language ?? "",
    publishedVersion: e.publishedVersion?.number ?? null,
    latestVersion: latest?.number ?? 0,
    createdAt: iso(e.createdAt),
    updatedAt: iso(e.updatedAt),
  };
};

const ROLES = { USER: "customer", ASSISTANT: "employee", AGENT: "agent" } as const;
export const toMessage = (m: { id: string; conversationId: string; role: keyof typeof ROLES; content: string; createdAt: Date | string }): PublicMessage => ({
  id: m.id,
  conversationId: m.conversationId,
  role: ROLES[m.role],
  text: m.content,
  createdAt: typeof m.createdAt === "string" ? m.createdAt : iso(m.createdAt),
});

export const conversationInclude = { customer: { select: { customerId: true } } } satisfies Prisma.ConversationInclude;

export const toConversation = (c: Prisma.ConversationGetPayload<{ include: typeof conversationInclude }>): PublicConversation => ({
  id: c.id,
  employeeId: c.employeeId,
  channel: c.channel,
  status: lower(c.status),
  title: c.title,
  customerId: c.customer?.customerId ?? null,
  createdAt: iso(c.createdAt),
  updatedAt: iso(c.updatedAt),
  resolvedAt: isoOrNull(c.resolvedAt),
});

export const toCustomer = (c: Prisma.CustomerGetPayload<{ include: { profile: true } }>): PublicCustomer => ({
  id: c.id,
  externalId: c.externalId,
  name: c.profile?.name ?? null,
  email: c.profile?.email ?? null,
  phone: c.profile?.phone ?? null,
  company: c.profile?.company ?? null,
  createdAt: iso(c.createdAt),
  lastSeenAt: iso(c.lastSeenAt),
});

export const workflowInclude = {
  versions: { orderBy: { number: "desc" }, take: 1, select: { number: true } },
  publishedVersion: { select: { number: true } },
} satisfies Prisma.WorkflowInclude;

export const toWorkflow = (w: Prisma.WorkflowGetPayload<{ include: typeof workflowInclude }>): PublicWorkflow => ({
  id: w.id,
  name: w.name,
  description: w.description,
  status: lower(w.status),
  publishedVersion: w.publishedVersion?.number ?? null,
  latestVersion: w.versions[0]?.number ?? 0,
  createdAt: iso(w.createdAt),
  updatedAt: iso(w.updatedAt),
});

/** Runs started through the public API record "api:<key id>" (the dashboard: a Clerk user id). */
export const startedByOf = (startedBy: string): PublicExecution["startedBy"] =>
  startedBy === "webhook" ? "webhook" : startedBy.startsWith("api:") ? "api" : "dashboard";

export const executionInclude = { version: { select: { number: true } } } satisfies Prisma.WorkflowExecutionInclude;

export const toExecution = (e: Prisma.WorkflowExecutionGetPayload<{ include: typeof executionInclude }>): PublicExecution => ({
  id: e.id,
  workflowId: e.workflowId,
  version: e.version.number,
  status: lower(e.status),
  error: e.error,
  startedBy: startedByOf(e.startedBy),
  createdAt: iso(e.createdAt),
  finishedAt: isoOrNull(e.finishedAt),
});

export const toToolExecution = (t: Prisma.ToolExecutionGetPayload<object>): PublicToolExecution => ({
  id: t.id,
  tool: t.tool,
  status: lower(t.status),
  employeeId: t.employeeId,
  conversationId: t.conversationId,
  customerId: t.customerId,
  input: t.input,
  output: t.output,
  error: t.error,
  attempts: t.attempts,
  durationMs: t.durationMs,
  createdAt: iso(t.createdAt),
});

export const toHandoff = (h: Prisma.HandoffGetPayload<object>): PublicHandoff => ({
  id: h.id,
  conversationId: h.conversationId,
  employeeId: h.employeeId,
  trigger: h.trigger,
  reason: h.reason,
  requestedAt: iso(h.requestedAt),
});

export const toCall = (c: Prisma.CallGetPayload<object>): PublicCall => ({
  id: c.id,
  employeeId: c.employeeId,
  conversationId: c.conversationId,
  direction: lower(c.direction),
  status: lower(c.status),
  from: c.from,
  to: c.to,
  durationSec: c.durationSec,
  createdAt: iso(c.createdAt),
  endedAt: isoOrNull(c.endedAt),
});
